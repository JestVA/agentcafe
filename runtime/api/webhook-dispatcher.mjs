import { createHmac } from "node:crypto";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookDispatcher {
  constructor({ eventStore, subscriptionStore, maxConcurrency = 4 } = {}) {
    this.eventStore = eventStore;
    this.subscriptionStore = subscriptionStore;
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 4);
    this.unsubscribe = null;
    this.queue = [];
    this.inFlight = 0;
    this.stats = {
      processed: 0,
      delivered: 0,
      failed: 0,
      retried: 0,
      dlq: 0,
      inFlight: 0,
      queued: 0
    };
  }

  start() {
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = this.eventStore.subscribe({
      onEvent: (event) => {
        this.enqueue(event);
      }
    });
  }

  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  enqueue(event) {
    this.queue.push(event);
    this.stats.queued = this.queue.length;
    this.pump();
  }

  pump() {
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      const event = this.queue.shift();
      this.stats.queued = this.queue.length;
      this.inFlight += 1;
      this.stats.inFlight = this.inFlight;
      this.dispatchEvent(event)
        .catch(() => {
          // keep worker alive
        })
        .finally(() => {
          this.inFlight -= 1;
          this.stats.inFlight = this.inFlight;
          this.pump();
        });
    }
  }

  getStats() {
    return { ...this.stats };
  }

  sign(secret, payload) {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  async dispatchToSubscription(subscription, event, { source = "live", dlqId = null } = {}) {
    const body = JSON.stringify({ event });
    const signature = this.sign(subscription.secret, body);

    const attempts = Math.max(0, Number(subscription.maxRetries || 3)) + 1;
    const backoffMs = Math.max(100, Number(subscription.backoffMs || 1000));
    const timeoutMs = Math.max(500, Number(subscription.timeoutMs || 5000));

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
      try {
        const res = await fetch(subscription.targetUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentcafe-signature": signature,
            "x-agentcafe-event-id": event.eventId,
            "x-agentcafe-event-type": event.type,
            "x-agentcafe-subscription-id": subscription.id,
            "x-agentcafe-delivery-source": source
          },
          body,
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        this.stats.delivered += 1;
        await this.subscriptionStore.recordDelivery(subscription.id, { success: true });
        await this.subscriptionStore.addDeliveryAttempt({
          subscriptionId: subscription.id,
          eventId: event.eventId,
          eventType: event.type,
          tenantId: event.tenantId,
          roomId: event.roomId,
          actorId: event.actorId,
          success: true,
          attempt,
          source,
          dlqId,
          durationMs: Date.now() - attemptStartedAt,
          statusCode: res.status,
          error: null
        });
        return { ok: true };
      } catch (error) {
        clearTimeout(timer);
        lastError = error instanceof Error ? error.message : String(error);
        await this.subscriptionStore.addDeliveryAttempt({
          subscriptionId: subscription.id,
          eventId: event.eventId,
          eventType: event.type,
          tenantId: event.tenantId,
          roomId: event.roomId,
          actorId: event.actorId,
          success: false,
          attempt,
          source,
          dlqId,
          durationMs: Date.now() - attemptStartedAt,
          error: lastError
        });
        if (attempt < attempts) {
          this.stats.retried += 1;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    this.stats.failed += 1;
    this.stats.dlq += 1;
    await this.subscriptionStore.recordDelivery(subscription.id, {
      success: false,
      error: lastError || "delivery failed"
    });
    const dlq = await this.subscriptionStore.pushDlq({
      subscriptionId: subscription.id,
      eventId: event.eventId,
      eventType: event.type,
      tenantId: event.tenantId,
      roomId: event.roomId,
      actorId: event.actorId,
      payload: event,
      error: lastError || "delivery failed"
    });
    return { ok: false, error: lastError, dlq };
  }

  async dispatchEvent(event) {
    this.stats.processed += 1;
    const subscriptions = await this.subscriptionStore.list({
      tenantId: event.tenantId,
      roomId: event.roomId,
      eventType: event.type,
      enabled: true
    });

    for (const subscription of subscriptions) {
      if (subscription.actorId && subscription.actorId !== event.actorId) {
        continue;
      }
      await this.dispatchToSubscription(subscription, event, { source: "live" });
    }
  }

  async replayDlqEntry(dlqId) {
    const dlqEntry = await this.subscriptionStore.getDlqById(dlqId);
    if (!dlqEntry) {
      return { ok: false, code: "ERR_NOT_FOUND", message: "DLQ entry not found" };
    }

    const subscription = await this.subscriptionStore.getById(dlqEntry.subscriptionId);
    if (!subscription) {
      await this.subscriptionStore.markDlqReplayed(dlqId, {
        success: false,
        error: "subscription not found"
      });
      return { ok: false, code: "ERR_NOT_FOUND", message: "Subscription missing for DLQ entry" };
    }

    const event = (await this.eventStore.getById(dlqEntry.eventId)) || dlqEntry.payload || null;
    if (!event) {
      await this.subscriptionStore.markDlqReplayed(dlqId, {
        success: false,
        error: "event not found"
      });
      return { ok: false, code: "ERR_NOT_FOUND", message: "Event missing for DLQ entry" };
    }

    const result = await this.dispatchToSubscription(subscription, event, {
      source: "dlq_replay",
      dlqId
    });

    await this.subscriptionStore.markDlqReplayed(dlqId, {
      success: Boolean(result.ok),
      error: result.error || null
    });

    return {
      ok: Boolean(result.ok),
      dlqId,
      eventId: event.eventId,
      subscriptionId: subscription.id,
      error: result.error || null
    };
  }
}

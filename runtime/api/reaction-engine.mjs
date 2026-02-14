import { randomUUID } from "node:crypto";
import { createEvent, EVENT_TYPES } from "../shared/events.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACTIONS = new Set(["say", "move", "order"]);

function capabilityForAction(actionType) {
  if (actionType === "say") {
    return "canSpeak";
  }
  if (actionType === "move") {
    return "canMove";
  }
  if (actionType === "order") {
    return "canOrder";
  }
  return null;
}

function eventTypeForAction(actionType) {
  if (actionType === "say") {
    return EVENT_TYPES.CONVERSATION_MESSAGE;
  }
  if (actionType === "move") {
    return EVENT_TYPES.MOVE;
  }
  if (actionType === "order") {
    return EVENT_TYPES.ORDER;
  }
  return null;
}

export class ReactionEngine {
  constructor({
    eventStore,
    reactionStore,
    permissionStore,
    moderationPolicy = null,
    maxConcurrency = 4
  } = {}) {
    this.eventStore = eventStore;
    this.reactionStore = reactionStore;
    this.permissionStore = permissionStore;
    this.moderationPolicy = moderationPolicy;
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 4);
    this.unsubscribe = null;
    this.queue = [];
    this.inFlight = 0;
    this.stats = {
      processed: 0,
      triggered: 0,
      skipped: 0,
      failed: 0,
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

  getStats() {
    return { ...this.stats };
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

  shouldSkip(subscription, event) {
    if (!ACTIONS.has(subscription.actionType)) {
      return true;
    }
    if (subscription.sourceActorId && subscription.sourceActorId !== event.actorId) {
      return true;
    }
    if (subscription.ignoreSelf && subscription.targetActorId === event.actorId) {
      return true;
    }
    if (subscription.ignoreReactionEvents && event.payload?.reaction?.sourceSubscriptionId) {
      return true;
    }
    if (subscription.triggerEventTypes?.length) {
      const allow = subscription.triggerEventTypes;
      if (!allow.includes("*") && !allow.includes(event.type)) {
        return true;
      }
    }
    const cooldownMs = Math.max(0, Number(subscription.cooldownMs || 0));
    if (cooldownMs > 0 && subscription.lastTriggeredAt) {
      const elapsed = Date.now() - Date.parse(subscription.lastTriggeredAt);
      if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
        return true;
      }
    }
    return false;
  }

  buildReactionPayload(subscription, event) {
    const action = subscription.actionType;
    const meta = {
      sourceSubscriptionId: subscription.id,
      sourceEventId: event.eventId
    };
    const actionPayload = subscription.actionPayload || {};

    if (action === "say") {
      const text = String(actionPayload.text || "").trim();
      const messageId = randomUUID();
      const replyToMessageId = event.payload?.conversation?.messageId || null;
      const threadId = event.payload?.conversation?.threadId || replyToMessageId || messageId;
      return {
        conversation: {
          messageId,
          threadId,
          parentMessageId: replyToMessageId,
          replyToMessageId,
          mentions: Array.isArray(actionPayload.mentions)
            ? actionPayload.mentions.map((item) => String(item).trim()).filter(Boolean)
            : [],
          contextWindow: {
            id: null,
            maxItems: 20
          },
          text,
          metadata: {
            reaction: meta
          }
        },
        bubble: {
          text,
          ttlMs: Math.max(2000, Math.min(30000, Number(actionPayload.ttlMs || 7000)))
        },
        reaction: meta
      };
    }

    if (action === "move") {
      return {
        direction: String(actionPayload.direction || "N").toUpperCase(),
        steps: Math.max(1, Number(actionPayload.steps || 1)),
        intent: "reaction",
        reaction: meta
      };
    }

    if (action === "order") {
      return {
        itemId: String(actionPayload.itemId || "").trim(),
        size: String(actionPayload.size || "regular").trim() || "regular",
        reaction: meta
      };
    }

    return {};
  }

  async executeSubscription(subscription, event) {
    if (this.shouldSkip(subscription, event)) {
      this.stats.skipped += 1;
      return;
    }

    const eventType = eventTypeForAction(subscription.actionType);
    const payload = this.buildReactionPayload(subscription, event);
    const moderationDecision = this.moderationPolicy
      ? this.moderationPolicy.evaluateAndRecord({
          tenantId: event.tenantId,
          roomId: event.roomId,
          actorId: subscription.targetActorId,
          action: `reaction:${subscription.actionType}`,
          text: payload?.conversation?.text || null,
          source: "reaction"
        })
      : { allowed: true, reasonCode: null };
    if (!moderationDecision.allowed) {
      this.stats.skipped += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: false,
        sourceEventId: event.eventId,
        error: `moderated:${moderationDecision.reasonCode}`
      });
      return;
    }

    const capability = capabilityForAction(subscription.actionType);
    const permission = await this.permissionStore.get({
      tenantId: event.tenantId,
      roomId: event.roomId,
      actorId: subscription.targetActorId
    });
    if (capability && !permission[capability]) {
      this.stats.skipped += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: false,
        sourceEventId: event.eventId,
        error: `forbidden:${capability}`
      });
      return;
    }

    if (eventType === EVENT_TYPES.CONVERSATION_MESSAGE && !payload?.conversation?.text) {
      this.stats.failed += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: false,
        sourceEventId: event.eventId,
        error: "missing reaction text"
      });
      return;
    }
    if (eventType === EVENT_TYPES.ORDER && !payload?.itemId) {
      this.stats.failed += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: false,
        sourceEventId: event.eventId,
        error: "missing itemId"
      });
      return;
    }

    try {
      await this.eventStore.append(
        createEvent({
          tenantId: event.tenantId,
          roomId: event.roomId,
          actorId: subscription.targetActorId,
          type: eventType,
          payload,
          correlationId: event.correlationId,
          causationId: event.eventId
        })
      );
      this.stats.triggered += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: true,
        sourceEventId: event.eventId
      });
    } catch (error) {
      this.stats.failed += 1;
      await this.reactionStore.recordTrigger(subscription.id, {
        success: false,
        sourceEventId: event.eventId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleep(10);
    }
  }

  async dispatchEvent(event) {
    this.stats.processed += 1;
    const subscriptions = await this.reactionStore.list({
      tenantId: event.tenantId,
      roomId: event.roomId,
      eventType: event.type,
      enabled: true
    });
    for (const subscription of subscriptions) {
      await this.executeSubscription(subscription, event);
    }
  }
}

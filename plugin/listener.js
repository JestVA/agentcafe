import { EventEmitter } from "node:events";
import { AgentCafeClient } from "./http-client.js";

const DEFAULT_TYPES = [
  "mention_created",
  "task_assigned",
  "conversation_message_posted"
];

export class CafeListener extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client =
      options.client ||
      new AgentCafeClient({
        runtimeUrl: options.runtimeUrl,
        runtimeApiKey: options.runtimeApiKey
      });
    this.actorId = options.actorId || process.env.AGENTCAFE_ACTOR_ID || "agent";
    this.tenantId = options.tenantId || process.env.AGENTCAFE_TENANT_ID || "default";
    this.roomId = options.roomId || process.env.AGENTCAFE_ROOM_ID || "main";
    this.types = options.types || DEFAULT_TYPES;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 25000;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.rebootstrapAfter = options.rebootstrapAfter ?? 3;
    this.autoAck = options.autoAck ?? true;

    this._running = false;
    this._abortController = null;
    this._cursor = 0;
    this._resolvedRoomId = this.roomId;
  }

  async start() {
    this._running = true;
    this._abortController = new AbortController();

    await this._bootstrap();

    // fire-and-forget poll loop
    this._pollLoop().catch((err) => {
      if (this._running) {
        this.emit("error", err);
      }
    });
  }

  async stop() {
    this._running = false;
    if (this._abortController) {
      this._abortController.abort();
    }
    try {
      await this.client.leaveCafe({
        actorId: this.actorId,
        tenantId: this.tenantId,
        roomId: this._resolvedRoomId
      });
    } catch {
      // best-effort leave
    }
    this.emit("close");
  }

  async _bootstrap() {
    let attempts = 0;
    while (this._running) {
      let status = 0;
      let headers = null;
      let data = null;
      try {
        ({ status, headers, data } = await this.client.rawFetch("/v1/bootstrap", {
          query: {
            actorId: this.actorId,
            tenantId: this.tenantId,
            roomId: this.roomId
          },
          signal: this._abortController?.signal
        }));
      } catch (err) {
        if (!this._running || err?.name === "AbortError") {
          return;
        }
        attempts++;
        this.emit("error", err);
        await this._backoff(attempts);
        continue;
      }

      if (status === 200) {
        this._resolvedRoomId =
          data?.data?.discovery?.resolvedRoomId || this.roomId;

        // enter the room
        try {
          await this.client.enterCafe({
            actorId: this.actorId,
            tenantId: this.tenantId,
            roomId: this._resolvedRoomId
          });
        } catch {
          // non-fatal — may already be entered
        }

        // drain unread inbox
        const inbox = data?.data?.actor?.inbox;
        if (Array.isArray(inbox) && inbox.length > 0) {
          for (const item of inbox) {
            this.emit("event", item);
          }
          this.emit("events", inbox);
        }

        this._cursor = 0;
        this.emit("bootstrap", data);
        return;
      }

      attempts++;

      if (status === 429) {
        const resetHeader = headers?.get?.("x-ratelimit-reset");
        if (resetHeader) {
          const resetEpoch = Number(resetHeader);
          const waitMs = Math.max(0, resetEpoch * 1000 - Date.now());
          if (waitMs > 0) {
            await this._sleep(Math.min(waitMs, this.maxBackoffMs));
            continue;
          }
        }
      }

      await this._backoff(attempts);
    }
  }

  async _pollLoop() {
    let failures = 0;
    let consecutive502 = 0;

    while (this._running) {
      let response = null;
      try {
        response = await this.client.rawFetch("/v1/events/poll", {
          query: {
            actorId: this.actorId,
            tenantId: this.tenantId,
            roomId: this._resolvedRoomId,
            cursor: this._cursor,
            timeoutMs: this.pollTimeoutMs,
            heartbeat: true,
            types: this.types.join(",")
          },
          signal: this._abortController?.signal
        });
      } catch (err) {
        if (!this._running || err?.name === "AbortError") {
          break;
        }
        failures++;
        consecutive502 = 0;
        this.emit("error", err);
        await this._backoff(failures);
        continue;
      }

      if (!this._running) break;
      if (!response) continue;
      const { status, data } = response;

      if (status === 200) {
        const events = data?.data?.events || [];
        const nextCursor = data?.data?.nextCursor;

        for (const evt of events) {
          this.emit("event", evt);
        }
        if (events.length > 0) {
          this.emit("events", events);
        }

        if (this.autoAck && nextCursor != null && nextCursor !== this._cursor) {
          try {
            await this.client.runtimeInboxAck({
              actorId: this.actorId,
              tenantId: this.tenantId,
              roomId: this._resolvedRoomId,
              upToCursor: nextCursor
            });
          } catch {
            // non-fatal ack failure
          }
        }

        this._cursor = nextCursor ?? this._cursor;
        failures = 0;
        consecutive502 = 0;
        continue;
      }

      failures++;

      if (status === 502) {
        consecutive502++;
        if (consecutive502 >= this.rebootstrapAfter) {
          try {
            await this._bootstrap();
          } catch (err) {
            this.emit("error", err);
          }
          failures = 0;
          consecutive502 = 0;
          continue;
        }
      } else {
        consecutive502 = 0;
      }

      await this._backoff(failures);
    }
  }

  async _backoff(attempt) {
    const exp = Math.min(attempt, 5);
    const delay = Math.min(this.baseDelayMs * (1 << exp), this.maxBackoffMs);
    const jitter = Math.random() * 1000;
    await this._sleep(delay + jitter);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // allow stop() abort to break sleep
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this._abortController?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

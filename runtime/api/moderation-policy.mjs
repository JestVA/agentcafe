export const MODERATION_REASON_CODES = {
  MOD_RATE_LIMIT: "MOD_RATE_LIMIT",
  MOD_REPEAT_TEXT: "MOD_REPEAT_TEXT",
  MOD_MIN_INTERVAL: "MOD_MIN_INTERVAL",
  MOD_COOLDOWN: "MOD_COOLDOWN"
};

function textKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export class ModerationPolicy {
  constructor({
    windowMs = Number(process.env.MOD_WINDOW_MS || 60000),
    maxActionsPerWindow = Number(process.env.MOD_MAX_ACTIONS_PER_WINDOW || 40),
    maxRepeatedTextPerWindow = Number(process.env.MOD_MAX_REPEATED_TEXT_PER_WINDOW || 4),
    minActionIntervalMs = Number(process.env.MOD_MIN_ACTION_INTERVAL_MS || 150),
    cooldownMs = Number(process.env.MOD_COOLDOWN_MS || 2000)
  } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    this.maxActionsPerWindow = Math.max(1, Number(maxActionsPerWindow) || 40);
    this.maxRepeatedTextPerWindow = Math.max(1, Number(maxRepeatedTextPerWindow) || 4);
    this.minActionIntervalMs = Math.max(0, Number(minActionIntervalMs) || 0);
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.byActor = new Map();
  }

  actorKey(tenantId, roomId, actorId) {
    return `${tenantId}:${roomId}:${actorId}`;
  }

  cleanup(now = Date.now()) {
    for (const [key, state] of this.byActor.entries()) {
      state.actions = state.actions.filter((ts) => now - ts <= this.windowMs);
      for (const [msg, rows] of state.textEvents.entries()) {
        const kept = rows.filter((ts) => now - ts <= this.windowMs);
        if (kept.length === 0) {
          state.textEvents.delete(msg);
        } else {
          state.textEvents.set(msg, kept);
        }
      }
      if (state.actions.length === 0 && state.textEvents.size === 0 && now >= state.cooldownUntil) {
        this.byActor.delete(key);
      }
    }
  }

  evaluateAndRecord({
    tenantId = "default",
    roomId = "main",
    actorId,
    action,
    text = null,
    source = "api"
  } = {}) {
    const now = Date.now();
    this.cleanup(now);
    const key = this.actorKey(tenantId, roomId, actorId);
    const state = this.byActor.get(key) || {
      actions: [],
      textEvents: new Map(),
      lastActionAt: 0,
      cooldownUntil: 0
    };

    if (now < state.cooldownUntil) {
      this.byActor.set(key, state);
      return {
        allowed: false,
        reasonCode: MODERATION_REASON_CODES.MOD_COOLDOWN,
        details: {
          source,
          action,
          retryAfterMs: state.cooldownUntil - now
        }
      };
    }

    state.actions = state.actions.filter((ts) => now - ts <= this.windowMs);

    if (this.minActionIntervalMs > 0 && state.lastActionAt > 0 && now - state.lastActionAt < this.minActionIntervalMs) {
      this.byActor.set(key, state);
      return {
        allowed: false,
        reasonCode: MODERATION_REASON_CODES.MOD_MIN_INTERVAL,
        details: {
          source,
          action,
          minIntervalMs: this.minActionIntervalMs
        }
      };
    }

    if (state.actions.length >= this.maxActionsPerWindow) {
      state.cooldownUntil = now + this.cooldownMs;
      this.byActor.set(key, state);
      return {
        allowed: false,
        reasonCode: MODERATION_REASON_CODES.MOD_RATE_LIMIT,
        details: {
          source,
          action,
          windowMs: this.windowMs,
          maxActionsPerWindow: this.maxActionsPerWindow,
          cooldownMs: this.cooldownMs
        }
      };
    }

    const keyText = textKey(text);
    if (action === "say" && keyText) {
      const rows = (state.textEvents.get(keyText) || []).filter((ts) => now - ts <= this.windowMs);
      if (rows.length >= this.maxRepeatedTextPerWindow) {
        state.cooldownUntil = now + this.cooldownMs;
        this.byActor.set(key, state);
        return {
          allowed: false,
          reasonCode: MODERATION_REASON_CODES.MOD_REPEAT_TEXT,
          details: {
            source,
            action,
            windowMs: this.windowMs,
            maxRepeatedTextPerWindow: this.maxRepeatedTextPerWindow
          }
        };
      }
      rows.push(now);
      state.textEvents.set(keyText, rows);
    }

    state.actions.push(now);
    state.lastActionAt = now;
    this.byActor.set(key, state);
    return {
      allowed: true,
      reasonCode: null,
      details: {
        source,
        action
      }
    };
  }
}

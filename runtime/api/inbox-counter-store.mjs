function noOpStore(reason) {
  return {
    enabled: false,
    reason,
    async incr() {
      return null;
    },
    async set() {
      return null;
    },
    async get() {
      return null;
    },
    async close() {}
  };
}

function hashKey(prefix, tenantId, roomId) {
  return `${prefix}:room:${tenantId}:${roomId}:inbox:unread`;
}

function safeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed);
}

export async function createInboxCounterStore({
  url = process.env.REDIS_URL || "",
  prefix = process.env.INBOX_REDIS_PREFIX || "acf"
} = {}) {
  const target = String(url || "").trim();
  if (!target) {
    return noOpStore("REDIS_URL not configured");
  }

  let createClient;
  try {
    ({ createClient } = await import("redis"));
  } catch (error) {
    return noOpStore(`"redis" package unavailable (${error instanceof Error ? error.message : String(error)})`);
  }

  const client = createClient({ url: target });
  client.on("error", (error) => {
    process.stderr.write(
      `[api][inbox-counters][redis] client error: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
  await client.connect();

  return {
    enabled: true,
    reason: null,
    async incr({ tenantId = "default", roomId = "main", actorId, delta = 0 } = {}) {
      const actor = String(actorId || "").trim();
      if (!actor) {
        return null;
      }
      const by = safeInt(delta);
      if (by === 0) {
        return this.get({ tenantId, roomId, actorId: actor });
      }
      const key = hashKey(prefix, tenantId, roomId);
      const next = await client.hIncrBy(key, actor, by);
      if (next < 0) {
        await client.hSet(key, actor, "0");
        return 0;
      }
      return Number(next);
    },
    async set({ tenantId = "default", roomId = "main", actorId, count = 0 } = {}) {
      const actor = String(actorId || "").trim();
      if (!actor) {
        return null;
      }
      const key = hashKey(prefix, tenantId, roomId);
      const normalized = Math.max(0, safeInt(count));
      await client.hSet(key, actor, String(normalized));
      return normalized;
    },
    async get({ tenantId = "default", roomId = "main", actorId } = {}) {
      const actor = String(actorId || "").trim();
      if (!actor) {
        return null;
      }
      const key = hashKey(prefix, tenantId, roomId);
      const raw = await client.hGet(key, actor);
      if (raw == null) {
        return 0;
      }
      return Math.max(0, safeInt(raw));
    },
    async close() {
      if (client.isOpen) {
        await client.quit();
      }
    }
  };
}

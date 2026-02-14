function noOpStore(reason) {
  return {
    enabled: false,
    reason,
    async listEvents() {
      return [];
    },
    async close() {}
  };
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeEvent(entry, fields) {
  const event = parseJson(fields.event, null);
  if (event && typeof event === "object") {
    return event;
  }

  return {
    eventId: String(fields.eventId || entry.id || ""),
    sequence: parseNumber(fields.sequence, 0),
    tenantId: String(fields.tenantId || "default"),
    roomId: String(fields.roomId || "main"),
    actorId: String(fields.actorId || ""),
    type: String(fields.type || ""),
    timestamp: String(fields.timestamp || ""),
    payload: parseJson(fields.payload, {})
  };
}

function roomStreamKey(prefix, tenantId, roomId) {
  return `${prefix}:room:${tenantId}:${roomId}:stream`;
}

function sanitizeLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 300, 1000));
}

export async function createRedisReplayStore({
  url = process.env.REDIS_URL || "",
  prefix = process.env.REALTIME_REDIS_PREFIX || "acf"
} = {}) {
  const target = String(url || "").trim();
  if (!target) {
    return noOpStore("REDIS_URL not configured");
  }

  let createClient;
  try {
    ({ createClient } = await import("redis"));
  } catch (error) {
    return noOpStore(
      `"redis" package unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const client = createClient({
    url: target
  });

  client.on("error", (error) => {
    process.stderr.write(
      `[realtime][redis] client error: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });

  await client.connect();

  return {
    enabled: true,
    reason: null,
    async listEvents({ tenantId = "default", roomId = "main", cursor = 0, limit = 300 } = {}) {
      const bounded = sanitizeLimit(limit);
      const key = roomStreamKey(prefix, tenantId, roomId);
      const cursorNum = Number(cursor) || 0;

      let rows = [];
      if (cursorNum > 0) {
        rows = await client.xRange(key, `(${cursorNum}`, "+", {
          COUNT: bounded
        });
      } else {
        rows = await client.xRevRange(key, "+", "-", {
          COUNT: bounded
        });
        rows.reverse();
      }

      return rows
        .map((entry) => normalizeEvent(entry, entry.message || {}))
        .filter((event) => Number(event.sequence || 0) > cursorNum);
    },
    async close() {
      if (client.isOpen) {
        await client.quit();
      }
    }
  };
}

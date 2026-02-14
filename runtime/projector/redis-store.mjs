function noOpStore(reason) {
  return {
    enabled: false,
    reason,
    async appendEvent() {},
    async writeProjection() {},
    async close() {}
  };
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    return null;
  }
  return {
    actorId: actor.actorId || null,
    status: actor.status || null,
    x: Number(actor.x || 0),
    y: Number(actor.y || 0),
    lastSeen: actor.lastSeen || null,
    lastOrder: actor.lastOrder || null,
    presence: actor.presence || null
  };
}

function compactSnapshot(snapshot) {
  return {
    tenantId: snapshot.tenantId,
    roomId: snapshot.roomId,
    lastEventId: snapshot.lastEventId || null,
    lastEventAt: snapshot.lastEventAt || null,
    actors: Array.isArray(snapshot.actors) ? snapshot.actors.map(normalizeActor).filter(Boolean) : [],
    pinnedContext: snapshot.pinnedContext || null,
    threads: Array.isArray(snapshot.threads) ? snapshot.threads : [],
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
    sharedObjects: Array.isArray(snapshot.sharedObjects) ? snapshot.sharedObjects : [],
    localMemory: Array.isArray(snapshot.localMemory) ? snapshot.localMemory : []
  };
}

function streamFieldsFor(event) {
  return {
    eventId: String(event.eventId || ""),
    sequence: String(Number(event.sequence || 0)),
    tenantId: String(event.tenantId || ""),
    roomId: String(event.roomId || ""),
    actorId: String(event.actorId || ""),
    type: String(event.type || ""),
    timestamp: String(event.timestamp || ""),
    payload: JSON.stringify(event.payload || {}),
    event: JSON.stringify(event || {})
  };
}

export async function createRedisProjectionStore({
  url = process.env.REDIS_URL || "",
  streamMaxLen = Number(process.env.PROJECTOR_REDIS_STREAM_MAXLEN || 2000),
  presenceTtlSeconds = Number(process.env.PROJECTOR_REDIS_PRESENCE_TTL_SECONDS || 60)
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
      `[projector][redis] client error: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });

  await client.connect();

  return {
    enabled: true,
    reason: null,
    async appendEvent({ event, keyspace }) {
      if (!event || !keyspace?.stream) {
        return;
      }
      await client.xAdd(keyspace.stream, "*", streamFieldsFor(event), {
        TRIM: {
          strategy: "MAXLEN",
          strategyModifier: "~",
          threshold: Math.max(100, Number(streamMaxLen || 2000))
        }
      });
    },
    async writeProjection({ snapshot, keyspace }) {
      if (!snapshot || !keyspace) {
        return;
      }

      const compact = compactSnapshot(snapshot);
      const multi = client.multi();

      multi.set(
        keyspace.state,
        JSON.stringify({
          tenantId: compact.tenantId,
          roomId: compact.roomId,
          lastEventId: compact.lastEventId,
          lastEventAt: compact.lastEventAt,
          actorCount: compact.actors.length,
          threadCount: compact.threads.length,
          taskCount: compact.tasks.length,
          objectCount: compact.sharedObjects.length
        })
      );
      multi.set(`${keyspace.state}:snapshot`, JSON.stringify(compact));

      multi.del(keyspace.presence);
      for (const actor of compact.actors) {
        if (!actor.actorId) {
          continue;
        }
        multi.hSet(keyspace.presence, actor.actorId, JSON.stringify(actor));
      }
      if (compact.actors.length > 0 && Number.isFinite(presenceTtlSeconds) && presenceTtlSeconds > 0) {
        multi.expire(keyspace.presence, Math.max(10, Number(presenceTtlSeconds)));
      }

      multi.del(keyspace.chat);
      for (const item of snapshot.chat || []) {
        multi.rPush(keyspace.chat, JSON.stringify(item));
      }

      multi.del(keyspace.orders);
      for (const item of snapshot.orders || []) {
        multi.rPush(keyspace.orders, JSON.stringify(item));
      }

      await multi.exec();
    },
    async close() {
      if (client.isOpen) {
        await client.quit();
      }
    }
  };
}

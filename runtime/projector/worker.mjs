import { extractSseMessages } from "../shared/sse.mjs";
import { ProjectionState } from "./projection-state.mjs";
import { createRedisProjectionStore } from "./redis-store.mjs";

const API_URL = process.env.PROJECTOR_EVENT_SOURCE_URL || "http://127.0.0.1:3850";
const TENANT_ID = process.env.PROJECTOR_TENANT_ID || "default";
const ROOM_ID = process.env.PROJECTOR_ROOM_ID || "main";
const RECONNECT_MS = Number(process.env.PROJECTOR_STREAM_RECONNECT_MS || 2000);
const STREAM_URL = process.env.PROJECTOR_EVENT_STREAM_URL || `${API_URL}/v1/streams/market-events`;
const REDIS_PREFIX = process.env.PROJECTOR_REDIS_PREFIX || "acf";

const projection = new ProjectionState();
let cursor = Number(process.env.PROJECTOR_START_CURSOR || 0);
let redisStore = null;

function keyspaceFor(tenantId, roomId) {
  return {
    state: `${REDIS_PREFIX}:room:${tenantId}:${roomId}:state`,
    presence: `${REDIS_PREFIX}:room:${tenantId}:${roomId}:presence`,
    chat: `${REDIS_PREFIX}:room:${tenantId}:${roomId}:chat`,
    orders: `${REDIS_PREFIX}:room:${tenantId}:${roomId}:orders`,
    stream: `${REDIS_PREFIX}:room:${tenantId}:${roomId}:stream`
  };
}

async function flushProjection(eventCount, reason = "batch") {
  const snapshot = projection.snapshot(TENANT_ID, ROOM_ID);
  if (redisStore?.enabled) {
    await redisStore.writeProjection({
      snapshot,
      keyspace: keyspaceFor(TENANT_ID, ROOM_ID)
    });
  }
  process.stdout.write(
    `[projector] ${reason} delta=${eventCount} cursor=${cursor} actors=${snapshot.actors.length} chat=${snapshot.chat.length} orders=${snapshot.orders.length}\n`
  );
}

async function consumeOnce() {
  const url = new URL(STREAM_URL);
  url.searchParams.set("tenantId", TENANT_ID);
  url.searchParams.set("roomId", ROOM_ID);
  if (cursor > 0) {
    url.searchParams.set("cursor", String(cursor));
  }

  const res = await fetch(url, {
    headers: {
      accept: "text/event-stream"
    }
  });

  if (!res.ok || !res.body) {
    throw new Error(`stream request failed (${res.status})`);
  }

  process.stdout.write(`[projector] connected stream=${url.toString()}\n`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let batchCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parsed = extractSseMessages(buffer);
    buffer = parsed.rest;

    for (const message of parsed.messages) {
      if (message.type === "heartbeat") {
        const heartbeatCursor = Number(message.data?.cursor);
        if (Number.isFinite(heartbeatCursor)) {
          cursor = Math.max(cursor, heartbeatCursor);
        }
        continue;
      }

      if (message.type === "ready" || message.type === "snapshot") {
        continue;
      }

      const event = message.data;
      if (!event || typeof event !== "object") {
        continue;
      }

      projection.apply(event);
      if (Number.isFinite(event.sequence)) {
        cursor = Math.max(cursor, Number(event.sequence));
      }
      if (redisStore?.enabled) {
        await redisStore.appendEvent({
          event,
          keyspace: keyspaceFor(TENANT_ID, ROOM_ID)
        });
      }
      batchCount += 1;

      if (batchCount >= 10) {
        await flushProjection(batchCount, "batch");
        batchCount = 0;
      }
    }
  }

  if (batchCount > 0) {
    await flushProjection(batchCount, "tail");
  }
}

async function run() {
  process.stdout.write(`agentcafe-projector streaming from ${STREAM_URL}\n`);
  process.stdout.write(`redis keyspace: ${JSON.stringify(keyspaceFor(TENANT_ID, ROOM_ID))}\n`);
  redisStore = await createRedisProjectionStore();
  if (redisStore.enabled) {
    process.stdout.write("[projector] redis projection store enabled\n");
  } else {
    process.stdout.write(`[projector] redis projection store disabled: ${redisStore.reason}\n`);
  }

  while (true) {
    try {
      await consumeOnce();
    } catch (error) {
      process.stderr.write(`[projector] stream error: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void (async () => {
      try {
        await redisStore?.close?.();
      } finally {
        process.exit(0);
      }
    })();
  });
}

run();

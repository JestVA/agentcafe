import { extractSseMessages } from "../shared/sse.mjs";
import { ProjectionState } from "./projection-state.mjs";

const API_URL = process.env.PROJECTOR_EVENT_SOURCE_URL || "http://127.0.0.1:3850";
const TENANT_ID = process.env.PROJECTOR_TENANT_ID || "default";
const ROOM_ID = process.env.PROJECTOR_ROOM_ID || "main";
const RECONNECT_MS = Number(process.env.PROJECTOR_STREAM_RECONNECT_MS || 2000);
const STREAM_URL = process.env.PROJECTOR_EVENT_STREAM_URL || `${API_URL}/v1/streams/market-events`;

const projection = new ProjectionState();
let cursor = Number(process.env.PROJECTOR_START_CURSOR || 0);

function keyspaceFor(tenantId, roomId) {
  return {
    state: `acf:room:${tenantId}:${roomId}:state`,
    presence: `acf:room:${tenantId}:${roomId}:presence`,
    chat: `acf:room:${tenantId}:${roomId}:chat`,
    orders: `acf:room:${tenantId}:${roomId}:orders`,
    stream: `acf:room:${tenantId}:${roomId}:stream`
  };
}

function logSnapshot(eventCount) {
  const snapshot = projection.snapshot(TENANT_ID, ROOM_ID);
  process.stdout.write(
    `[projector] delta=${eventCount} cursor=${cursor} actors=${snapshot.actors.length} chat=${snapshot.chat.length} orders=${snapshot.orders.length}\n`
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
      batchCount += 1;

      if (batchCount >= 10) {
        logSnapshot(batchCount);
        batchCount = 0;
      }
    }
  }

  if (batchCount > 0) {
    logSnapshot(batchCount);
  }
}

async function run() {
  process.stdout.write(`agentcafe-projector streaming from ${STREAM_URL}\n`);
  process.stdout.write(`redis keyspace: ${JSON.stringify(keyspaceFor(TENANT_ID, ROOM_ID))}\n`);

  while (true) {
    try {
      await consumeOnce();
    } catch (error) {
      process.stderr.write(`[projector] stream error: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
  }
}

run();

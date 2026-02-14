import http from "node:http";
import { AppError, errorBody, getRequestId, normalizeError } from "../shared/errors.mjs";
import { json } from "../shared/http.mjs";
import { extractSseMessages } from "../shared/sse.mjs";
import { createRedisReplayStore } from "./redis-replay-store.mjs";

const HOST = process.env.REALTIME_HOST || "0.0.0.0";
const PORT = Number(process.env.REALTIME_PORT || process.env.PORT || 3851);
const CLIENT_HEARTBEAT_MS = Number(process.env.REALTIME_HEARTBEAT_MS || 15000);
const SOURCE_RECONNECT_MS = Number(process.env.REALTIME_SOURCE_RECONNECT_MS || 2000);
const HISTORY_LIMIT = Number(process.env.REALTIME_ROOM_HISTORY_LIMIT || 500);
const DEFAULT_TENANT_ID = process.env.REALTIME_DEFAULT_TENANT_ID || "default";
const SOURCE_URL =
  process.env.REALTIME_EVENT_SOURCE_URL || "http://127.0.0.1:3850/v1/streams/market-events";

const roomClients = new Map();
const roomHistory = new Map();
const replayStore = await createRedisReplayStore();

const sourceState = {
  connected: false,
  reconnects: 0,
  lastCursor: 0,
  lastEventAt: null,
  lastError: null
};

function roomKey(tenantId, roomId) {
  return `${tenantId}:${roomId}`;
}

function ensureRoomClients(key) {
  let set = roomClients.get(key);
  if (!set) {
    set = new Set();
    roomClients.set(key, set);
  }
  return set;
}

function ensureRoomHistory(key) {
  let list = roomHistory.get(key);
  if (!list) {
    list = [];
    roomHistory.set(key, list);
  }
  return list;
}

function removeClient(client) {
  const set = roomClients.get(client.streamKey);
  if (!set) {
    return;
  }
  set.delete(client);
  if (set.size === 0) {
    roomClients.delete(client.streamKey);
  }
}

function matchesClient(client, event) {
  if (client.tenantId && client.tenantId !== event.tenantId) {
    return false;
  }
  if (client.roomId && client.roomId !== event.roomId) {
    return false;
  }
  if (client.actorId && client.actorId !== event.actorId) {
    return false;
  }
  if (client.types?.length && !client.types.includes(event.type)) {
    return false;
  }
  return true;
}

function sortBySequence(events) {
  return [...events].sort((a, b) => {
    const left = Number(a?.sequence || 0);
    const right = Number(b?.sequence || 0);
    return left - right;
  });
}

function mergeUniqueEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const key = event.eventId || `seq:${Number(event.sequence || 0)}`;
    map.set(key, event);
  }
  return sortBySequence([...map.values()]);
}

function writeSse(res, { id, type, data }) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  if (type) {
    res.write(`event: ${type}\n`);
  }
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function ingestEvent(event) {
  if (!event || typeof event !== "object") {
    return;
  }

  const tenantId = typeof event.tenantId === "string" && event.tenantId ? event.tenantId : DEFAULT_TENANT_ID;
  const roomId = typeof event.roomId === "string" && event.roomId ? event.roomId : "main";
  const streamKey = roomKey(tenantId, roomId);
  event.tenantId = tenantId;
  event.roomId = roomId;

  const history = ensureRoomHistory(streamKey);
  history.push(event);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }

  if (Number.isFinite(event.sequence)) {
    sourceState.lastCursor = Math.max(sourceState.lastCursor, Number(event.sequence));
  }
  sourceState.lastEventAt = new Date().toISOString();

  const clients = roomClients.get(streamKey);
  if (!clients || !clients.size) {
    return;
  }

  for (const client of clients) {
    if (!matchesClient(client, event)) {
      continue;
    }
    writeSse(client.res, {
      id: event.sequence,
      type: event.type,
      data: event
    });
    client.lastCursor = event.sequence || client.lastCursor;
  }
}

async function replayToClient(client, cursor = 0, limit = 300) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));
  const startCursor = Number(cursor || 0);
  const memoryReplay = ensureRoomHistory(client.streamKey)
    .filter((event) => (Number(event.sequence) || 0) > startCursor)
    .filter((event) => matchesClient(client, event));

  let replay = memoryReplay;
  if (replayStore?.enabled) {
    try {
      const redisReplay = await replayStore.listEvents({
        tenantId: client.tenantId,
        roomId: client.roomId,
        cursor: startCursor,
        limit: boundedLimit
      });
      replay = mergeUniqueEvents([...redisReplay, ...memoryReplay]);
    } catch (error) {
      sourceState.lastError = `redis replay failed: ${error instanceof Error ? error.message : String(error)}`;
      replay = sortBySequence(memoryReplay);
    }
  }

  replay = replay
    .filter((event) => matchesClient(client, event))
    .slice(-boundedLimit);

  for (const event of replay) {
    writeSse(client.res, {
      id: event.sequence,
      type: event.type,
      data: event
    });
    client.lastCursor = event.sequence || client.lastCursor;
  }

  return replay.length;
}

function parseTypes(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function consumeSourceOnce() {
  const url = new URL(SOURCE_URL);
  if (sourceState.lastCursor > 0) {
    url.searchParams.set("cursor", String(sourceState.lastCursor));
  }

  const res = await fetch(url, {
    headers: {
      accept: "text/event-stream"
    }
  });

  if (!res.ok || !res.body) {
    throw new Error(`event source request failed (${res.status})`);
  }

  sourceState.connected = true;
  sourceState.lastError = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        const c = Number(message.data?.cursor);
        if (Number.isFinite(c)) {
          sourceState.lastCursor = Math.max(sourceState.lastCursor, c);
        }
        continue;
      }
      if (message.type === "ready" || message.type === "snapshot") {
        continue;
      }
      if (message.data && typeof message.data === "object") {
        ingestEvent(message.data);
      }
    }
  }

  sourceState.connected = false;
}

async function consumeSourceForever() {
  while (true) {
    try {
      await consumeSourceOnce();
    } catch (error) {
      sourceState.lastError = error instanceof Error ? error.message : String(error);
      sourceState.connected = false;
      sourceState.reconnects += 1;
    }

    await new Promise((resolve) => setTimeout(resolve, SOURCE_RECONNECT_MS));
  }
}

function sendError(res, requestId, error) {
  const normalized = normalizeError(error);
  json(res, normalized.status, errorBody(normalized, requestId), {
    "x-request-id": requestId
  });
}

const server = http.createServer(async (req, res) => {
  const requestId = getRequestId(req);
  try {
    if (!req.url || !req.method) {
      throw new AppError("ERR_VALIDATION", "Malformed request");
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(
        res,
        200,
        {
          ok: true,
          service: "agentcafe-realtime",
          rooms: roomClients.size,
          clients: [...roomClients.values()].reduce((sum, set) => sum + set.size, 0),
          replayStore: {
            enabled: Boolean(replayStore?.enabled),
            reason: replayStore?.reason || null
          },
          source: {
            connected: sourceState.connected,
            reconnects: sourceState.reconnects,
            lastCursor: sourceState.lastCursor,
            lastEventAt: sourceState.lastEventAt,
            lastError: sourceState.lastError
          }
        },
        { "x-request-id": requestId }
      );
    }

    if (req.method === "GET" && url.pathname === "/v1/stream") {
      const tenantId = (url.searchParams.get("tenantId") || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
      const roomId = (url.searchParams.get("roomId") || "main").trim() || "main";
      const actorId = (url.searchParams.get("actorId") || "").trim() || null;
      const types = parseTypes(url.searchParams.get("types"));
      const cursor = Number(url.searchParams.get("cursor") || 0);
      const replayLimit = Number(url.searchParams.get("limit") || 300);
      const streamKey = roomKey(tenantId, roomId);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": requestId
      });

      const client = {
        res,
        tenantId,
        roomId,
        actorId,
        types,
        streamKey,
        lastCursor: Number.isFinite(cursor) ? cursor : 0
      };

      writeSse(res, {
        type: "snapshot",
        data: {
          tenantId,
          roomId,
          actorId,
          types,
          lastCursor: sourceState.lastCursor,
          sourceConnected: sourceState.connected
        }
      });

      const replayed = await replayToClient(client, client.lastCursor, replayLimit);
      ensureRoomClients(streamKey).add(client);

      writeSse(res, {
        type: "ready",
        data: {
          tenantId,
          roomId,
          replayed,
          requestId
        }
      });

      const heartbeat = setInterval(() => {
        writeSse(res, {
          type: "heartbeat",
          data: {
            ts: Date.now(),
            cursor: client.lastCursor
          }
        });
      }, CLIENT_HEARTBEAT_MS);

      req.on("close", () => {
        clearInterval(heartbeat);
        removeClient(client);
      });
      return;
    }

    throw new AppError(
      "ERR_UNSUPPORTED_ACTION",
      "Route not found",
      {
        method: req.method,
        path: url.pathname
      },
      404
    );
  } catch (error) {
    sendError(res, requestId, error);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`agentcafe-realtime listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`agentcafe-realtime source stream ${SOURCE_URL}\n`);
  if (replayStore?.enabled) {
    process.stdout.write("agentcafe-realtime redis replay store enabled\n");
  } else {
    process.stdout.write(`agentcafe-realtime redis replay store disabled: ${replayStore?.reason || "unknown"}\n`);
  }
});

consumeSourceForever();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void (async () => {
      try {
        await replayStore?.close?.();
      } finally {
        process.exit(0);
      }
    })();
  });
}

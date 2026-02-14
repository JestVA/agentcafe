import http from "node:http";
import { AppError, errorBody, getRequestId, normalizeError } from "../shared/errors.mjs";
import { json } from "../shared/http.mjs";
import { extractSseMessages } from "../shared/sse.mjs";

const HOST = process.env.REALTIME_HOST || "0.0.0.0";
const PORT = Number(process.env.REALTIME_PORT || process.env.PORT || 3851);
const CLIENT_HEARTBEAT_MS = Number(process.env.REALTIME_HEARTBEAT_MS || 15000);
const SOURCE_RECONNECT_MS = Number(process.env.REALTIME_SOURCE_RECONNECT_MS || 2000);
const HISTORY_LIMIT = Number(process.env.REALTIME_ROOM_HISTORY_LIMIT || 500);
const SOURCE_URL =
  process.env.REALTIME_EVENT_SOURCE_URL || "http://127.0.0.1:3850/v1/streams/market-events";

const roomClients = new Map();
const roomHistory = new Map();

const sourceState = {
  connected: false,
  reconnects: 0,
  lastCursor: 0,
  lastEventAt: null,
  lastError: null
};

function ensureRoomClients(roomId) {
  let set = roomClients.get(roomId);
  if (!set) {
    set = new Set();
    roomClients.set(roomId, set);
  }
  return set;
}

function ensureRoomHistory(roomId) {
  let list = roomHistory.get(roomId);
  if (!list) {
    list = [];
    roomHistory.set(roomId, list);
  }
  return list;
}

function removeClient(client) {
  const set = roomClients.get(client.roomId);
  if (!set) {
    return;
  }
  set.delete(client);
  if (set.size === 0) {
    roomClients.delete(client.roomId);
  }
}

function matchesClient(client, event) {
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

  const roomId = typeof event.roomId === "string" && event.roomId ? event.roomId : "main";
  const history = ensureRoomHistory(roomId);
  history.push(event);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }

  if (Number.isFinite(event.sequence)) {
    sourceState.lastCursor = Math.max(sourceState.lastCursor, Number(event.sequence));
  }
  sourceState.lastEventAt = new Date().toISOString();

  const clients = roomClients.get(roomId);
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

function replayToClient(client, cursor = 0, limit = 300) {
  const history = ensureRoomHistory(client.roomId);
  const replay = history
    .filter((event) => (Number(event.sequence) || 0) > Number(cursor || 0))
    .filter((event) => matchesClient(client, event))
    .slice(-Math.max(1, Math.min(Number(limit) || 300, 1000)));

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
      const roomId = (url.searchParams.get("roomId") || "main").trim() || "main";
      const actorId = (url.searchParams.get("actorId") || "").trim() || null;
      const types = parseTypes(url.searchParams.get("types"));
      const cursor = Number(url.searchParams.get("cursor") || 0);
      const replayLimit = Number(url.searchParams.get("limit") || 300);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": requestId
      });

      const client = {
        res,
        roomId,
        actorId,
        types,
        lastCursor: Number.isFinite(cursor) ? cursor : 0
      };

      writeSse(res, {
        type: "snapshot",
        data: {
          roomId,
          actorId,
          types,
          lastCursor: sourceState.lastCursor,
          sourceConnected: sourceState.connected
        }
      });

      const replayed = replayToClient(client, client.lastCursor, replayLimit);
      ensureRoomClients(roomId).add(client);

      writeSse(res, {
        type: "ready",
        data: {
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
});

consumeSourceForever();

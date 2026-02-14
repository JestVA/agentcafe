import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requestMenu,
  enterCafe,
  moveActor,
  say,
  orderCoffee,
  getCurrentOrder,
  getRecentOrders,
  getRecentChats,
  leaveCafe,
  getState,
  sweepExpiredState
} from "./state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.AGENTCAFE_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || process.env.AGENTCAFE_PORT || 3846);
const STREAM_HEARTBEAT_MS = Number(process.env.AGENTCAFE_STREAM_HEARTBEAT_MS || 15000);
const SWEEP_INTERVAL_MS = Number(process.env.AGENTCAFE_SWEEP_INTERVAL_MS || 1000);
const DUAL_WRITE_ENABLED = String(process.env.AGENTCAFE_DUAL_WRITE_ENABLED || "false").toLowerCase() === "true";
const DUAL_WRITE_RUNTIME_API_URL = String(
  process.env.AGENTCAFE_RUNTIME_API_URL || "http://127.0.0.1:3850"
).replace(/\/$/, "");
const DUAL_WRITE_TIMEOUT_MS = Math.max(250, Number(process.env.AGENTCAFE_DUAL_WRITE_TIMEOUT_MS || 3000));
const RUNTIME_PROXY_TIMEOUT_MS = Math.max(250, Number(process.env.AGENTCAFE_RUNTIME_PROXY_TIMEOUT_MS || 6000));
const DUAL_WRITE_HISTORY_LIMIT = Math.max(
  10,
  Math.min(Number(process.env.AGENTCAFE_DUAL_WRITE_HISTORY_LIMIT || 200), 2000)
);
const DUAL_WRITE_TENANT_ID = process.env.AGENTCAFE_DUAL_WRITE_TENANT_ID || "default";
const DUAL_WRITE_ROOM_ID = process.env.AGENTCAFE_DUAL_WRITE_ROOM_ID || "main";

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }]
]);
const streamClients = new Set();
let streamSequence = 0;
const dualWriteMetrics = {
  enabled: DUAL_WRITE_ENABLED,
  targetUrl: DUAL_WRITE_RUNTIME_API_URL,
  tenantId: DUAL_WRITE_TENANT_ID,
  roomId: DUAL_WRITE_ROOM_ID,
  startedAt: new Date().toISOString(),
  attempted: 0,
  runtimeSucceeded: 0,
  runtimeFailed: 0,
  divergenceCount: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  recent: []
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, {
    ok: false,
    error: message
  });
}

function baseActorId(value) {
  const actorId = String(value || "").trim();
  return actorId || "agent";
}

function appendDualWriteMetric(entry) {
  dualWriteMetrics.recent.unshift(entry);
  if (dualWriteMetrics.recent.length > DUAL_WRITE_HISTORY_LIMIT) {
    dualWriteMetrics.recent.length = DUAL_WRITE_HISTORY_LIMIT;
  }
}

function mapDualWriteRequest(action, input = {}) {
  const actorId = baseActorId(input.actorId);
  const payloadBase = {
    tenantId: DUAL_WRITE_TENANT_ID,
    roomId: DUAL_WRITE_ROOM_ID,
    actorId
  };

  if (action === "enter") {
    return {
      path: "/v1/commands/enter",
      payload: payloadBase
    };
  }
  if (action === "leave") {
    return {
      path: "/v1/commands/leave",
      payload: payloadBase
    };
  }
  if (action === "move") {
    return {
      path: "/v1/commands/move",
      payload: {
        ...payloadBase,
        direction: input.direction,
        steps: input.steps
      }
    };
  }
  if (action === "say") {
    return {
      path: "/v1/conversations/messages",
      payload: {
        ...payloadBase,
        text: input.text,
        ttlMs: input.ttlMs
      }
    };
  }
  if (action === "order") {
    return {
      path: "/v1/commands/order",
      payload: {
        ...payloadBase,
        itemId: input.itemId,
        size: input.size
      }
    };
  }

  return null;
}

async function replicateRuntimeWrite(action, input = {}) {
  if (!DUAL_WRITE_ENABLED) {
    return;
  }

  const mapping = mapDualWriteRequest(action, input);
  if (!mapping) {
    return;
  }

  const startedAt = Date.now();
  dualWriteMetrics.attempted += 1;
  dualWriteMetrics.lastAttemptAt = new Date(startedAt).toISOString();

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DUAL_WRITE_TIMEOUT_MS);

  let entry = {
    ts: new Date().toISOString(),
    action,
    path: mapping.path,
    actorId: baseActorId(input.actorId),
    success: false,
    statusCode: null,
    latencyMs: null,
    error: null
  };

  try {
    const response = await fetch(`${DUAL_WRITE_RUNTIME_API_URL}${mapping.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `dw-${action}-${Date.now()}-${randomUUID()}`
      },
      body: JSON.stringify(mapping.payload),
      signal: controller.signal
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const success = response.ok && (!body || body.ok !== false);
    const finishedAt = Date.now();
    entry = {
      ...entry,
      success,
      statusCode: response.status,
      latencyMs: finishedAt - startedAt,
      error: success ? null : body?.error || `HTTP ${response.status}`
    };

    if (success) {
      dualWriteMetrics.runtimeSucceeded += 1;
      dualWriteMetrics.lastSuccessAt = new Date(finishedAt).toISOString();
    } else {
      dualWriteMetrics.runtimeFailed += 1;
      dualWriteMetrics.divergenceCount += 1;
      dualWriteMetrics.lastFailureAt = new Date(finishedAt).toISOString();
      dualWriteMetrics.lastError = entry.error;
    }
  } catch (error) {
    const finishedAt = Date.now();
    entry = {
      ...entry,
      success: false,
      latencyMs: finishedAt - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
    dualWriteMetrics.runtimeFailed += 1;
    dualWriteMetrics.divergenceCount += 1;
    dualWriteMetrics.lastFailureAt = new Date(finishedAt).toISOString();
    dualWriteMetrics.lastError = entry.error;
  } finally {
    clearTimeout(timeout);
    appendDualWriteMetric(entry);
  }
}

function runtimeProxyPath(pathname, searchParams) {
  const target = new URL(`${DUAL_WRITE_RUNTIME_API_URL}${pathname}`);
  for (const [key, value] of searchParams.entries()) {
    target.searchParams.set(key, value);
  }
  return target;
}

async function proxyRuntimeJson(req, res, url, runtimePathname) {
  const upstreamUrl = runtimeProxyPath(runtimePathname, url.searchParams);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, RUNTIME_PROXY_TIMEOUT_MS);

  try {
    const init = {
      method: req.method,
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    };

    if (req.method !== "GET") {
      const body = await readBody(req);
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body || {});
    }

    const upstreamRes = await fetch(upstreamUrl, init);
    const raw = await upstreamRes.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : { ok: upstreamRes.ok };
    } catch {
      payload = {
        ok: false,
        error: `invalid JSON response from runtime (${upstreamRes.status})`
      };
    }

    res.writeHead(upstreamRes.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyRuntimeSse(req, res, url) {
  const upstreamUrl = runtimeProxyPath("/v1/streams/market-events", url.searchParams);
  const controller = new AbortController();
  let reader = null;

  req.on("close", () => {
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
    }
  });

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        accept: "text/event-stream"
      },
      signal: controller.signal
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      return sendError(res, 502, `runtime stream unavailable (${upstreamRes.status})`);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    reader = upstreamRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done || res.writableEnded) {
        break;
      }
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!res.headersSent) {
      return sendError(res, 502, error instanceof Error ? error.message : String(error));
    }
    if (!res.writableEnded) {
      writeSse(res, {
        event: "error",
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      res.end();
    }
  }
}

function buildViewState() {
  const state = getState();
  const orders = getRecentOrders({ limit: 50 });
  const chats = getRecentChats({ limit: 100 });
  return {
    ok: true,
    world: state.world,
    actors: state.actors,
    orders: orders.orders || [],
    chats: chats.chats || []
  };
}

function writeSse(res, { event, data, id }) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function removeStreamClient(client) {
  if (!client) {
    return;
  }
  streamClients.delete(client);
}

function broadcastEvent(event, data) {
  if (streamClients.size === 0) {
    return;
  }
  const id = ++streamSequence;
  for (const client of streamClients) {
    try {
      writeSse(client.res, { id, event, data });
    } catch {
      removeStreamClient(client);
    }
  }
}

function broadcastState(reason) {
  broadcastEvent("state", {
    reason,
    ...buildViewState()
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

async function serveStatic(res, pathname) {
  const route = STATIC_FILES.get(pathname);
  if (!route) {
    return false;
  }

  const filePath = path.join(PUBLIC_DIR, route.file);
  const content = await readFile(filePath);
  res.writeHead(200, {
    "content-type": route.type,
    "cache-control": "no-cache"
  });
  res.end(content);
  return true;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/healthz") {
    return sendJson(res, 200, { ok: true, service: "agentcafe-world" });
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/stream") {
    return proxyRuntimeSse(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/healthz") {
    return proxyRuntimeJson(req, res, url, "/healthz");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/inbox") {
    return proxyRuntimeJson(req, res, url, "/v1/inbox");
  }

  if (req.method === "POST" && url.pathname === "/api/runtime/inbox/ack") {
    return proxyRuntimeJson(req, res, url, "/v1/inbox/ack");
  }

  const runtimeInboxAckMatch = url.pathname.match(/^\/api\/runtime\/inbox\/([^/]+)\/ack$/);
  if (req.method === "POST" && runtimeInboxAckMatch) {
    return proxyRuntimeJson(req, res, url, `/v1/inbox/${encodeURIComponent(runtimeInboxAckMatch[1])}/ack`);
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/timeline") {
    return proxyRuntimeJson(req, res, url, "/v1/timeline");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/presence") {
    return proxyRuntimeJson(req, res, url, "/v1/presence");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/tasks") {
    return proxyRuntimeJson(req, res, url, "/v1/tasks");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/events") {
    return proxyRuntimeJson(req, res, url, "/v1/events");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/mentions") {
    return proxyRuntimeJson(req, res, url, "/v1/mentions");
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/replay") {
    return proxyRuntimeJson(req, res, url, "/v1/replay");
  }

  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    const client = { res };
    streamClients.add(client);

    writeSse(res, {
      id: ++streamSequence,
      event: "ready",
      data: {
        ok: true,
        heartbeatMs: STREAM_HEARTBEAT_MS,
        snapshot: buildViewState()
      }
    });

    req.on("close", () => {
      removeStreamClient(client);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dual-write/status") {
    const attempted = dualWriteMetrics.attempted;
    const runtimeParityRate = attempted > 0 ? dualWriteMetrics.runtimeSucceeded / attempted : null;
    return sendJson(res, 200, {
      ok: true,
      data: {
        ...dualWriteMetrics,
        runtimeParityRate
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/menu") {
    return sendJson(res, 200, requestMenu());
  }

  if (req.method === "GET" && url.pathname === "/api/view") {
    return sendJson(res, 200, buildViewState());
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(
      res,
      200,
      getState({ actorId: url.searchParams.get("actorId") || undefined })
    );
  }

  if (req.method === "GET" && url.pathname === "/api/order") {
    return sendJson(
      res,
      200,
      getCurrentOrder({ actorId: url.searchParams.get("actorId") || undefined })
    );
  }

  if (req.method === "GET" && url.pathname === "/api/orders") {
    return sendJson(
      res,
      200,
      getRecentOrders({ limit: url.searchParams.get("limit") || undefined })
    );
  }

  if (req.method === "GET" && url.pathname === "/api/chats") {
    return sendJson(
      res,
      200,
      getRecentChats({ limit: url.searchParams.get("limit") || undefined })
    );
  }

  if (req.method === "POST" && url.pathname === "/api/enter") {
    const body = await readBody(req);
    const response = enterCafe(body);
    sendJson(res, 200, response);
    broadcastState("enter");
    void replicateRuntimeWrite("enter", body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const body = await readBody(req);
    const response = moveActor(body);
    sendJson(res, 200, response);
    broadcastState("move");
    void replicateRuntimeWrite("move", body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/say") {
    const body = await readBody(req);
    const response = say(body);
    sendJson(res, 200, response);
    broadcastState("say");
    void replicateRuntimeWrite("say", body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/order") {
    const body = await readBody(req);
    const response = orderCoffee(body);
    sendJson(res, 200, response);
    broadcastState("order");
    void replicateRuntimeWrite("order", body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    const body = await readBody(req);
    const response = leaveCafe(body);
    sendJson(res, 200, response);
    broadcastState("leave");
    void replicateRuntimeWrite("leave", body);
    return;
  }

  sendError(res, 404, "route not found");
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      return sendError(res, 400, "malformed request");
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (await serveStatic(res, url.pathname)) {
      return;
    }

    sendError(res, 404, "not found");
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
});

const sweepHandle = setInterval(() => {
  const sweep = sweepExpiredState();
  if (sweep.changed) {
    broadcastState("expiry");
  }
}, SWEEP_INTERVAL_MS);

const heartbeatHandle = setInterval(() => {
  broadcastEvent("heartbeat", { ts: Date.now() });
}, STREAM_HEARTBEAT_MS);

server.on("close", () => {
  clearInterval(sweepHandle);
  clearInterval(heartbeatHandle);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`AgentCafe world listening on http://${HOST}:${PORT}\n`);
  if (DUAL_WRITE_ENABLED) {
    process.stdout.write(
      `AgentCafe dual-write enabled -> ${DUAL_WRITE_RUNTIME_API_URL} (tenant=${DUAL_WRITE_TENANT_ID}, room=${DUAL_WRITE_ROOM_ID})\n`
    );
  }
});

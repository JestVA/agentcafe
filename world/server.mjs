import http from "node:http";
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

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }]
]);
const streamClients = new Set();
let streamSequence = 0;

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
    const response = enterCafe(await readBody(req));
    sendJson(res, 200, response);
    broadcastState("enter");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const response = moveActor(await readBody(req));
    sendJson(res, 200, response);
    broadcastState("move");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/say") {
    const response = say(await readBody(req));
    sendJson(res, 200, response);
    broadcastState("say");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/order") {
    const response = orderCoffee(await readBody(req));
    sendJson(res, 200, response);
    broadcastState("order");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    const response = leaveCafe(await readBody(req));
    sendJson(res, 200, response);
    broadcastState("leave");
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
});

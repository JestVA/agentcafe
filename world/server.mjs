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
  getState
} from "./state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.AGENTCAFE_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || process.env.AGENTCAFE_PORT || 3846);

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }]
]);

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

  if (req.method === "GET" && url.pathname === "/api/menu") {
    return sendJson(res, 200, requestMenu());
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
    return sendJson(res, 200, enterCafe(await readBody(req)));
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    return sendJson(res, 200, moveActor(await readBody(req)));
  }

  if (req.method === "POST" && url.pathname === "/api/say") {
    return sendJson(res, 200, say(await readBody(req)));
  }

  if (req.method === "POST" && url.pathname === "/api/order") {
    return sendJson(res, 200, orderCoffee(await readBody(req)));
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    return sendJson(res, 200, leaveCafe(await readBody(req)));
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

server.listen(PORT, HOST, () => {
  process.stdout.write(`AgentCafe world listening on http://${HOST}:${PORT}\n`);
});

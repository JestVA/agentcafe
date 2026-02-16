import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.AGENTCAFE_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || process.env.AGENTCAFE_PORT || 3846);
const WORLD_API_KEY = String(process.env.AGENTCAFE_WORLD_API_KEY || "").trim();
const WORLD_API_AUTH_QUERY_PARAM =
  String(process.env.AGENTCAFE_WORLD_API_AUTH_QUERY_PARAM || "apiKey").trim() || "apiKey";
const RUNTIME_API_URL = String(process.env.AGENTCAFE_RUNTIME_API_URL || "http://127.0.0.1:3850").replace(/\/$/, "");
const RUNTIME_API_KEY = String(process.env.AGENTCAFE_RUNTIME_API_KEY || "").trim();
const RUNTIME_PROXY_TIMEOUT_MS = Math.max(250, Number(process.env.AGENTCAFE_RUNTIME_PROXY_TIMEOUT_MS || 6000));
const RUNTIME_PROXY_TIMEOUT_MAX_MS = Math.max(
  RUNTIME_PROXY_TIMEOUT_MS,
  Number(process.env.AGENTCAFE_RUNTIME_PROXY_TIMEOUT_MAX_MS || 65000)
);
const RUNTIME_PROXY_POLL_GRACE_MS = Math.max(250, Number(process.env.AGENTCAFE_RUNTIME_PROXY_POLL_GRACE_MS || 2000));
const DEFAULT_DISCOVERY_TENANT_ID = String(process.env.AGENTCAFE_DEFAULT_TENANT_ID || "default").trim() || "default";
const DEFAULT_DISCOVERY_ROOM_ID = String(process.env.AGENTCAFE_DEFAULT_ROOM_ID || "main").trim() || "main";

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }]
]);

const LEGACY_PATHS = new Set([
  "/api/menu",
  "/api/view",
  "/api/state",
  "/api/orders",
  "/api/chats",
  "/api/stream",
  "/api/dual-write/status",
  "/api/enter",
  "/api/move",
  "/api/say",
  "/api/order",
  "/api/leave"
]);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message, details = {}) {
  sendJson(res, statusCode, {
    ok: false,
    error: {
      message,
      ...details
    }
  });
}

function readProvidedApiKey(req, url) {
  const headerKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : "";
  if (headerKey) {
    return headerKey;
  }
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, "").trim();
  }
  return String(url.searchParams.get(WORLD_API_AUTH_QUERY_PARAM) || url.searchParams.get("token") || "").trim();
}

function requireWorldAuth(req, res, url) {
  if (!WORLD_API_KEY) {
    return true;
  }
  if (readProvidedApiKey(req, url) === WORLD_API_KEY) {
    return true;
  }
  sendError(res, 401, "unauthorized");
  return false;
}

function runtimeAuthHeader() {
  if (!RUNTIME_API_KEY) {
    return {};
  }
  return {
    "x-api-key": RUNTIME_API_KEY
  };
}

function runtimeProxyPath(pathname, searchParams) {
  const target = new URL(`${RUNTIME_API_URL}${pathname}`);
  for (const [key, value] of searchParams.entries()) {
    target.searchParams.set(key, value);
  }
  return target;
}

function resolveRuntimeProxyTimeoutMs(runtimePathname, searchParams) {
  if (runtimePathname !== "/v1/events/poll") {
    return RUNTIME_PROXY_TIMEOUT_MS;
  }

  const raw = Number(searchParams.get("timeoutMs"));
  const pollTimeoutMs = Number.isFinite(raw) ? Math.max(250, Math.min(raw, 30000)) : 25000;
  const withGrace = pollTimeoutMs + RUNTIME_PROXY_POLL_GRACE_MS;
  return Math.max(RUNTIME_PROXY_TIMEOUT_MS, Math.min(RUNTIME_PROXY_TIMEOUT_MAX_MS, withGrace));
}

function proxyRequestHeaders(req, allowList = []) {
  const out = {};
  for (const name of allowList) {
    const raw = req.headers[name];
    if (typeof raw === "string" && raw.trim()) {
      out[name] = raw.trim();
    }
  }
  return out;
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON body: ${reason}`);
  }
}

async function proxyRuntimeJson(req, res, url, runtimePathname) {
  const upstreamUrl = runtimeProxyPath(runtimePathname, url.searchParams);
  const controller = new AbortController();
  const timeoutMs = resolveRuntimeProxyTimeoutMs(runtimePathname, url.searchParams);
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const init = {
      method: req.method,
      headers: {
        ...proxyRequestHeaders(req, [
          "idempotency-key",
          "x-request-id",
          "x-correlation-id",
          "authorization",
          "x-api-key"
        ]),
        accept: "application/json",
        ...runtimeAuthHeader()
      },
      signal: controller.signal
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
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
        error: {
          message: `invalid JSON response from runtime (${upstreamRes.status})`
        }
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

async function proxyRuntimeSse(req, res, url, runtimePathname = "/v1/streams/market-events") {
  const upstreamUrl = runtimeProxyPath(runtimePathname, url.searchParams);
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
        ...proxyRequestHeaders(req, ["last-event-id", "authorization", "x-api-key"]),
        accept: "text/event-stream",
        ...runtimeAuthHeader()
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
      res.end();
    }
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

function legacyApiRoute(pathname) {
  if (LEGACY_PATHS.has(pathname)) {
    return true;
  }
  return pathname.startsWith("/api/runtime/");
}

function isRuntimeDirectPath(pathname) {
  return pathname === "/healthz" || pathname.startsWith("/v1/");
}

function isRuntimeDirectSsePath(pathname) {
  return pathname === "/v1/streams/market-events" || pathname === "/v1/events/stream";
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "agentcafe-world",
      mode: "runtime-proxy",
      canonicalApi: "/v1/*"
    });
  }

  if (!requireWorldAuth(req, res, url)) {
    return;
  }

  if (legacyApiRoute(url.pathname)) {
    return sendError(res, 410, "legacy api removed; use canonical runtime routes under /v1/*", {
      code: "ERR_LEGACY_API_REMOVED",
      canonicalBasePath: "/v1",
      migration: {
        bootstrap: `/v1/bootstrap?tenantId=${encodeURIComponent(DEFAULT_DISCOVERY_TENANT_ID)}&roomId=${encodeURIComponent(DEFAULT_DISCOVERY_ROOM_ID)}`,
        rooms: `/v1/rooms?tenantId=${encodeURIComponent(DEFAULT_DISCOVERY_TENANT_ID)}`,
        stream: `/v1/streams/market-events?tenantId=${encodeURIComponent(DEFAULT_DISCOVERY_TENANT_ID)}&roomId=${encodeURIComponent(DEFAULT_DISCOVERY_ROOM_ID)}`,
        commands: "/v1/commands/{enter|leave|move|say|order}",
        eventsPoll: `/v1/events/poll?tenantId=${encodeURIComponent(DEFAULT_DISCOVERY_TENANT_ID)}&roomId=${encodeURIComponent(DEFAULT_DISCOVERY_ROOM_ID)}&cursor=0`
      }
    });
  }

  return sendError(res, 404, "route not found");
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

    if (isRuntimeDirectPath(url.pathname)) {
      if (!requireWorldAuth(req, res, url)) {
        return;
      }
      if (req.method === "GET" && isRuntimeDirectSsePath(url.pathname)) {
        return proxyRuntimeSse(req, res, url, url.pathname);
      }
      return proxyRuntimeJson(req, res, url, url.pathname);
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
  if (WORLD_API_KEY) {
    process.stdout.write(`AgentCafe world API auth enabled (query=${WORLD_API_AUTH_QUERY_PARAM})\n`);
  }
  if (RUNTIME_API_KEY) {
    process.stdout.write("AgentCafe runtime proxy auth enabled\n");
  }
});

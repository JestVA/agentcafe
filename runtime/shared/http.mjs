const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES || 1024 * 1024); // 1 MB default

export async function readJson(req) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error(`Request body too large (${contentLength} bytes, max ${MAX_BODY_BYTES})`);
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`Request body too large (max ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

export function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

export function noContent(res, headers = {}) {
  res.writeHead(204, {
    "cache-control": "no-store",
    ...headers
  });
  res.end();
}

export function sendRateLimitHeaders({
  limit = 120,
  remaining = 119,
  resetEpochSeconds = Math.floor(Date.now() / 1000) + 60
} = {}) {
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(resetEpochSeconds)
  };
}

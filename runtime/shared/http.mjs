export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
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

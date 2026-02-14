import { createHash } from "node:crypto";

function stableStringify(value) {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function hashRequest(requestShape) {
  const hash = createHash("sha256");
  hash.update(stableStringify(requestShape));
  return hash.digest("hex");
}

export class InMemoryIdempotencyStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.records = new Map();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }

  makeKey({ tenantId, scope, idempotencyKey }) {
    return `${tenantId}::${scope}::${idempotencyKey}`;
  }

  check({ tenantId, scope, idempotencyKey, requestHash }) {
    this.cleanup();
    const key = this.makeKey({ tenantId, scope, idempotencyKey });
    const existing = this.records.get(key);
    if (!existing) {
      return { status: "new", storageKey: key };
    }
    if (existing.requestHash !== requestHash) {
      return { status: "conflict", storageKey: key, record: existing };
    }
    return { status: "replay", storageKey: key, record: existing };
  }

  commit({ storageKey, requestHash, statusCode, responseBody }) {
    const now = Date.now();
    this.records.set(storageKey, {
      requestHash,
      statusCode,
      responseBody,
      createdAt: now,
      expiresAt: now + this.ttlMs
    });
  }
}

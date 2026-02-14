function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapRecord(row) {
  if (!row) {
    return null;
  }
  return {
    requestHash: row.request_hash,
    statusCode: Number(row.response_status),
    responseBody: row.response_body && typeof row.response_body === "object" ? row.response_body : {},
    createdAt: ts(row.created_at),
    expiresAt: ts(row.expires_at)
  };
}

function normalizeStorageKey(storageKey = {}) {
  if (storageKey && typeof storageKey === "object") {
    return {
      tenantId: String(storageKey.tenantId || "").trim(),
      scope: String(storageKey.scope || "").trim(),
      idempotencyKey: String(storageKey.idempotencyKey || "").trim()
    };
  }
  const raw = String(storageKey || "");
  const [tenantId = "", scope = "", idempotencyKey = ""] = raw.split("::");
  return {
    tenantId: tenantId.trim(),
    scope: scope.trim(),
    idempotencyKey: idempotencyKey.trim()
  };
}

export class PgIdempotencyStore {
  constructor({ pool, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.pool = pool;
    this.ttlMs = Math.max(60 * 1000, Number(ttlMs) || 24 * 60 * 60 * 1000);
  }

  async init() {
    return true;
  }

  makeKey({ tenantId, scope, idempotencyKey }) {
    return { tenantId, scope, idempotencyKey };
  }

  async check({ tenantId, scope, idempotencyKey, requestHash }) {
    const storageKey = this.makeKey({ tenantId, scope, idempotencyKey });
    const result = await this.pool.query(
      `
      SELECT request_hash, response_status, response_body, created_at, expires_at
      FROM idempotency_keys
      WHERE tenant_id = $1
        AND scope = $2
        AND idempotency_key = $3
        AND expires_at > now()
      LIMIT 1
      `,
      [tenantId, scope, idempotencyKey]
    );
    const existing = mapRecord(result.rows[0]);
    if (!existing) {
      return { status: "new", storageKey };
    }
    if (existing.requestHash !== requestHash) {
      return { status: "conflict", storageKey, record: existing };
    }
    return { status: "replay", storageKey, record: existing };
  }

  async commit({ storageKey, requestHash, statusCode, responseBody }) {
    const key = normalizeStorageKey(storageKey);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const result = await this.pool.query(
      `
      INSERT INTO idempotency_keys (
        tenant_id, scope, idempotency_key, request_hash, response_status, response_body, created_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, now(), $7::timestamptz
      )
      ON CONFLICT (tenant_id, scope, idempotency_key)
      DO UPDATE SET
        response_status = EXCLUDED.response_status,
        response_body = EXCLUDED.response_body,
        expires_at = EXCLUDED.expires_at
      WHERE idempotency_keys.request_hash = EXCLUDED.request_hash
      RETURNING request_hash, response_status, response_body, created_at, expires_at
      `,
      [
        key.tenantId,
        key.scope,
        key.idempotencyKey,
        requestHash,
        Number(statusCode) || 200,
        JSON.stringify(responseBody || {}),
        expiresAt
      ]
    );

    if (result.rows.length > 0) {
      return mapRecord(result.rows[0]);
    }

    const conflict = await this.pool.query(
      `
      SELECT request_hash, response_status, response_body, created_at, expires_at
      FROM idempotency_keys
      WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3
      LIMIT 1
      `,
      [key.tenantId, key.scope, key.idempotencyKey]
    );
    const existing = mapRecord(conflict.rows[0]);
    if (existing && existing.requestHash !== requestHash) {
      return existing;
    }
    return null;
  }
}

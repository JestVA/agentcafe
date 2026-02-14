import { randomUUID } from "node:crypto";

function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  return status === "ended" ? "ended" : "active";
}

function normalizeText(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function normalizeActorIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const actorId = String(item || "").trim();
    if (!actorId || seen.has(actorId)) {
      continue;
    }
    seen.add(actorId);
    out.push(actorId);
  }
  return out;
}

function normalizeAmountUsd(value, fallback = 0) {
  const parsed = Number(value == null || value === "" ? fallback : value);
  if (!Number.isFinite(parsed)) {
    return Number(fallback) || 0;
  }
  return Math.max(0, Math.round(parsed * 100) / 100);
}

function mapRow(row) {
  if (!row) {
    return null;
  }
  const invited = Array.isArray(row.invited_actor_ids)
    ? row.invited_actor_ids
    : Array.isArray(row.invited_actor_ids?.actors)
      ? row.invited_actor_ids.actors
      : [];
  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    ownerActorId: row.owner_actor_id,
    invitedActorIds: normalizeActorIds(invited),
    status: row.status,
    startedAt: ts(row.started_at),
    expiresAt: ts(row.expires_at),
    endedAt: ts(row.ended_at),
    paymentRef: row.payment_ref || null,
    paymentAmountUsd: Number(row.payment_amount_usd || 0),
    paymentProvider: row.payment_provider || null,
    metadata: asObject(row.metadata),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgTableSessionStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, sessionId }) {
    const result = await this.pool.query(
      `
      SELECT session_id, tenant_id, room_id, owner_actor_id, invited_actor_ids, status, started_at, expires_at, ended_at,
             payment_ref, payment_amount_usd, payment_provider, metadata, created_at, updated_at
      FROM table_sessions
      WHERE tenant_id = $1 AND session_id = $2::uuid
      LIMIT 1
      `,
      [tenantId, sessionId]
    );
    return mapRow(result.rows[0]);
  }

  async create({
    tenantId,
    roomId,
    ownerActorId,
    invitedActorIds = [],
    status = "active",
    startedAt,
    expiresAt,
    paymentRef = null,
    paymentAmountUsd = 0,
    paymentProvider = "stub",
    metadata = {}
  }) {
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();
    const normalizedStatus = normalizeStatus(status);
    const result = await this.pool.query(
      `
      INSERT INTO table_sessions (
        session_id, tenant_id, room_id, owner_actor_id, invited_actor_ids, status,
        started_at, expires_at, ended_at, payment_ref, payment_amount_usd, payment_provider,
        metadata, created_at, updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5::jsonb, $6,
        $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11::numeric, $12,
        $13::jsonb, now(), now()
      )
      RETURNING session_id, tenant_id, room_id, owner_actor_id, invited_actor_ids, status, started_at, expires_at, ended_at,
                payment_ref, payment_amount_usd, payment_provider, metadata, created_at, updated_at
      `,
      [
        sessionId,
        tenantId,
        roomId,
        String(ownerActorId),
        JSON.stringify(normalizeActorIds(invitedActorIds)),
        normalizedStatus,
        normalizeText(startedAt) || nowIso,
        normalizeText(expiresAt),
        normalizedStatus === "ended" ? nowIso : null,
        normalizeText(paymentRef),
        normalizeAmountUsd(paymentAmountUsd, 0),
        normalizeText(paymentProvider) || "stub",
        JSON.stringify(asObject(metadata))
      ]
    );
    return mapRow(result.rows[0]);
  }

  async patch({ tenantId, sessionId, patch }) {
    const existing = await this.get({ tenantId, sessionId });
    if (!existing) {
      return null;
    }

    const status = "status" in patch ? normalizeStatus(patch.status) : existing.status;
    const endedAt =
      status === "ended"
        ? normalizeText("endedAt" in patch ? patch.endedAt : existing.endedAt) || new Date().toISOString()
        : null;

    const result = await this.pool.query(
      `
      UPDATE table_sessions
      SET
        invited_actor_ids = $3::jsonb,
        status = $4,
        started_at = $5::timestamptz,
        expires_at = $6::timestamptz,
        ended_at = $7::timestamptz,
        payment_ref = $8,
        payment_amount_usd = $9::numeric,
        payment_provider = $10,
        metadata = $11::jsonb,
        updated_at = now()
      WHERE tenant_id = $1
        AND session_id = $2::uuid
      RETURNING session_id, tenant_id, room_id, owner_actor_id, invited_actor_ids, status, started_at, expires_at, ended_at,
                payment_ref, payment_amount_usd, payment_provider, metadata, created_at, updated_at
      `,
      [
        tenantId,
        sessionId,
        JSON.stringify(
          "invitedActorIds" in patch ? normalizeActorIds(patch.invitedActorIds) : existing.invitedActorIds
        ),
        status,
        normalizeText("startedAt" in patch ? patch.startedAt : existing.startedAt),
        normalizeText("expiresAt" in patch ? patch.expiresAt : existing.expiresAt),
        endedAt,
        normalizeText("paymentRef" in patch ? patch.paymentRef : existing.paymentRef),
        normalizeAmountUsd(
          "paymentAmountUsd" in patch ? patch.paymentAmountUsd : existing.paymentAmountUsd,
          existing.paymentAmountUsd
        ),
        normalizeText("paymentProvider" in patch ? patch.paymentProvider : existing.paymentProvider),
        JSON.stringify("metadata" in patch ? asObject(patch.metadata) : asObject(existing.metadata))
      ]
    );
    return mapRow(result.rows[0]);
  }

  async list({ tenantId, roomId, ownerActorId, status, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const where = [];
    const params = [];

    if (tenantId) {
      params.push(tenantId);
      where.push(`tenant_id = $${params.length}`);
    }
    if (roomId) {
      params.push(roomId);
      where.push(`room_id = $${params.length}`);
    }
    if (ownerActorId) {
      params.push(ownerActorId);
      where.push(`owner_actor_id = $${params.length}`);
    }
    if (status) {
      params.push(normalizeStatus(status));
      where.push(`status = $${params.length}`);
    }

    params.push(max);
    const sql = `
      SELECT session_id, tenant_id, room_id, owner_actor_id, invited_actor_ids, status, started_at, expires_at, ended_at,
             payment_ref, payment_amount_usd, payment_provider, metadata, created_at, updated_at
      FROM table_sessions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }
}

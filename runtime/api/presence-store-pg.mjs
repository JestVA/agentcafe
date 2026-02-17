function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    status: row.status,
    lastHeartbeatAt: ts(row.last_heartbeat_at),
    ttlMs: Number(row.ttl_ms),
    expiresAt: ts(row.expires_at),
    isActive: Boolean(row.is_active),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgPresenceStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async heartbeat({ tenantId, roomId, actorId, status, ttlMs, nowIso = new Date().toISOString() }) {
    const ttl = Math.max(1000, Number(ttlMs) || 60000);
    const result = await this.pool.query(
      `
      WITH previous AS (
        SELECT status AS previous_status
        FROM presence_states
        WHERE tenant_id = $1 AND room_id = $2 AND actor_id = $3
        LIMIT 1
      )
      INSERT INTO presence_states (
        tenant_id, room_id, actor_id, status, last_heartbeat_at, ttl_ms, expires_at, is_active, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::timestamptz, $6::integer, ($5::timestamptz + ($6::bigint * interval '1 millisecond')), true, now(), now()
      )
      ON CONFLICT (tenant_id, room_id, actor_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        ttl_ms = EXCLUDED.ttl_ms,
        expires_at = EXCLUDED.expires_at,
        is_active = true,
        updated_at = now()
      RETURNING
        tenant_id, room_id, actor_id, status, last_heartbeat_at, ttl_ms, expires_at, is_active, created_at, updated_at,
        (SELECT previous_status FROM previous) AS previous_status
      `,
      [tenantId, roomId, actorId, status, nowIso, ttl]
    );
    const row = result.rows[0];
    const state = mapRow(row);
    const previousStatus = row?.previous_status || null;
    return {
      state,
      previousStatus,
      statusChanged: Boolean(previousStatus && previousStatus !== status)
    };
  }

  async get({ tenantId, roomId, actorId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, actor_id, status, last_heartbeat_at, ttl_ms, expires_at, is_active, created_at, updated_at
      FROM presence_states
      WHERE tenant_id = $1 AND room_id = $2 AND actor_id = $3
      LIMIT 1
      `,
      [tenantId, roomId, actorId]
    );
    return mapRow(result.rows[0]);
  }

  async list({ tenantId, roomId, actorId, active, limit = 200 } = {}) {
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
    if (actorId) {
      params.push(actorId);
      where.push(`actor_id = $${params.length}`);
    }
    if (typeof active === "boolean") {
      params.push(active);
      where.push(`is_active = $${params.length}`);
    }
    params.push(max);
    const sql = `
      SELECT tenant_id, room_id, actor_id, status, last_heartbeat_at, ttl_ms, expires_at, is_active, created_at, updated_at
      FROM presence_states
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }

  async expireDue({ nowIso = new Date().toISOString() } = {}) {
    const result = await this.pool.query(
      `
      WITH due AS (
        SELECT tenant_id, room_id, actor_id, status AS previous_status
        FROM presence_states
        WHERE expires_at <= $1::timestamptz
          AND (is_active = true OR status <> 'inactive')
      )
      UPDATE presence_states p
      SET
        status = 'inactive',
        is_active = false,
        updated_at = $1::timestamptz
      FROM due
      WHERE p.tenant_id = due.tenant_id
        AND p.room_id = due.room_id
        AND p.actor_id = due.actor_id
      RETURNING
        p.tenant_id, p.room_id, p.actor_id, p.status, p.last_heartbeat_at, p.ttl_ms, p.expires_at, p.is_active, p.created_at, p.updated_at,
        due.previous_status
      `,
      [nowIso]
    );
    return result.rows.map((row) => ({
      state: mapRow(row),
      previousStatus: row.previous_status || null
    }));
  }

  async setInactive({ tenantId, roomId, actorId, nowIso = new Date().toISOString() }) {
    const result = await this.pool.query(
      `
      WITH previous AS (
        SELECT status AS previous_status
        FROM presence_states
        WHERE tenant_id = $1 AND room_id = $2 AND actor_id = $3
        LIMIT 1
      )
      UPDATE presence_states p
      SET
        status = 'inactive',
        is_active = false,
        updated_at = $4::timestamptz
      FROM previous
      WHERE p.tenant_id = $1
        AND p.room_id = $2
        AND p.actor_id = $3
      RETURNING
        p.tenant_id, p.room_id, p.actor_id, p.status, p.last_heartbeat_at, p.ttl_ms, p.expires_at, p.is_active, p.created_at, p.updated_at,
        previous.previous_status
      `,
      [tenantId, roomId, actorId, nowIso]
    );
    const state = mapRow(result.rows[0]);
    if (!state) {
      return null;
    }
    const previousStatus = result.rows[0]?.previous_status || null;
    return {
      state,
      previousStatus,
      statusChanged: previousStatus !== "inactive"
    };
  }
}

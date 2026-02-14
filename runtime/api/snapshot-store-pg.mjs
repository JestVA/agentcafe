function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mapSnapshot(row, scope) {
  if (!row) {
    return null;
  }
  return {
    scope,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id || null,
    version: Number(row.snapshot_version),
    state: row.snapshot && typeof row.snapshot === "object" ? safeClone(row.snapshot) : {},
    createdAt: ts(row.created_at),
    expiresAt: ts(row.expires_at)
  };
}

function ttlToExpiry(ttlSeconds = 3600) {
  const seconds = Number(ttlSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isUniqueViolation(error) {
  return error && typeof error === "object" && error.code === "23505";
}

async function insertRoomSnapshotRow(pool, { tenantId, roomId, snapshot, expiresAt }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await pool.query(
        `
        INSERT INTO room_snapshots (
          tenant_id, room_id, snapshot_version, snapshot, created_at, expires_at
        )
        SELECT
          $1, $2,
          COALESCE((SELECT MAX(snapshot_version) FROM room_snapshots WHERE tenant_id = $1 AND room_id = $2), 0) + 1,
          $3::jsonb, now(), $4::timestamptz
        RETURNING tenant_id, room_id, NULL::text AS actor_id, snapshot_version, snapshot, created_at, expires_at
        `,
        [tenantId, roomId, snapshot, expiresAt]
      );
      if (result.rows[0]) {
        return result.rows[0];
      }
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 4) {
        throw error;
      }
    }
  }
  throw new Error("failed to insert room snapshot after retries");
}

async function insertAgentSnapshotRow(pool, { tenantId, roomId, actorId, snapshot, expiresAt }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await pool.query(
        `
        INSERT INTO agent_snapshots (
          tenant_id, room_id, actor_id, snapshot_version, snapshot, created_at, expires_at
        )
        SELECT
          $1, $2, $3,
          COALESCE(
            (
              SELECT MAX(snapshot_version)
              FROM agent_snapshots
              WHERE tenant_id = $1 AND room_id = $2 AND actor_id = $3
            ),
            0
          ) + 1,
          $4::jsonb, now(), $5::timestamptz
        RETURNING tenant_id, room_id, actor_id, snapshot_version, snapshot, created_at, expires_at
        `,
        [tenantId, roomId, actorId, snapshot, expiresAt]
      );
      if (result.rows[0]) {
        return result.rows[0];
      }
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 4) {
        throw error;
      }
    }
  }
  throw new Error("failed to insert agent snapshot after retries");
}

export class PgSnapshotStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async createRoomSnapshot({ tenantId, roomId, state, ttlSeconds = 3600 }) {
    const expiresAt = ttlToExpiry(ttlSeconds);
    const row = await insertRoomSnapshotRow(this.pool, {
      tenantId,
      roomId,
      snapshot: JSON.stringify(state || {}),
      expiresAt
    });
    return mapSnapshot(row, "room");
  }

  async createAgentSnapshot({ tenantId, roomId, actorId, state, ttlSeconds = 3600 }) {
    const expiresAt = ttlToExpiry(ttlSeconds);
    const row = await insertAgentSnapshotRow(this.pool, {
      tenantId,
      roomId,
      actorId,
      snapshot: JSON.stringify(state || {}),
      expiresAt
    });
    return mapSnapshot(row, "agent");
  }

  async findRoom({ tenantId, roomId, version }) {
    const hasVersion = version != null && version !== "";
    const params = [tenantId, roomId];
    if (hasVersion) {
      params.push(Number(version));
    }
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, NULL::text AS actor_id, snapshot_version, snapshot, created_at, expires_at
      FROM room_snapshots
      WHERE tenant_id = $1
        AND room_id = $2
        ${hasVersion ? "AND snapshot_version = $3" : ""}
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY snapshot_version DESC
      LIMIT 1
      `,
      params
    );
    return mapSnapshot(result.rows[0], "room");
  }

  async findAgent({ tenantId, roomId, actorId, version }) {
    const hasVersion = version != null && version !== "";
    const params = [tenantId, roomId, actorId];
    if (hasVersion) {
      params.push(Number(version));
    }
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, actor_id, snapshot_version, snapshot, created_at, expires_at
      FROM agent_snapshots
      WHERE tenant_id = $1
        AND room_id = $2
        AND actor_id = $3
        ${hasVersion ? "AND snapshot_version = $4" : ""}
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY snapshot_version DESC
      LIMIT 1
      `,
      params
    );
    return mapSnapshot(result.rows[0], "agent");
  }
}

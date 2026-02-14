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

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    roomId: row.room_id,
    roomType: row.room_type,
    displayName: row.display_name || null,
    ownerActorId: row.owner_actor_id || null,
    metadata: asObject(row.metadata),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

function normalizeRoomType(value) {
  const roomType = String(value || "lobby").trim().toLowerCase();
  return roomType === "private_table" ? "private_table" : "lobby";
}

function normalizeText(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

export class PgRoomStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, roomId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, room_type, display_name, owner_actor_id, metadata, created_at, updated_at
      FROM rooms
      WHERE tenant_id = $1 AND room_id = $2
      LIMIT 1
      `,
      [tenantId, roomId]
    );
    return mapRow(result.rows[0]);
  }

  async upsert({
    tenantId,
    roomId,
    roomType = "lobby",
    displayName = null,
    ownerActorId = null,
    metadata = {}
  }) {
    const result = await this.pool.query(
      `
      INSERT INTO rooms (
        tenant_id, room_id, room_type, display_name, owner_actor_id, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, now(), now()
      )
      ON CONFLICT (tenant_id, room_id)
      DO UPDATE SET
        room_type = EXCLUDED.room_type,
        display_name = EXCLUDED.display_name,
        owner_actor_id = EXCLUDED.owner_actor_id,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING tenant_id, room_id, room_type, display_name, owner_actor_id, metadata, created_at, updated_at
      `,
      [
        tenantId,
        roomId,
        normalizeRoomType(roomType),
        normalizeText(displayName),
        normalizeText(ownerActorId),
        JSON.stringify(asObject(metadata))
      ]
    );
    return mapRow(result.rows[0]);
  }

  async list({ tenantId, roomType, ownerActorId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const where = [];
    const params = [];

    if (tenantId) {
      params.push(tenantId);
      where.push(`tenant_id = $${params.length}`);
    }
    if (roomType) {
      params.push(normalizeRoomType(roomType));
      where.push(`room_type = $${params.length}`);
    }
    if (ownerActorId) {
      params.push(ownerActorId);
      where.push(`owner_actor_id = $${params.length}`);
    }

    params.push(max);
    const sql = `
      SELECT tenant_id, room_id, room_type, display_name, owner_actor_id, metadata, created_at, updated_at
      FROM rooms
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }
}

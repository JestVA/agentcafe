function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapPin(row) {
  if (!row) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    roomId: row.room_id,
    version: Number(row.version),
    content: row.content,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    pinnedBy: row.pinned_by,
    isActive: Boolean(row.is_active),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgPinnedContextStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, roomId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, version, content, metadata, pinned_by, is_active, created_at, updated_at
      FROM room_context_pins
      WHERE tenant_id = $1 AND room_id = $2 AND is_active = true
      ORDER BY version DESC
      LIMIT 1
      `,
      [tenantId, roomId]
    );
    return mapPin(result.rows[0]);
  }

  async upsert({ tenantId, roomId, actorId, content, metadata = {} }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const nextVersionResult = await client.query(
        `
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM room_context_pins
        WHERE tenant_id = $1 AND room_id = $2
        `,
        [tenantId, roomId]
      );
      const version = Number(nextVersionResult.rows[0]?.next_version || 1);

      await client.query(
        `
        UPDATE room_context_pins
        SET is_active = false, updated_at = now()
        WHERE tenant_id = $1 AND room_id = $2 AND is_active = true
        `,
        [tenantId, roomId]
      );

      const inserted = await client.query(
        `
        INSERT INTO room_context_pins (
          tenant_id, room_id, version, content, metadata, pinned_by, is_active, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6, true, now(), now()
        )
        RETURNING tenant_id, room_id, version, content, metadata, pinned_by, is_active, created_at, updated_at
        `,
        [tenantId, roomId, version, content, JSON.stringify(metadata || {}), actorId]
      );
      await client.query("COMMIT");
      return mapPin(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listHistory({ tenantId, roomId, limit = 50 }) {
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, version, content, metadata, pinned_by, is_active, created_at, updated_at
      FROM room_context_pins
      WHERE tenant_id = $1 AND room_id = $2
      ORDER BY version DESC
      LIMIT $3
      `,
      [tenantId, roomId, max]
    );
    return result.rows.map(mapPin);
  }
}

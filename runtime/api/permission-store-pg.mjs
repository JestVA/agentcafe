const DEFAULT_PERMISSIONS = {
  canMove: true,
  canSpeak: true,
  canOrder: true,
  canEnterLeave: true,
  canModerate: false
};

function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapRow(row, source = "custom") {
  if (!row) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.agent_id,
    canMove: Boolean(row.can_move),
    canSpeak: Boolean(row.can_speak),
    canOrder: Boolean(row.can_order),
    canEnterLeave: Boolean(row.can_enter_leave),
    canModerate: Boolean(row.can_moderate),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    source
  };
}

export class PgPermissionStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, roomId, actorId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, agent_id, can_move, can_speak, can_order, can_enter_leave, can_moderate, created_at, updated_at
      FROM permissions
      WHERE tenant_id = $1 AND room_id = $2 AND agent_id = $3
      LIMIT 1
      `,
      [tenantId, roomId, actorId]
    );
    const row = result.rows[0];
    if (!row) {
      return {
        tenantId,
        roomId,
        actorId,
        ...DEFAULT_PERMISSIONS,
        createdAt: null,
        updatedAt: null,
        source: "default"
      };
    }
    return mapRow(row, "custom");
  }

  async upsert({ tenantId, roomId, actorId, patch }) {
    const existing = await this.get({ tenantId, roomId, actorId });
    const next = {
      canMove: patch.canMove ?? existing.canMove,
      canSpeak: patch.canSpeak ?? existing.canSpeak,
      canOrder: patch.canOrder ?? existing.canOrder,
      canEnterLeave: patch.canEnterLeave ?? existing.canEnterLeave,
      canModerate: patch.canModerate ?? existing.canModerate
    };

    const result = await this.pool.query(
      `
      INSERT INTO permissions (
        tenant_id, agent_id, room_id, can_move, can_speak, can_order, can_enter_leave, can_moderate, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, now(), now()
      )
      ON CONFLICT (tenant_id, agent_id, room_id)
      DO UPDATE SET
        can_move = EXCLUDED.can_move,
        can_speak = EXCLUDED.can_speak,
        can_order = EXCLUDED.can_order,
        can_enter_leave = EXCLUDED.can_enter_leave,
        can_moderate = EXCLUDED.can_moderate,
        updated_at = now()
      RETURNING tenant_id, room_id, agent_id, can_move, can_speak, can_order, can_enter_leave, can_moderate, created_at, updated_at
      `,
      [
        tenantId,
        actorId,
        roomId,
        next.canMove,
        next.canSpeak,
        next.canOrder,
        next.canEnterLeave,
        next.canModerate
      ]
    );
    return mapRow(result.rows[0], "custom");
  }

  async list({ tenantId, roomId, actorId, limit = 200 } = {}) {
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
      where.push(`agent_id = $${params.length}`);
    }

    params.push(max);
    const sql = `
      SELECT tenant_id, room_id, agent_id, can_move, can_speak, can_order, can_enter_leave, can_moderate, created_at, updated_at
      FROM permissions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => mapRow(row, "custom"));
  }
}

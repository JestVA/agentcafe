import { OPERATOR_ACTIONS } from "./operator-policy.mjs";

function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function normalizeMutedActors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function mapRoom(row) {
  if (!row) {
    return null;
  }
  const mutedActors = normalizeMutedActors(row.muted_actors);
  return {
    tenantId: row.tenant_id,
    roomId: row.room_id,
    roomPaused: Boolean(row.room_paused),
    pausedBy: row.paused_by || null,
    pauseReason: row.pause_reason || null,
    pausedAt: ts(row.paused_at),
    resumedAt: ts(row.resumed_at),
    mutedActors,
    mutedActorIds: Object.keys(mutedActors),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgOperatorOverrideStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async getRoomState({ tenantId, roomId }) {
    const result = await this.pool.query(
      `
      SELECT tenant_id, room_id, room_paused, paused_by, pause_reason, paused_at, resumed_at, muted_actors, metadata, created_at, updated_at
      FROM operator_room_overrides
      WHERE tenant_id = $1 AND room_id = $2
      LIMIT 1
      `,
      [tenantId, roomId]
    );
    const row = mapRoom(result.rows[0]);
    if (row) {
      return row;
    }
    return {
      tenantId,
      roomId,
      roomPaused: false,
      pausedBy: null,
      pauseReason: null,
      pausedAt: null,
      resumedAt: null,
      mutedActors: {},
      mutedActorIds: [],
      metadata: {},
      createdAt: null,
      updatedAt: null
    };
  }

  async list({ tenantId, roomId, limit = 200 } = {}) {
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
    params.push(max);
    const sql = `
      SELECT tenant_id, room_id, room_paused, paused_by, pause_reason, paused_at, resumed_at, muted_actors, metadata, created_at, updated_at
      FROM operator_room_overrides
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => mapRoom(row));
  }

  async applyAction({
    tenantId,
    roomId,
    operatorId,
    action,
    targetActorId = null,
    reason = null,
    metadata = {},
    nowIso = new Date().toISOString()
  }) {
    const current = await this.getRoomState({ tenantId, roomId });
    const next = {
      ...current,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      updatedAt: nowIso
    };
    const safeReason = reason == null || reason === "" ? null : String(reason);
    const safeTarget = targetActorId == null || targetActorId === "" ? null : String(targetActorId);

    if (action === OPERATOR_ACTIONS.PAUSE_ROOM) {
      next.roomPaused = true;
      next.pausedBy = String(operatorId);
      next.pauseReason = safeReason;
      next.pausedAt = nowIso;
      next.resumedAt = null;
    } else if (action === OPERATOR_ACTIONS.RESUME_ROOM) {
      next.roomPaused = false;
      next.resumedAt = nowIso;
    } else if (action === OPERATOR_ACTIONS.MUTE_AGENT) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for mute_agent");
      }
      next.mutedActors = next.mutedActors || {};
      next.mutedActors[safeTarget] = {
        actorId: safeTarget,
        mutedBy: String(operatorId),
        mutedAt: nowIso,
        reason: safeReason
      };
      next.mutedActorIds = Object.keys(next.mutedActors);
    } else if (action === OPERATOR_ACTIONS.UNMUTE_AGENT) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for unmute_agent");
      }
      next.mutedActors = next.mutedActors || {};
      delete next.mutedActors[safeTarget];
      next.mutedActorIds = Object.keys(next.mutedActors);
    } else if (action === OPERATOR_ACTIONS.FORCE_LEAVE) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for force_leave");
      }
    } else {
      throw new Error(`unsupported operator action: ${action}`);
    }

    const result = await this.pool.query(
      `
      INSERT INTO operator_room_overrides (
        tenant_id, room_id, room_paused, paused_by, pause_reason, paused_at, resumed_at, muted_actors, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb, $9::jsonb, now(), now()
      )
      ON CONFLICT (tenant_id, room_id)
      DO UPDATE SET
        room_paused = EXCLUDED.room_paused,
        paused_by = EXCLUDED.paused_by,
        pause_reason = EXCLUDED.pause_reason,
        paused_at = EXCLUDED.paused_at,
        resumed_at = EXCLUDED.resumed_at,
        muted_actors = EXCLUDED.muted_actors,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING tenant_id, room_id, room_paused, paused_by, pause_reason, paused_at, resumed_at, muted_actors, metadata, created_at, updated_at
      `,
      [
        tenantId,
        roomId,
        next.roomPaused,
        next.pausedBy,
        next.pauseReason,
        next.pausedAt,
        next.resumedAt,
        JSON.stringify(next.mutedActors || {}),
        JSON.stringify(next.metadata || {})
      ]
    );

    return {
      state: mapRoom(result.rows[0]),
      action: {
        action,
        operatorId: String(operatorId),
        targetActorId: safeTarget,
        reason: safeReason,
        metadata: metadata && typeof metadata === "object" ? metadata : {},
        at: nowIso
      }
    };
  }
}

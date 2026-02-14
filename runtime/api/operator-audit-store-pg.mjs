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

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    auditSeq: Number(row.audit_seq),
    tenantId: row.tenant_id,
    roomId: row.room_id,
    operatorId: row.operator_id,
    action: row.action,
    targetActorId: row.target_actor_id || null,
    reason: row.reason || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    correlationId: row.correlation_id || null,
    requestId: row.request_id || null,
    outcome: row.outcome,
    eventId: row.event_id || null,
    createdAt: ts(row.created_at)
  };
}

export class PgOperatorAuditStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async append({
    tenantId,
    roomId,
    operatorId,
    action,
    targetActorId = null,
    reason = null,
    metadata = {},
    correlationId = null,
    requestId = null,
    outcome = "applied",
    eventId = null
  }) {
    const result = await this.pool.query(
      `
      INSERT INTO operator_audit_log (
        id, tenant_id, room_id, operator_id, action, target_actor_id, reason, metadata, correlation_id, request_id, outcome, event_id, created_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid, $10, $11, $12::uuid, now()
      )
      RETURNING id, audit_seq, tenant_id, room_id, operator_id, action, target_actor_id, reason, metadata, correlation_id, request_id, outcome, event_id, created_at
      `,
      [
        randomUUID(),
        tenantId,
        roomId,
        operatorId,
        action,
        targetActorId,
        reason,
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
        correlationId,
        requestId,
        outcome,
        eventId
      ]
    );
    return mapRow(result.rows[0]);
  }

  async list({
    tenantId,
    roomId,
    operatorId,
    action,
    fromTs,
    toTs,
    cursor,
    limit = 100,
    order = "desc"
  } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 1000));
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
    if (operatorId) {
      params.push(operatorId);
      where.push(`operator_id = $${params.length}`);
    }
    if (action) {
      params.push(action);
      where.push(`action = $${params.length}`);
    }
    if (fromTs) {
      params.push(fromTs);
      where.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (toTs) {
      params.push(toTs);
      where.push(`created_at <= $${params.length}::timestamptz`);
    }

    const dir = order === "asc" ? "ASC" : "DESC";
    const cursorNum = Number(cursor);
    if (Number.isFinite(cursorNum)) {
      params.push(cursorNum);
      where.push(`audit_seq ${dir === "ASC" ? ">" : "<"} $${params.length}`);
    }

    params.push(max);
    const sql = `
      SELECT id, audit_seq, tenant_id, room_id, operator_id, action, target_actor_id, reason, metadata, correlation_id, request_id, outcome, event_id, created_at
      FROM operator_audit_log
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY audit_seq ${dir}
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => mapRow(row));
  }
}

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

function normalizeTypes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return ["*"];
  }
  const out = value.map((item) => String(item).trim()).filter(Boolean);
  return out.length ? out : ["*"];
}

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    sourceActorId: row.source_actor_id,
    targetActorId: row.target_actor_id,
    triggerEventTypes: Array.isArray(row.trigger_event_types) ? row.trigger_event_types : ["*"],
    actionType: row.action_type,
    actionPayload: row.action_payload && typeof row.action_payload === "object" ? row.action_payload : {},
    enabled: Boolean(row.enabled),
    cooldownMs: Number(row.cooldown_ms),
    ignoreSelf: Boolean(row.ignore_self),
    ignoreReactionEvents: Boolean(row.ignore_reaction_events),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    triggerCount: Number(row.trigger_count || 0),
    errorCount: Number(row.error_count || 0),
    lastTriggeredAt: ts(row.last_triggered_at),
    lastSourceEventId: row.last_source_event_id || null,
    lastError: row.last_error || null,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgReactionStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async list({ tenantId, roomId, eventType, enabled, sourceActorId, targetActorId } = {}) {
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
    if (eventType) {
      params.push(eventType);
      where.push(`('*' = ANY(trigger_event_types) OR $${params.length} = ANY(trigger_event_types))`);
    }
    if (typeof enabled === "boolean") {
      params.push(enabled);
      where.push(`enabled = $${params.length}`);
    }
    if (sourceActorId) {
      params.push(sourceActorId);
      where.push(`source_actor_id = $${params.length}`);
    }
    if (targetActorId) {
      params.push(targetActorId);
      where.push(`target_actor_id = $${params.length}`);
    }
    const sql = `
      SELECT *
      FROM reaction_subscriptions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }

  async getById(id) {
    const result = await this.pool.query(`SELECT * FROM reaction_subscriptions WHERE id = $1::uuid LIMIT 1`, [id]);
    return mapRow(result.rows[0]);
  }

  async create(input) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      tenantId: input.tenantId || "default",
      roomId: input.roomId || null,
      sourceActorId: input.sourceActorId || null,
      targetActorId: input.targetActorId,
      triggerEventTypes: normalizeTypes(input.triggerEventTypes),
      actionType: input.actionType,
      actionPayload: input.actionPayload && typeof input.actionPayload === "object" ? input.actionPayload : {},
      enabled: input.enabled !== false,
      cooldownMs: Number.isFinite(Number(input.cooldownMs)) ? Number(input.cooldownMs) : 1000,
      ignoreSelf: input.ignoreSelf !== false,
      ignoreReactionEvents: input.ignoreReactionEvents !== false,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: now,
      updatedAt: now
    };

    const result = await this.pool.query(
      `
      INSERT INTO reaction_subscriptions (
        id, tenant_id, room_id, source_actor_id, target_actor_id, trigger_event_types,
        action_type, action_payload, enabled, cooldown_ms, ignore_self, ignore_reaction_events,
        metadata, trigger_count, error_count, last_triggered_at, last_source_event_id, last_error,
        created_at, updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9, $10, $11, $12,
        $13::jsonb, 0, 0, null, null, null, $14::timestamptz, $15::timestamptz
      )
      RETURNING *
      `,
      [
        record.id,
        record.tenantId,
        record.roomId,
        record.sourceActorId,
        record.targetActorId,
        record.triggerEventTypes,
        record.actionType,
        JSON.stringify(record.actionPayload),
        record.enabled,
        record.cooldownMs,
        record.ignoreSelf,
        record.ignoreReactionEvents,
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt
      ]
    );
    return mapRow(result.rows[0]);
  }

  async update(id, patch) {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      tenantId: existing.tenantId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };
    if ("triggerEventTypes" in patch) {
      next.triggerEventTypes = normalizeTypes(patch.triggerEventTypes);
    }

    const result = await this.pool.query(
      `
      UPDATE reaction_subscriptions
      SET
        room_id = $2,
        source_actor_id = $3,
        target_actor_id = $4,
        trigger_event_types = $5::text[],
        action_type = $6,
        action_payload = $7::jsonb,
        enabled = $8,
        cooldown_ms = $9,
        ignore_self = $10,
        ignore_reaction_events = $11,
        metadata = $12::jsonb,
        updated_at = $13::timestamptz
      WHERE id = $1::uuid
      RETURNING *
      `,
      [
        id,
        next.roomId,
        next.sourceActorId,
        next.targetActorId,
        next.triggerEventTypes,
        next.actionType,
        JSON.stringify(next.actionPayload || {}),
        next.enabled,
        Number(next.cooldownMs),
        Boolean(next.ignoreSelf),
        Boolean(next.ignoreReactionEvents),
        JSON.stringify(next.metadata || {}),
        next.updatedAt
      ]
    );
    return mapRow(result.rows[0]);
  }

  async delete(id) {
    const result = await this.pool.query(`DELETE FROM reaction_subscriptions WHERE id = $1::uuid`, [id]);
    return result.rowCount > 0;
  }

  async recordTrigger(id, { success, sourceEventId, error = null } = {}) {
    if (success) {
      const result = await this.pool.query(
        `
        UPDATE reaction_subscriptions
        SET
          trigger_count = trigger_count + 1,
          last_triggered_at = now(),
          last_source_event_id = $2::uuid,
          last_error = null,
          updated_at = now()
        WHERE id = $1::uuid
        RETURNING *
        `,
        [id, sourceEventId || null]
      );
      return mapRow(result.rows[0]);
    }

    const result = await this.pool.query(
      `
      UPDATE reaction_subscriptions
      SET
        error_count = error_count + 1,
        last_source_event_id = COALESCE($3::uuid, last_source_event_id),
        last_error = $2,
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING *
      `,
      [id, error || "reaction failed", sourceEventId || null]
    );
    return mapRow(result.rows[0]);
  }
}

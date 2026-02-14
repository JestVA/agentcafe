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

function mapSubscription(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    eventTypes: Array.isArray(row.event_types) ? row.event_types : ["*"],
    targetUrl: row.target_url,
    secret: row.secret,
    enabled: Boolean(row.enabled),
    maxRetries: Number(row.max_retries),
    backoffMs: Number(row.backoff_ms),
    timeoutMs: Number(row.timeout_ms),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    lastDeliveredAt: ts(row.last_delivered_at),
    lastError: row.last_error
  };
}

function mapDelivery(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    success: Boolean(row.success),
    attempt: Number(row.attempt),
    source: row.source,
    dlqId: row.dlq_id || null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    statusCode: row.status_code == null ? null : Number(row.status_code),
    error: row.error || null,
    createdAt: ts(row.created_at)
  };
}

function mapDlq(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    error: row.error,
    status: row.status,
    replayCount: Number(row.replay_count || 0),
    replayedAt: ts(row.replayed_at),
    lastReplayError: row.last_replay_error || null,
    createdAt: ts(row.created_at)
  };
}

export class PgSubscriptionStore {
  constructor({ pool, maxDlqItems = 1000, maxDeliveryItems = 10000 } = {}) {
    this.pool = pool;
    this.maxDlqItems = maxDlqItems;
    this.maxDeliveryItems = maxDeliveryItems;
  }

  async init() {
    return true;
  }

  async list({ tenantId, roomId, eventType, enabled } = {}) {
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
      where.push(`('*' = ANY(event_types) OR $${params.length} = ANY(event_types))`);
    }
    if (typeof enabled === "boolean") {
      params.push(enabled);
      where.push(`enabled = $${params.length}`);
    }

    const sql = `
      SELECT *
      FROM webhook_subscriptions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapSubscription);
  }

  async getById(id) {
    const result = await this.pool.query(
      `SELECT * FROM webhook_subscriptions WHERE id = $1 LIMIT 1`,
      [id]
    );
    return mapSubscription(result.rows[0]);
  }

  async create(input) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      tenantId: input.tenantId || "default",
      roomId: input.roomId || null,
      actorId: input.actorId || null,
      eventTypes: input.eventTypes && input.eventTypes.length ? [...input.eventTypes] : ["*"],
      targetUrl: input.targetUrl,
      secret: input.secret,
      enabled: input.enabled !== false,
      maxRetries: Number.isFinite(Number(input.maxRetries)) ? Number(input.maxRetries) : 3,
      backoffMs: Number.isFinite(Number(input.backoffMs)) ? Number(input.backoffMs) : 1000,
      timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : 5000,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: now,
      updatedAt: now
    };

    const result = await this.pool.query(
      `
      INSERT INTO webhook_subscriptions (
        id, tenant_id, room_id, actor_id, event_types, target_url, secret,
        enabled, max_retries, backoff_ms, timeout_ms, metadata,
        created_at, updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12::jsonb, $13::timestamptz, $14::timestamptz
      )
      RETURNING *
      `,
      [
        record.id,
        record.tenantId,
        record.roomId,
        record.actorId,
        record.eventTypes,
        record.targetUrl,
        record.secret,
        record.enabled,
        record.maxRetries,
        record.backoffMs,
        record.timeoutMs,
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt
      ]
    );
    return mapSubscription(result.rows[0]);
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
    if (patch.eventTypes && Array.isArray(patch.eventTypes)) {
      next.eventTypes = [...patch.eventTypes];
    }

    const result = await this.pool.query(
      `
      UPDATE webhook_subscriptions
      SET
        room_id = $2,
        actor_id = $3,
        event_types = $4::text[],
        target_url = $5,
        secret = $6,
        enabled = $7,
        max_retries = $8,
        backoff_ms = $9,
        timeout_ms = $10,
        metadata = $11::jsonb,
        updated_at = $12::timestamptz
      WHERE id = $1::uuid
      RETURNING *
      `,
      [
        id,
        next.roomId,
        next.actorId,
        next.eventTypes,
        next.targetUrl,
        next.secret,
        next.enabled,
        Number(next.maxRetries),
        Number(next.backoffMs),
        Number(next.timeoutMs),
        JSON.stringify(next.metadata || {}),
        next.updatedAt
      ]
    );
    return mapSubscription(result.rows[0]);
  }

  async delete(id) {
    const result = await this.pool.query(`DELETE FROM webhook_subscriptions WHERE id = $1::uuid`, [id]);
    return result.rowCount > 0;
  }

  async recordDelivery(subscriptionId, { success, error }) {
    if (success) {
      await this.pool.query(
        `UPDATE webhook_subscriptions
         SET last_delivered_at = now(), last_error = null, updated_at = now()
         WHERE id = $1::uuid`,
        [subscriptionId]
      );
      return;
    }

    await this.pool.query(
      `UPDATE webhook_subscriptions
       SET last_error = $2, updated_at = now()
       WHERE id = $1::uuid`,
      [subscriptionId, error || "delivery failed"]
    );
  }

  async addDeliveryAttempt(entry) {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const result = await this.pool.query(
      `
      INSERT INTO webhook_deliveries (
        id, subscription_id, event_id, event_type, tenant_id, room_id, actor_id,
        success, attempt, source, dlq_id, duration_ms, status_code, error, created_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13, $14, $15::timestamptz
      )
      RETURNING *
      `,
      [
        id,
        entry.subscriptionId,
        entry.eventId,
        entry.eventType,
        entry.tenantId,
        entry.roomId,
        entry.actorId,
        Boolean(entry.success),
        Number(entry.attempt || 1),
        entry.source || "live",
        entry.dlqId || null,
        entry.durationMs == null ? null : Number(entry.durationMs),
        entry.statusCode == null ? null : Number(entry.statusCode),
        entry.error || null,
        createdAt
      ]
    );
    return mapDelivery(result.rows[0]);
  }

  async listDeliveries({ subscriptionId, eventId, success, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, this.maxDeliveryItems));
    const where = [];
    const params = [];

    if (subscriptionId) {
      params.push(subscriptionId);
      where.push(`subscription_id = $${params.length}::uuid`);
    }
    if (eventId) {
      params.push(eventId);
      where.push(`event_id = $${params.length}::uuid`);
    }
    if (typeof success === "boolean") {
      params.push(success);
      where.push(`success = $${params.length}`);
    }
    params.push(max);

    const sql = `
      SELECT *
      FROM webhook_deliveries
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapDelivery);
  }

  async listDlq(limit = 100) {
    const max = Math.max(1, Math.min(Number(limit) || 100, this.maxDlqItems));
    const result = await this.pool.query(
      `
      SELECT *
      FROM webhook_dlq
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [max]
    );
    return result.rows.map(mapDlq);
  }

  async getDlqById(id) {
    const result = await this.pool.query(`SELECT * FROM webhook_dlq WHERE id = $1::uuid LIMIT 1`, [id]);
    return mapDlq(result.rows[0]);
  }

  async pushDlq(entry) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const result = await this.pool.query(
      `
      INSERT INTO webhook_dlq (
        id, subscription_id, event_id, event_type, tenant_id, room_id, actor_id, payload, error, status, replay_count, replayed_at, last_replay_error, created_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9, 'open', 0, null, null, $10::timestamptz
      )
      RETURNING *
      `,
      [
        id,
        entry.subscriptionId,
        entry.eventId,
        entry.eventType,
        entry.tenantId,
        entry.roomId,
        entry.actorId,
        JSON.stringify(entry.payload || {}),
        entry.error || "delivery failed",
        createdAt
      ]
    );
    return mapDlq(result.rows[0]);
  }

  async markDlqReplayed(id, { success, error } = {}) {
    const result = await this.pool.query(
      `
      UPDATE webhook_dlq
      SET
        replay_count = replay_count + 1,
        replayed_at = now(),
        status = CASE WHEN $2 THEN 'resolved' ELSE 'open' END,
        last_replay_error = CASE WHEN $2 THEN null ELSE $3 END
      WHERE id = $1::uuid
      RETURNING *
      `,
      [id, Boolean(success), error || "replay failed"]
    );
    return mapDlq(result.rows[0]);
  }
}

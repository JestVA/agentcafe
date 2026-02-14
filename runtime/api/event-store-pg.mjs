function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function normalizeUuid(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }
  return null;
}

function mapEvent(row) {
  if (!row) {
    return null;
  }
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    type: row.type,
    timestamp: ts(row.created_at),
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    correlationId: row.correlation_id || null,
    causationId: row.causation_id || null
  };
}

export class PgEventStore {
  constructor({ pool } = {}) {
    this.pool = pool;
    this.subscribers = new Set();
  }

  async init() {
    return true;
  }

  async append(event) {
    const sql = `
      INSERT INTO events (
        event_id, tenant_id, room_id, actor_id, type, payload, correlation_id, causation_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid, $8::uuid, $9::timestamptz)
      RETURNING sequence, event_id, tenant_id, room_id, actor_id, type, payload, correlation_id, causation_id, created_at
    `;
    const params = [
      event.eventId,
      event.tenantId,
      event.roomId,
      event.actorId,
      event.type,
      JSON.stringify(event.payload || {}),
      normalizeUuid(event.correlationId),
      normalizeUuid(event.causationId),
      event.timestamp || new Date().toISOString()
    ];
    const result = await this.pool.query(sql, params);
    const persisted = mapEvent(result.rows[0]);
    this.publish(persisted);
    return persisted;
  }

  async getById(eventId) {
    const result = await this.pool.query(
      `SELECT sequence, event_id, tenant_id, room_id, actor_id, type, payload, correlation_id, causation_id, created_at
       FROM events
       WHERE event_id = $1
       LIMIT 1`,
      [eventId]
    );
    return mapEvent(result.rows[0]);
  }

  async list({
    tenantId,
    roomId,
    actorId,
    afterEventId,
    afterCursor,
    limit = 100,
    types,
    fromTs,
    toTs,
    order = "asc"
  } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 5000));
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
    if (Array.isArray(types) && types.length) {
      params.push(types.map((value) => String(value).trim()).filter(Boolean));
      where.push(`type = ANY($${params.length}::text[])`);
    }
    if (fromTs) {
      params.push(fromTs);
      where.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (toTs) {
      params.push(toTs);
      where.push(`created_at <= $${params.length}::timestamptz`);
    }

    const dir = order === "desc" ? "DESC" : "ASC";
    const cursorValue = Number(afterCursor);
    if (Number.isFinite(cursorValue)) {
      params.push(cursorValue);
      where.push(`sequence ${dir === "DESC" ? "<" : ">"} $${params.length}`);
    } else if (afterEventId) {
      params.push(afterEventId);
      where.push(
        `sequence ${dir === "DESC" ? "<" : ">"} COALESCE((SELECT sequence FROM events WHERE event_id = $${params.length}), 0)`
      );
    }

    params.push(max);
    const sql = `
      SELECT sequence, event_id, tenant_id, room_id, actor_id, type, payload, correlation_id, causation_id, created_at
      FROM events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sequence ${dir}
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapEvent);
  }

  publish(event) {
    for (const sub of this.subscribers) {
      if (sub.tenantId && sub.tenantId !== event.tenantId) {
        continue;
      }
      if (sub.roomId && sub.roomId !== event.roomId) {
        continue;
      }
      if (sub.actorId && sub.actorId !== event.actorId) {
        continue;
      }
      if (sub.types?.length && !sub.types.includes(event.type)) {
        continue;
      }
      try {
        sub.onEvent(event);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  subscribe({ tenantId, roomId, actorId, types, onEvent }) {
    const sub = {
      tenantId: tenantId || null,
      roomId: roomId || null,
      actorId: actorId || null,
      types: Array.isArray(types) && types.length ? types : null,
      onEvent
    };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }
}

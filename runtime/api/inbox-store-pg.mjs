import { randomUUID } from "node:crypto";
import { projectInboxItemsFromEvent } from "./inbox-projection.mjs";

function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
}

function mapInboxItem(row) {
  if (!row) {
    return null;
  }
  return {
    inboxSeq: toInt(row.inbox_seq, 0),
    inboxId: row.inbox_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    actorId: row.actor_id,
    sourceEventId: row.source_event_id,
    sourceEventSequence: toInt(row.source_event_sequence, 0),
    sourceEventType: row.source_event_type,
    sourceActorId: row.source_actor_id || null,
    sourceEventAt: ts(row.source_event_at),
    threadId: row.thread_id || null,
    topic: row.topic || "unknown",
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    createdAt: ts(row.created_at),
    ackedAt: ts(row.acked_at),
    ackedBy: row.acked_by || null
  };
}

export class PgInboxStore {
  constructor({ pool, counterStore = null } = {}) {
    this.pool = pool;
    this.counterStore = counterStore;
  }

  async init() {
    return true;
  }

  async close() {
    await this.counterStore?.close?.();
  }

  async getProjectorCursor() {
    const result = await this.pool.query(
      `SELECT cursor FROM projector_cursors WHERE projector = 'inbox' LIMIT 1`
    );
    return toInt(result.rows[0]?.cursor, 0);
  }

  async setProjectorCursor({ cursor = 0 } = {}) {
    const next = toInt(cursor, 0);
    const result = await this.pool.query(
      `
      INSERT INTO projector_cursors (projector, cursor, updated_at)
      VALUES ('inbox', $1, now())
      ON CONFLICT (projector)
      DO UPDATE SET
        cursor = GREATEST(projector_cursors.cursor, EXCLUDED.cursor),
        updated_at = now()
      RETURNING cursor
      `,
      [next]
    );
    return toInt(result.rows[0]?.cursor, next);
  }

  async projectEvent(event) {
    const projected = projectInboxItemsFromEvent(event);
    if (!projected.length) {
      return [];
    }

    const inserted = [];
    for (const row of projected) {
      const createdAt = row.sourceEventAt || new Date().toISOString();
      const result = await this.pool.query(
        `
        INSERT INTO inbox_items (
          inbox_id, tenant_id, room_id, actor_id,
          source_event_id, source_event_sequence, source_event_type, source_actor_id, source_event_at,
          thread_id, topic, payload, created_at
        ) VALUES (
          $1::uuid, $2, $3, $4,
          $5::uuid, $6, $7, $8, $9::timestamptz,
          $10, $11, $12::jsonb, $13::timestamptz
        )
        ON CONFLICT (tenant_id, room_id, actor_id, source_event_id)
        DO NOTHING
        RETURNING *
        `,
        [
          randomUUID(),
          row.tenantId,
          row.roomId,
          row.actorId,
          row.sourceEventId,
          toInt(row.sourceEventSequence, 0),
          row.sourceEventType,
          row.sourceActorId,
          createdAt,
          row.threadId,
          row.topic || "unknown",
          JSON.stringify(row.payload || {}),
          createdAt
        ]
      );
      const insertedRow = mapInboxItem(result.rows[0]);
      if (!insertedRow) {
        continue;
      }
      inserted.push(insertedRow);
      try {
        await this.counterStore?.incr?.({
          tenantId: insertedRow.tenantId,
          roomId: insertedRow.roomId,
          actorId: insertedRow.actorId,
          delta: 1
        });
      } catch {
        // best-effort
      }
    }

    return inserted;
  }

  async list({
    tenantId = "default",
    roomId,
    actorId,
    unreadOnly = false,
    cursor,
    limit = 100,
    order = "asc"
  } = {}) {
    const where = [];
    const params = [];

    params.push(tenantId);
    where.push(`tenant_id = $${params.length}`);

    if (roomId) {
      params.push(roomId);
      where.push(`room_id = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      where.push(`actor_id = $${params.length}`);
    }
    if (unreadOnly) {
      where.push(`acked_at IS NULL`);
    }

    const dir = order === "desc" ? "DESC" : "ASC";
    const cursorNum = Number(cursor);
    if (Number.isFinite(cursorNum)) {
      params.push(cursorNum);
      where.push(`inbox_seq ${dir === "DESC" ? "<" : ">"} $${params.length}`);
    }

    params.push(Math.max(1, Math.min(toInt(limit, 100), 500)));

    const result = await this.pool.query(
      `
      SELECT *
      FROM inbox_items
      WHERE ${where.join(" AND ")}
      ORDER BY inbox_seq ${dir}
      LIMIT $${params.length}
      `,
      params
    );

    return result.rows.map(mapInboxItem);
  }

  async countUnread({ tenantId = "default", roomId, actorId } = {}) {
    const where = [];
    const params = [];

    params.push(tenantId);
    where.push(`tenant_id = $${params.length}`);
    where.push(`acked_at IS NULL`);

    if (roomId) {
      params.push(roomId);
      where.push(`room_id = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      where.push(`actor_id = $${params.length}`);
    }

    const result = await this.pool.query(
      `SELECT COUNT(*)::bigint AS count FROM inbox_items WHERE ${where.join(" AND ")}`,
      params
    );
    return toInt(result.rows[0]?.count, 0);
  }

  async getById({ tenantId = "default", actorId, inboxId } = {}) {
    const result = await this.pool.query(
      `
      SELECT *
      FROM inbox_items
      WHERE tenant_id = $1 AND actor_id = $2 AND inbox_id = $3::uuid
      LIMIT 1
      `,
      [tenantId, actorId, inboxId]
    );
    return mapInboxItem(result.rows[0]);
  }

  async ackOne({ tenantId = "default", actorId, inboxId, ackedBy, ackedAt = new Date().toISOString() } = {}) {
    const existing = await this.getById({ tenantId, actorId, inboxId });
    if (!existing) {
      return null;
    }
    if (existing.ackedAt) {
      return {
        item: existing,
        changed: false
      };
    }

    const result = await this.pool.query(
      `
      UPDATE inbox_items
      SET acked_at = $4::timestamptz, acked_by = $5
      WHERE tenant_id = $1 AND actor_id = $2 AND inbox_id = $3::uuid AND acked_at IS NULL
      RETURNING *
      `,
      [tenantId, actorId, inboxId, ackedAt, ackedBy || actorId]
    );
    const updated = mapInboxItem(result.rows[0]);
    if (!updated) {
      return {
        item: existing,
        changed: false
      };
    }

    try {
      await this.counterStore?.incr?.({
        tenantId: updated.tenantId,
        roomId: updated.roomId,
        actorId: updated.actorId,
        delta: -1
      });
    } catch {
      // best-effort
    }

    return {
      item: updated,
      changed: true
    };
  }

  async ackMany({
    tenantId = "default",
    actorId,
    roomId,
    ids = [],
    upToCursor,
    ackedBy,
    ackedAt = new Date().toISOString()
  } = {}) {
    const idList = Array.isArray(ids)
      ? ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const cursorNum = Number(upToCursor);
    const hasCursor = Number.isFinite(cursorNum);

    const touched = [];

    if (idList.length > 0) {
      const params = [tenantId, actorId, idList, ackedAt, ackedBy || actorId];
      let where = `tenant_id = $1 AND actor_id = $2 AND inbox_id = ANY($3::uuid[]) AND acked_at IS NULL`;
      if (roomId) {
        params.push(roomId);
        where += ` AND room_id = $${params.length}`;
      }
      const result = await this.pool.query(
        `
        UPDATE inbox_items
        SET acked_at = $4::timestamptz, acked_by = $5
        WHERE ${where}
        RETURNING *
        `,
        params
      );
      touched.push(...result.rows.map(mapInboxItem).filter(Boolean));
    }

    if (hasCursor) {
      const params = [tenantId, actorId, cursorNum, ackedAt, ackedBy || actorId];
      let where = `tenant_id = $1 AND actor_id = $2 AND inbox_seq <= $3 AND acked_at IS NULL`;
      if (roomId) {
        params.push(roomId);
        where += ` AND room_id = $${params.length}`;
      }
      const result = await this.pool.query(
        `
        UPDATE inbox_items
        SET acked_at = $4::timestamptz, acked_by = $5
        WHERE ${where}
        RETURNING *
        `,
        params
      );
      touched.push(...result.rows.map(mapInboxItem).filter(Boolean));
    }

    const unique = new Map();
    for (const row of touched) {
      unique.set(row.inboxId, row);
    }

    const grouped = new Map();
    for (const row of unique.values()) {
      const key = `${row.tenantId}:${row.roomId}:${row.actorId}`;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    for (const [key, count] of grouped.entries()) {
      const [gTenantId, gRoomId, gActorId] = key.split(":");
      try {
        await this.counterStore?.incr?.({
          tenantId: gTenantId,
          roomId: gRoomId,
          actorId: gActorId,
          delta: -count
        });
      } catch {
        // best-effort
      }
    }

    return {
      ackedCount: unique.size,
      ackedIds: [...unique.keys()]
    };
  }

  async rebuildUnreadCounters() {
    if (!this.counterStore?.enabled) {
      return { enabled: false, updated: 0 };
    }

    const result = await this.pool.query(
      `
      WITH actors AS (
        SELECT DISTINCT tenant_id, room_id, actor_id
        FROM inbox_items
      ), unread AS (
        SELECT tenant_id, room_id, actor_id, COUNT(*)::bigint AS unread_count
        FROM inbox_items
        WHERE acked_at IS NULL
        GROUP BY tenant_id, room_id, actor_id
      )
      SELECT a.tenant_id, a.room_id, a.actor_id, COALESCE(u.unread_count, 0)::bigint AS unread_count
      FROM actors a
      LEFT JOIN unread u
        ON u.tenant_id = a.tenant_id
       AND u.room_id = a.room_id
       AND u.actor_id = a.actor_id
      `
    );

    let updated = 0;
    for (const row of result.rows) {
      await this.counterStore.set({
        tenantId: row.tenant_id,
        roomId: row.room_id,
        actorId: row.actor_id,
        count: toInt(row.unread_count, 0)
      });
      updated += 1;
    }

    return {
      enabled: true,
      updated
    };
  }
}

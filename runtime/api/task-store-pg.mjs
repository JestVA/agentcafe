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
    taskId: row.task_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    title: row.title,
    description: row.description || null,
    state: row.state,
    createdBy: row.created_by,
    assigneeActorId: row.assignee_actor_id || null,
    progress: Number(row.progress || 0),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    completedAt: ts(row.completed_at),
    completedBy: row.completed_by || null
  };
}

export class PgTaskStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, taskId }) {
    const result = await this.pool.query(
      `
      SELECT task_id, tenant_id, room_id, title, description, state, created_by, assignee_actor_id, progress, metadata, created_at, updated_at, completed_at, completed_by
      FROM tasks
      WHERE tenant_id = $1 AND task_id = $2::uuid
      LIMIT 1
      `,
      [tenantId, taskId]
    );
    return mapRow(result.rows[0]);
  }

  async create({
    tenantId,
    roomId,
    actorId,
    title,
    description = null,
    assigneeActorId = null,
    state = "open",
    progress = 0,
    metadata = {}
  }) {
    const taskId = randomUUID();
    const normalizedState = String(state || "open");
    const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    const completedAt = normalizedState === "done" ? new Date().toISOString() : null;
    const completedBy = normalizedState === "done" ? actorId : null;
    const result = await this.pool.query(
      `
      INSERT INTO tasks (
        task_id, tenant_id, room_id, title, description, state, created_by, assignee_actor_id, progress, metadata, created_at, updated_at, completed_at, completed_by
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now(), $11::timestamptz, $12
      )
      RETURNING task_id, tenant_id, room_id, title, description, state, created_by, assignee_actor_id, progress, metadata, created_at, updated_at, completed_at, completed_by
      `,
      [
        taskId,
        tenantId,
        roomId,
        String(title || "").trim(),
        description == null || description === "" ? null : String(description),
        normalizedState,
        actorId,
        assigneeActorId == null || assigneeActorId === "" ? null : String(assigneeActorId),
        normalizedProgress,
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
        completedAt,
        completedBy
      ]
    );
    return mapRow(result.rows[0]);
  }

  async patch({ tenantId, taskId, actorId, patch }) {
    const existing = await this.get({ tenantId, taskId });
    if (!existing) {
      return null;
    }

    const nextState = "state" in patch ? String(patch.state) : existing.state;
    let completedAt = existing.completedAt;
    let completedBy = existing.completedBy;
    let progress = "progress" in patch ? Number(patch.progress || 0) : existing.progress;
    if (nextState === "done") {
      if (existing.state !== "done") {
        completedAt = new Date().toISOString();
        completedBy = actorId;
      } else {
        completedAt = existing.completedAt || new Date().toISOString();
        completedBy = existing.completedBy || actorId;
      }
      if (!("progress" in patch)) {
        progress = 100;
      }
    } else {
      completedAt = null;
      completedBy = null;
    }

    const result = await this.pool.query(
      `
      UPDATE tasks
      SET
        title = $3,
        description = $4,
        state = $5,
        assignee_actor_id = $6,
        progress = $7,
        metadata = $8::jsonb,
        completed_at = $9::timestamptz,
        completed_by = $10,
        updated_at = now()
      WHERE tenant_id = $1
        AND task_id = $2::uuid
      RETURNING task_id, tenant_id, room_id, title, description, state, created_by, assignee_actor_id, progress, metadata, created_at, updated_at, completed_at, completed_by
      `,
      [
        tenantId,
        taskId,
        "title" in patch ? String(patch.title || "").trim() : existing.title,
        "description" in patch ? patch.description : existing.description,
        nextState,
        "assigneeActorId" in patch ? patch.assigneeActorId : existing.assigneeActorId,
        Math.max(0, Math.min(100, Number(progress) || 0)),
        JSON.stringify("metadata" in patch ? patch.metadata || {} : existing.metadata || {}),
        completedAt,
        completedBy
      ]
    );
    return mapRow(result.rows[0]);
  }

  async list({ tenantId, roomId, state, assigneeActorId, createdBy, limit = 200 } = {}) {
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
    if (state) {
      params.push(state);
      where.push(`state = $${params.length}`);
    }
    if (assigneeActorId) {
      params.push(assigneeActorId);
      where.push(`assignee_actor_id = $${params.length}`);
    }
    if (createdBy) {
      params.push(createdBy);
      where.push(`created_by = $${params.length}`);
    }
    params.push(max);
    const sql = `
      SELECT task_id, tenant_id, room_id, title, description, state, created_by, assignee_actor_id, progress, metadata, created_at, updated_at, completed_at, completed_by
      FROM tasks
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }
}

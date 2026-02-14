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
    objectId: row.object_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    objectType: row.object_type,
    objectKey: row.object_key || null,
    title: row.title || null,
    content: row.content || null,
    data: asObject(row.data),
    quantity: row.quantity == null ? null : Number(row.quantity),
    metadata: asObject(row.metadata),
    version: Number(row.version || 1),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

function normalizeText(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function normalizeQuantity(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.round(numeric));
}

export class PgSharedObjectStore {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async init() {
    return true;
  }

  async get({ tenantId, objectId }) {
    const result = await this.pool.query(
      `
      SELECT object_id, tenant_id, room_id, object_type, object_key, title, content, data, quantity, metadata, version, created_by, updated_by, created_at, updated_at
      FROM shared_objects
      WHERE tenant_id = $1
        AND object_id = $2::uuid
      LIMIT 1
      `,
      [tenantId, objectId]
    );
    return mapRow(result.rows[0]);
  }

  async create({
    tenantId,
    roomId,
    actorId,
    objectType,
    objectKey = null,
    title = null,
    content = null,
    data = {},
    quantity = null,
    metadata = {}
  }) {
    const objectId = randomUUID();
    const result = await this.pool.query(
      `
      INSERT INTO shared_objects (
        object_id, tenant_id, room_id, object_type, object_key, title, content, data, quantity, metadata, version, created_by, updated_by, created_at, updated_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, 1, $11, $11, now(), now()
      )
      RETURNING object_id, tenant_id, room_id, object_type, object_key, title, content, data, quantity, metadata, version, created_by, updated_by, created_at, updated_at
      `,
      [
        objectId,
        tenantId,
        roomId,
        String(objectType),
        normalizeText(objectKey),
        normalizeText(title),
        normalizeText(content),
        JSON.stringify(asObject(data)),
        normalizeQuantity(quantity),
        JSON.stringify(asObject(metadata)),
        String(actorId)
      ]
    );
    return mapRow(result.rows[0]);
  }

  async patch({ tenantId, objectId, actorId, patch }) {
    const existing = await this.get({ tenantId, objectId });
    if (!existing) {
      return null;
    }

    const result = await this.pool.query(
      `
      UPDATE shared_objects
      SET
        object_type = $3,
        object_key = $4,
        title = $5,
        content = $6,
        data = $7::jsonb,
        quantity = $8,
        metadata = $9::jsonb,
        version = shared_objects.version + 1,
        updated_by = $10,
        updated_at = now()
      WHERE tenant_id = $1
        AND object_id = $2::uuid
      RETURNING object_id, tenant_id, room_id, object_type, object_key, title, content, data, quantity, metadata, version, created_by, updated_by, created_at, updated_at
      `,
      [
        tenantId,
        objectId,
        "objectType" in patch ? String(patch.objectType) : existing.objectType,
        "objectKey" in patch ? normalizeText(patch.objectKey) : existing.objectKey,
        "title" in patch ? normalizeText(patch.title) : existing.title,
        "content" in patch ? normalizeText(patch.content) : existing.content,
        JSON.stringify("data" in patch ? asObject(patch.data) : asObject(existing.data)),
        "quantity" in patch ? normalizeQuantity(patch.quantity) : existing.quantity,
        JSON.stringify("metadata" in patch ? asObject(patch.metadata) : asObject(existing.metadata)),
        String(actorId)
      ]
    );
    return mapRow(result.rows[0]);
  }

  async list({ tenantId, roomId, objectType, objectKey, createdBy, updatedBy, limit = 200 } = {}) {
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
    if (objectType) {
      params.push(objectType);
      where.push(`object_type = $${params.length}`);
    }
    if (objectKey) {
      params.push(objectKey);
      where.push(`object_key = $${params.length}`);
    }
    if (createdBy) {
      params.push(createdBy);
      where.push(`created_by = $${params.length}`);
    }
    if (updatedBy) {
      params.push(updatedBy);
      where.push(`updated_by = $${params.length}`);
    }

    params.push(max);
    const sql = `
      SELECT object_id, tenant_id, room_id, object_type, object_key, title, content, data, quantity, metadata, version, created_by, updated_by, created_at, updated_at
      FROM shared_objects
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapRow);
  }
}

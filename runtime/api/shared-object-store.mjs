import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  objects: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, objectId) {
  return `${tenantId}:${objectId}`;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
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

export class FileSharedObjectStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/objects.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        objects: parsed.objects && typeof parsed.objects === "object" ? parsed.objects : {}
      };
    } catch {
      await this.persist();
    }
  }

  async persist() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async get({ tenantId, objectId }) {
    const found = this.data.objects[key(tenantId, objectId)];
    return found ? clone(found) : null;
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
    const now = new Date().toISOString();
    const objectId = randomUUID();
    const next = {
      objectId,
      tenantId,
      roomId,
      objectType: String(objectType),
      objectKey: normalizeText(objectKey),
      title: normalizeText(title),
      content: normalizeText(content),
      data: asObject(data),
      quantity: normalizeQuantity(quantity),
      metadata: asObject(metadata),
      version: 1,
      createdBy: String(actorId),
      updatedBy: String(actorId),
      createdAt: now,
      updatedAt: now
    };
    this.data.objects[key(tenantId, objectId)] = next;
    await this.persist();
    return clone(next);
  }

  async patch({ tenantId, objectId, actorId, patch }) {
    const existing = await this.get({ tenantId, objectId });
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...patch,
      tenantId,
      objectId,
      version: Math.max(1, Number(existing.version || 1) + 1),
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedBy: String(actorId),
      updatedAt: now
    };

    if ("objectKey" in patch) {
      next.objectKey = normalizeText(patch.objectKey);
    }
    if ("title" in patch) {
      next.title = normalizeText(patch.title);
    }
    if ("content" in patch) {
      next.content = normalizeText(patch.content);
    }
    if ("quantity" in patch) {
      next.quantity = normalizeQuantity(patch.quantity);
    }
    if ("data" in patch) {
      next.data = asObject(patch.data);
    }
    if ("metadata" in patch) {
      next.metadata = asObject(patch.metadata);
    }

    this.data.objects[key(tenantId, objectId)] = next;
    await this.persist();
    return clone(next);
  }

  async list({ tenantId, roomId, objectType, objectKey, createdBy, updatedBy, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const out = [];
    for (const row of Object.values(this.data.objects)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (roomId && row.roomId !== roomId) {
        continue;
      }
      if (objectType && row.objectType !== objectType) {
        continue;
      }
      if (objectKey && row.objectKey !== objectKey) {
        continue;
      }
      if (createdBy && row.createdBy !== createdBy) {
        continue;
      }
      if (updatedBy && row.updatedBy !== updatedBy) {
        continue;
      }
      out.push(clone(row));
    }
    out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return out.slice(0, max);
  }
}

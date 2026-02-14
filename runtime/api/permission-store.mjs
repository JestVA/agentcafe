import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  permissions: {}
};

const DEFAULT_PERMISSIONS = {
  canMove: true,
  canSpeak: true,
  canOrder: true,
  canEnterLeave: true,
  canModerate: false
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, roomId, actorId) {
  return `${tenantId}:${roomId}:${actorId}`;
}

export class FilePermissionStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/permissions.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        permissions: parsed.permissions && typeof parsed.permissions === "object" ? parsed.permissions : {}
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

  normalize(record, tenantId, roomId, actorId) {
    return {
      tenantId,
      roomId,
      actorId,
      canMove: record?.canMove ?? DEFAULT_PERMISSIONS.canMove,
      canSpeak: record?.canSpeak ?? DEFAULT_PERMISSIONS.canSpeak,
      canOrder: record?.canOrder ?? DEFAULT_PERMISSIONS.canOrder,
      canEnterLeave: record?.canEnterLeave ?? DEFAULT_PERMISSIONS.canEnterLeave,
      canModerate: record?.canModerate ?? DEFAULT_PERMISSIONS.canModerate,
      createdAt: record?.createdAt || null,
      updatedAt: record?.updatedAt || null,
      source: record ? "custom" : "default"
    };
  }

  async get({ tenantId, roomId, actorId }) {
    const record = this.data.permissions[key(tenantId, roomId, actorId)] || null;
    return this.normalize(record, tenantId, roomId, actorId);
  }

  async upsert({ tenantId, roomId, actorId, patch }) {
    const k = key(tenantId, roomId, actorId);
    const existing = this.data.permissions[k] || null;
    const now = new Date().toISOString();
    const next = {
      canMove: patch.canMove ?? existing?.canMove ?? DEFAULT_PERMISSIONS.canMove,
      canSpeak: patch.canSpeak ?? existing?.canSpeak ?? DEFAULT_PERMISSIONS.canSpeak,
      canOrder: patch.canOrder ?? existing?.canOrder ?? DEFAULT_PERMISSIONS.canOrder,
      canEnterLeave: patch.canEnterLeave ?? existing?.canEnterLeave ?? DEFAULT_PERMISSIONS.canEnterLeave,
      canModerate: patch.canModerate ?? existing?.canModerate ?? DEFAULT_PERMISSIONS.canModerate,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.data.permissions[k] = next;
    await this.persist();
    return this.normalize(next, tenantId, roomId, actorId);
  }

  async list({ tenantId, roomId, actorId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const rows = [];
    for (const [k, value] of Object.entries(this.data.permissions)) {
      const [t, r, a] = k.split(":");
      if (tenantId && tenantId !== t) {
        continue;
      }
      if (roomId && roomId !== r) {
        continue;
      }
      if (actorId && actorId !== a) {
        continue;
      }
      rows.push(this.normalize(value, t, r, a));
    }
    rows.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return clone(rows.slice(0, max));
  }
}

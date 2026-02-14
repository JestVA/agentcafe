import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  rooms: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function roomKey(tenantId, roomId) {
  return `${tenantId}:${roomId}`;
}

export class FilePinnedContextStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/room-context.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        rooms: parsed.rooms && typeof parsed.rooms === "object" ? parsed.rooms : {}
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

  async get({ tenantId, roomId }) {
    const key = roomKey(tenantId, roomId);
    const room = this.data.rooms[key];
    if (!room || !Array.isArray(room.history) || room.history.length === 0) {
      return null;
    }
    const active = room.history.find((item) => item.isActive) || room.history[room.history.length - 1];
    return clone(active);
  }

  async upsert({ tenantId, roomId, actorId, content, metadata = {} }) {
    const key = roomKey(tenantId, roomId);
    const room = this.data.rooms[key] || { latestVersion: 0, history: [] };
    const version = Number(room.latestVersion || 0) + 1;
    const now = new Date().toISOString();

    for (const row of room.history) {
      row.isActive = false;
      row.updatedAt = now;
    }

    const record = {
      tenantId,
      roomId,
      version,
      content,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      pinnedBy: actorId,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };

    room.latestVersion = version;
    room.history.push(record);
    this.data.rooms[key] = room;
    await this.persist();
    return clone(record);
  }

  async listHistory({ tenantId, roomId, limit = 50 }) {
    const key = roomKey(tenantId, roomId);
    const room = this.data.rooms[key];
    if (!room || !Array.isArray(room.history)) {
      return [];
    }
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    const sorted = [...room.history].sort((a, b) => Number(b.version) - Number(a.version));
    return clone(sorted.slice(0, max));
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  rooms: {}
};

const ROOM_TYPE_VALUES = new Set(["lobby", "private_table"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, roomId) {
  return `${tenantId}:${roomId}`;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeRoomType(value) {
  const roomType = String(value || "lobby").trim().toLowerCase();
  return ROOM_TYPE_VALUES.has(roomType) ? roomType : "lobby";
}

function normalizeText(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

export class FileRoomStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/rooms.json");
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
    const found = this.data.rooms[key(tenantId, roomId)];
    return found ? clone(found) : null;
  }

  async upsert({
    tenantId,
    roomId,
    roomType = "lobby",
    displayName = null,
    ownerActorId = null,
    metadata = {}
  }) {
    const k = key(tenantId, roomId);
    const now = new Date().toISOString();
    const existing = this.data.rooms[k] || null;
    const next = {
      tenantId,
      roomId,
      roomType: normalizeRoomType(roomType),
      displayName: normalizeText(displayName),
      ownerActorId: normalizeText(ownerActorId),
      metadata: asObject(metadata),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.data.rooms[k] = next;
    await this.persist();
    return clone(next);
  }

  async list({ tenantId, roomType, ownerActorId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const out = [];
    for (const row of Object.values(this.data.rooms)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (roomType && row.roomType !== roomType) {
        continue;
      }
      if (ownerActorId && row.ownerActorId !== ownerActorId) {
        continue;
      }
      out.push(clone(row));
    }
    out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return out.slice(0, max);
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  states: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, roomId, actorId) {
  return `${tenantId}:${roomId}:${actorId}`;
}

export class FilePresenceStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/presence.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        states: parsed.states && typeof parsed.states === "object" ? parsed.states : {}
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

  async heartbeat({ tenantId, roomId, actorId, status, ttlMs, nowIso = new Date().toISOString() }) {
    const k = key(tenantId, roomId, actorId);
    const existing = this.data.states[k] || null;
    const nowMs = Date.parse(nowIso);
    const expiresAt = new Date(nowMs + Math.max(1000, Number(ttlMs) || 60000)).toISOString();
    const next = {
      tenantId,
      roomId,
      actorId,
      status,
      lastHeartbeatAt: nowIso,
      ttlMs: Math.max(1000, Number(ttlMs) || 60000),
      expiresAt,
      isActive: true,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso
    };
    this.data.states[k] = next;
    await this.persist();
    return {
      state: clone(next),
      previousStatus: existing?.status || null,
      statusChanged: Boolean(existing?.status && existing.status !== status)
    };
  }

  async get({ tenantId, roomId, actorId }) {
    const found = this.data.states[key(tenantId, roomId, actorId)];
    return found ? clone(found) : null;
  }

  async list({ tenantId, roomId, actorId, active, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const out = [];
    for (const row of Object.values(this.data.states)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (roomId && row.roomId !== roomId) {
        continue;
      }
      if (actorId && row.actorId !== actorId) {
        continue;
      }
      if (typeof active === "boolean" && Boolean(row.isActive) !== active) {
        continue;
      }
      out.push(clone(row));
    }
    out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return out.slice(0, max);
  }

  async expireDue({ nowIso = new Date().toISOString() } = {}) {
    const nowMs = Date.parse(nowIso);
    const expired = [];
    for (const [k, row] of Object.entries(this.data.states)) {
      const expiresMs = Date.parse(row.expiresAt || "");
      if (!Number.isFinite(expiresMs) || expiresMs > nowMs) {
        continue;
      }
      if (row.status === "inactive" && row.isActive === false) {
        continue;
      }
      const previousStatus = row.status || null;
      const next = {
        ...row,
        status: "inactive",
        isActive: false,
        updatedAt: nowIso
      };
      this.data.states[k] = next;
      expired.push({
        state: clone(next),
        previousStatus
      });
    }
    if (expired.length) {
      await this.persist();
    }
    return expired;
  }

  async setInactive({ tenantId, roomId, actorId, nowIso = new Date().toISOString() }) {
    const k = key(tenantId, roomId, actorId);
    const existing = this.data.states[k] || null;
    if (!existing) {
      return null;
    }
    if (existing.status === "inactive" && existing.isActive === false) {
      return {
        state: clone(existing),
        previousStatus: "inactive",
        statusChanged: false
      };
    }
    const previousStatus = existing.status || null;
    const next = {
      ...existing,
      status: "inactive",
      isActive: false,
      updatedAt: nowIso
    };
    this.data.states[k] = next;
    await this.persist();
    return {
      state: clone(next),
      previousStatus,
      statusChanged: previousStatus !== "inactive"
    };
  }
}

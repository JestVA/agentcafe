import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  profiles: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, actorId) {
  return `${tenantId}:${actorId}`;
}

export class FileProfileStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/profiles.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {}
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

  async get({ tenantId, actorId }) {
    const found = this.data.profiles[key(tenantId, actorId)];
    return found ? clone(found) : null;
  }

  async upsert({ tenantId, actorId, displayName, avatarUrl = null, bio = null, theme = null, metadata = {} }) {
    const k = key(tenantId, actorId);
    const existing = this.data.profiles[k] || null;
    const now = new Date().toISOString();
    const next = {
      tenantId,
      actorId,
      displayName: String(displayName || "").trim(),
      avatarUrl: avatarUrl == null || avatarUrl === "" ? null : String(avatarUrl),
      bio: bio == null || bio === "" ? null : String(bio),
      theme: theme && typeof theme === "object" ? clone(theme) : null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.data.profiles[k] = next;
    await this.persist();
    return clone(next);
  }

  async patch({ tenantId, actorId, patch }) {
    const existing = await this.get({ tenantId, actorId });
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...patch,
      tenantId,
      actorId,
      createdAt: existing.createdAt,
      updatedAt: now
    };
    this.data.profiles[key(tenantId, actorId)] = next;
    await this.persist();
    return clone(next);
  }

  async delete({ tenantId, actorId }) {
    const k = key(tenantId, actorId);
    if (!this.data.profiles[k]) {
      return false;
    }
    delete this.data.profiles[k];
    await this.persist();
    return true;
  }

  async list({ tenantId, actorId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const rows = [];
    for (const row of Object.values(this.data.profiles)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (actorId && row.actorId !== actorId) {
        continue;
      }
      rows.push(clone(row));
    }
    rows.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return rows.slice(0, max);
  }
}

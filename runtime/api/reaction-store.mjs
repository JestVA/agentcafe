import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  subscriptions: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTypes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return ["*"];
  }
  const out = value.map((item) => String(item).trim()).filter(Boolean);
  return out.length ? out : ["*"];
}

export class FileReactionStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/reactions.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
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

  list({ tenantId, roomId, eventType, enabled, sourceActorId, targetActorId } = {}) {
    let rows = this.data.subscriptions;
    if (tenantId) {
      rows = rows.filter((item) => item.tenantId === tenantId);
    }
    if (roomId) {
      rows = rows.filter((item) => item.roomId === roomId);
    }
    if (eventType) {
      rows = rows.filter(
        (item) => item.triggerEventTypes.includes("*") || item.triggerEventTypes.includes(eventType)
      );
    }
    if (typeof enabled === "boolean") {
      rows = rows.filter((item) => item.enabled === enabled);
    }
    if (sourceActorId) {
      rows = rows.filter((item) => (item.sourceActorId || null) === sourceActorId);
    }
    if (targetActorId) {
      rows = rows.filter((item) => item.targetActorId === targetActorId);
    }
    return clone(rows);
  }

  getById(id) {
    const found = this.data.subscriptions.find((item) => item.id === id);
    return found ? clone(found) : null;
  }

  async create(input) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      tenantId: input.tenantId || "default",
      roomId: input.roomId || null,
      sourceActorId: input.sourceActorId || null,
      targetActorId: input.targetActorId,
      triggerEventTypes: normalizeTypes(input.triggerEventTypes),
      actionType: input.actionType,
      actionPayload: input.actionPayload && typeof input.actionPayload === "object" ? input.actionPayload : {},
      enabled: input.enabled !== false,
      cooldownMs: Number.isFinite(Number(input.cooldownMs)) ? Number(input.cooldownMs) : 1000,
      ignoreSelf: input.ignoreSelf !== false,
      ignoreReactionEvents: input.ignoreReactionEvents !== false,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      triggerCount: 0,
      errorCount: 0,
      lastTriggeredAt: null,
      lastSourceEventId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    this.data.subscriptions.push(record);
    await this.persist();
    return clone(record);
  }

  async update(id, patch) {
    const index = this.data.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) {
      return null;
    }
    const existing = this.data.subscriptions[index];
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      tenantId: existing.tenantId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };
    if ("triggerEventTypes" in patch) {
      next.triggerEventTypes = normalizeTypes(patch.triggerEventTypes);
    }
    this.data.subscriptions[index] = next;
    await this.persist();
    return clone(next);
  }

  async delete(id) {
    const index = this.data.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    this.data.subscriptions.splice(index, 1);
    await this.persist();
    return true;
  }

  async recordTrigger(id, { success, sourceEventId, error = null } = {}) {
    const index = this.data.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) {
      return null;
    }
    const row = this.data.subscriptions[index];
    row.updatedAt = new Date().toISOString();
    if (success) {
      row.triggerCount = Number(row.triggerCount || 0) + 1;
      row.lastTriggeredAt = new Date().toISOString();
      row.lastSourceEventId = sourceEventId || null;
      row.lastError = null;
    } else {
      row.errorCount = Number(row.errorCount || 0) + 1;
      row.lastError = error || "reaction failed";
    }
    await this.persist();
    return clone(row);
  }
}

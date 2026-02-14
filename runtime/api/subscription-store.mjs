import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 2,
  subscriptions: [],
  dlq: [],
  deliveries: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FileSubscriptionStore {
  constructor({ filePath, maxDlqItems = 1000, maxDeliveryItems = 10000 } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/subscriptions.json");
    this.maxDlqItems = maxDlqItems;
    this.maxDeliveryItems = maxDeliveryItems;
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 2,
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        dlq: Array.isArray(parsed.dlq) ? parsed.dlq : [],
        deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : []
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

  list({ tenantId, roomId, eventType, enabled } = {}) {
    let records = this.data.subscriptions;
    if (tenantId) {
      records = records.filter((item) => item.tenantId === tenantId);
    }
    if (roomId) {
      records = records.filter((item) => item.roomId === roomId);
    }
    if (eventType) {
      records = records.filter((item) => item.eventTypes.includes("*") || item.eventTypes.includes(eventType));
    }
    if (typeof enabled === "boolean") {
      records = records.filter((item) => item.enabled === enabled);
    }
    return clone(records);
  }

  getById(id) {
    const record = this.data.subscriptions.find((item) => item.id === id);
    return record ? clone(record) : null;
  }

  async create(input) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      tenantId: input.tenantId || "default",
      roomId: input.roomId || null,
      actorId: input.actorId || null,
      eventTypes: input.eventTypes && input.eventTypes.length ? [...input.eventTypes] : ["*"],
      targetUrl: input.targetUrl,
      secret: input.secret,
      enabled: input.enabled !== false,
      maxRetries: Number.isFinite(Number(input.maxRetries)) ? Number(input.maxRetries) : 3,
      backoffMs: Number.isFinite(Number(input.backoffMs)) ? Number(input.backoffMs) : 1000,
      timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : 5000,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: now,
      updatedAt: now,
      lastDeliveredAt: null,
      lastError: null
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
    if (patch.eventTypes && Array.isArray(patch.eventTypes)) {
      next.eventTypes = [...patch.eventTypes];
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

  async recordDelivery(subscriptionId, { success, error }) {
    const index = this.data.subscriptions.findIndex((item) => item.id === subscriptionId);
    if (index < 0) {
      return;
    }

    const item = this.data.subscriptions[index];
    item.updatedAt = new Date().toISOString();
    if (success) {
      item.lastDeliveredAt = new Date().toISOString();
      item.lastError = null;
    } else {
      item.lastError = error || "delivery failed";
    }
    await this.persist();
  }

  async addDeliveryAttempt(entry) {
    const enriched = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry
    };
    this.data.deliveries.unshift(enriched);
    if (this.data.deliveries.length > this.maxDeliveryItems) {
      this.data.deliveries.length = this.maxDeliveryItems;
    }
    await this.persist();
    return clone(enriched);
  }

  listDeliveries({ subscriptionId, eventId, success, limit = 200 } = {}) {
    let records = this.data.deliveries;
    if (subscriptionId) {
      records = records.filter((item) => item.subscriptionId === subscriptionId);
    }
    if (eventId) {
      records = records.filter((item) => item.eventId === eventId);
    }
    if (typeof success === "boolean") {
      records = records.filter((item) => Boolean(item.success) === success);
    }
    const max = Math.max(1, Math.min(Number(limit) || 200, this.maxDeliveryItems));
    return clone(records.slice(0, max));
  }

  listDlq(limit = 100) {
    const max = Math.max(1, Math.min(Number(limit) || 100, this.maxDlqItems));
    return clone(this.data.dlq.slice(0, max));
  }

  getDlqById(id) {
    const found = this.data.dlq.find((item) => item.id === id);
    return found ? clone(found) : null;
  }

  async pushDlq(entry) {
    const enriched = {
      id: randomUUID(),
      status: "open",
      replayCount: 0,
      replayedAt: null,
      createdAt: new Date().toISOString(),
      ...entry
    };
    this.data.dlq.unshift(enriched);
    if (this.data.dlq.length > this.maxDlqItems) {
      this.data.dlq.length = this.maxDlqItems;
    }
    await this.persist();
    return clone(enriched);
  }

  async markDlqReplayed(id, { success, error } = {}) {
    const index = this.data.dlq.findIndex((item) => item.id === id);
    if (index < 0) {
      return null;
    }
    const row = this.data.dlq[index];
    row.replayCount = Number(row.replayCount || 0) + 1;
    row.replayedAt = new Date().toISOString();
    row.status = success ? "resolved" : "open";
    row.lastReplayError = success ? null : error || "replay failed";
    await this.persist();
    return clone(row);
  }
}

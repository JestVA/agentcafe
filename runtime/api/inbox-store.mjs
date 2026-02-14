import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectInboxItemsFromEvent } from "./inbox-projection.mjs";

const DEFAULT_DATA = {
  version: 1,
  projectorCursor: 0,
  inboxSeq: 1,
  items: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
}

function normalizeItem(item) {
  return {
    inboxSeq: toInt(item.inboxSeq, 0),
    inboxId: item.inboxId,
    tenantId: item.tenantId,
    roomId: item.roomId,
    actorId: item.actorId,
    sourceEventId: item.sourceEventId,
    sourceEventSequence: toInt(item.sourceEventSequence, 0),
    sourceEventType: item.sourceEventType,
    sourceActorId: item.sourceActorId || null,
    sourceEventAt: item.sourceEventAt || null,
    threadId: item.threadId || null,
    topic: item.topic || "unknown",
    payload: item.payload && typeof item.payload === "object" ? item.payload : {},
    createdAt: item.createdAt || new Date().toISOString(),
    ackedAt: item.ackedAt || null,
    ackedBy: item.ackedBy || null
  };
}

function sortItems(items, order = "asc") {
  const out = [...items].sort((a, b) => a.inboxSeq - b.inboxSeq);
  if (order === "desc") {
    out.reverse();
  }
  return out;
}

export class FileInboxStore {
  constructor({ filePath, counterStore = null } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/inbox.json");
    this.counterStore = counterStore;
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const loaded = Array.isArray(parsed.items) ? parsed.items.map(normalizeItem) : [];
      const maxSeq = loaded.reduce((max, item) => Math.max(max, toInt(item.inboxSeq, 0)), 0);
      this.data = {
        version: 1,
        projectorCursor: toInt(parsed.projectorCursor, 0),
        inboxSeq: Math.max(1, toInt(parsed.inboxSeq, maxSeq + 1)),
        items: loaded
      };
    } catch {
      await this.persist();
    }
  }

  async close() {
    await this.counterStore?.close?.();
  }

  async persist() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async getProjectorCursor() {
    return toInt(this.data.projectorCursor, 0);
  }

  async setProjectorCursor({ cursor = 0 } = {}) {
    const next = Math.max(toInt(this.data.projectorCursor, 0), toInt(cursor, 0));
    this.data.projectorCursor = next;
    await this.persist();
    return next;
  }

  findBySource({ tenantId, roomId, actorId, sourceEventId }) {
    return this.data.items.find(
      (item) =>
        item.tenantId === tenantId &&
        item.roomId === roomId &&
        item.actorId === actorId &&
        item.sourceEventId === sourceEventId
    );
  }

  async projectEvent(event) {
    const projected = projectInboxItemsFromEvent(event);
    if (!projected.length) {
      return [];
    }

    const inserted = [];
    for (const item of projected) {
      if (this.findBySource(item)) {
        continue;
      }
      const record = normalizeItem({
        ...item,
        inboxId: randomUUID(),
        inboxSeq: this.data.inboxSeq++,
        createdAt: new Date().toISOString()
      });
      this.data.items.push(record);
      inserted.push(record);
    }

    if (inserted.length > 0) {
      await this.persist();
      for (const item of inserted) {
        try {
          await this.counterStore?.incr?.({
            tenantId: item.tenantId,
            roomId: item.roomId,
            actorId: item.actorId,
            delta: 1
          });
        } catch {
          // counter projection is best-effort
        }
      }
    }

    return clone(inserted);
  }

  async list({
    tenantId = "default",
    roomId,
    actorId,
    unreadOnly = false,
    cursor,
    limit = 100,
    order = "asc"
  } = {}) {
    let rows = this.data.items.filter((item) => item.tenantId === tenantId);
    if (roomId) {
      rows = rows.filter((item) => item.roomId === roomId);
    }
    if (actorId) {
      rows = rows.filter((item) => item.actorId === actorId);
    }
    if (unreadOnly) {
      rows = rows.filter((item) => !item.ackedAt);
    }

    const cursorNum = toInt(cursor, Number.NaN);
    if (Number.isFinite(cursorNum)) {
      if (order === "desc") {
        rows = rows.filter((item) => item.inboxSeq < cursorNum);
      } else {
        rows = rows.filter((item) => item.inboxSeq > cursorNum);
      }
    }

    rows = sortItems(rows, order);
    const max = Math.max(1, Math.min(toInt(limit, 100), 500));
    return clone(rows.slice(0, max));
  }

  async countUnread({ tenantId = "default", roomId, actorId } = {}) {
    let rows = this.data.items.filter((item) => item.tenantId === tenantId && !item.ackedAt);
    if (roomId) {
      rows = rows.filter((item) => item.roomId === roomId);
    }
    if (actorId) {
      rows = rows.filter((item) => item.actorId === actorId);
    }
    return rows.length;
  }

  async getById({ tenantId = "default", actorId, inboxId } = {}) {
    const found = this.data.items.find(
      (item) => item.tenantId === tenantId && item.actorId === actorId && item.inboxId === inboxId
    );
    return found ? clone(found) : null;
  }

  async ackOne({ tenantId = "default", actorId, inboxId, ackedBy, ackedAt = new Date().toISOString() } = {}) {
    const index = this.data.items.findIndex(
      (item) => item.tenantId === tenantId && item.actorId === actorId && item.inboxId === inboxId
    );
    if (index < 0) {
      return null;
    }

    const row = this.data.items[index];
    const wasUnread = !row.ackedAt;
    if (wasUnread) {
      row.ackedAt = ackedAt;
      row.ackedBy = ackedBy || actorId;
      await this.persist();
      try {
        await this.counterStore?.incr?.({
          tenantId: row.tenantId,
          roomId: row.roomId,
          actorId: row.actorId,
          delta: -1
        });
      } catch {
        // best-effort
      }
    }

    return {
      item: clone(row),
      changed: wasUnread
    };
  }

  async ackMany({
    tenantId = "default",
    actorId,
    roomId,
    ids = [],
    upToCursor,
    ackedBy,
    ackedAt = new Date().toISOString()
  } = {}) {
    const idSet = new Set(
      Array.isArray(ids)
        ? ids.map((id) => String(id || "").trim()).filter(Boolean)
        : []
    );
    const hasCursor = Number.isFinite(Number(upToCursor));
    const cursorNum = hasCursor ? Number(upToCursor) : null;

    const touched = [];
    for (const row of this.data.items) {
      if (row.tenantId !== tenantId || row.actorId !== actorId) {
        continue;
      }
      if (roomId && row.roomId !== roomId) {
        continue;
      }
      const idMatch = idSet.size > 0 && idSet.has(row.inboxId);
      const cursorMatch = hasCursor && row.inboxSeq <= cursorNum;
      if (!idMatch && !cursorMatch) {
        continue;
      }
      if (row.ackedAt) {
        continue;
      }
      row.ackedAt = ackedAt;
      row.ackedBy = ackedBy || actorId;
      touched.push(row);
    }

    if (touched.length > 0) {
      await this.persist();
      const grouped = new Map();
      for (const row of touched) {
        const key = `${row.tenantId}:${row.roomId}:${row.actorId}`;
        grouped.set(key, (grouped.get(key) || 0) + 1);
      }
      for (const [key, count] of grouped.entries()) {
        const [gTenantId, gRoomId, gActorId] = key.split(":");
        try {
          await this.counterStore?.incr?.({
            tenantId: gTenantId,
            roomId: gRoomId,
            actorId: gActorId,
            delta: -count
          });
        } catch {
          // best-effort
        }
      }
    }

    return {
      ackedCount: touched.length,
      ackedIds: touched.map((row) => row.inboxId)
    };
  }

  async rebuildUnreadCounters() {
    if (!this.counterStore?.enabled) {
      return { enabled: false, updated: 0 };
    }

    const distinct = new Map();
    for (const item of this.data.items) {
      const key = `${item.tenantId}:${item.roomId}:${item.actorId}`;
      if (!distinct.has(key)) {
        distinct.set(key, {
          tenantId: item.tenantId,
          roomId: item.roomId,
          actorId: item.actorId,
          count: 0
        });
      }
      if (!item.ackedAt) {
        distinct.get(key).count += 1;
      }
    }

    let updated = 0;
    for (const item of distinct.values()) {
      await this.counterStore.set(item);
      updated += 1;
    }

    return {
      enabled: true,
      updated
    };
  }
}

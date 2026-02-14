import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class InMemoryEventStore {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.events = [];
    this.sequence = 1;
    this.subscribers = new Set();

    if (this.filePath) {
      this.loadFromDisk();
    }
  }

  loadFromDisk() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const loaded = Array.isArray(parsed.events) ? parsed.events : [];
      this.events = loaded;
      const maxSeq = this.events.reduce((max, event) => {
        const seq = Number(event.sequence || 0);
        return Number.isFinite(seq) ? Math.max(max, seq) : max;
      }, 0);
      this.sequence = maxSeq + 1;
    } catch {
      this.persistToDisk();
    }
  }

  persistToDisk() {
    if (!this.filePath) {
      return;
    }
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: 1,
          events: this.events
        },
        null,
        2
      ),
      "utf8"
    );
    renameSync(tmp, this.filePath);
  }

  append(event) {
    const persisted = {
      ...event,
      sequence: this.sequence++
    };
    this.events.push(persisted);
    this.persistToDisk();
    this.publish(persisted);
    return clone(persisted);
  }

  getById(eventId) {
    const found = this.events.find((item) => item.eventId === eventId);
    return found ? clone(found) : null;
  }

  list({
    tenantId,
    roomId,
    actorId,
    afterEventId,
    afterCursor,
    limit = 100,
    types,
    fromTs,
    toTs,
    order = "asc"
  } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 5000));
    let filtered = [...this.events];

    if (tenantId) {
      filtered = filtered.filter((event) => event.tenantId === tenantId);
    }
    if (roomId) {
      filtered = filtered.filter((event) => event.roomId === roomId);
    }
    if (actorId) {
      filtered = filtered.filter((event) => event.actorId === actorId);
    }
    if (fromTs) {
      const fromMs = Date.parse(fromTs);
      if (Number.isFinite(fromMs)) {
        filtered = filtered.filter((event) => Date.parse(event.timestamp) >= fromMs);
      }
    }
    if (toTs) {
      const toMs = Date.parse(toTs);
      if (Number.isFinite(toMs)) {
        filtered = filtered.filter((event) => Date.parse(event.timestamp) <= toMs);
      }
    }

    if (order === "desc") {
      filtered.reverse();
    }

    if (afterCursor != null && String(afterCursor).trim() !== "") {
      const cursor = Number(afterCursor);
      if (Number.isFinite(cursor)) {
        if (order === "desc") {
          filtered = filtered.filter((event) => event.sequence < cursor);
        } else {
          filtered = filtered.filter((event) => event.sequence > cursor);
        }
      }
    } else if (afterEventId) {
      const idx = filtered.findIndex((event) => event.eventId === afterEventId);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
    }

    const allowedTypes = Array.isArray(types)
      ? types.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (allowedTypes.length) {
      const allow = new Set(allowedTypes);
      filtered = filtered.filter((event) => allow.has(event.type));
    }

    return clone(filtered.slice(0, max));
  }

  publish(event) {
    for (const sub of this.subscribers) {
      if (sub.tenantId && sub.tenantId !== event.tenantId) {
        continue;
      }
      if (sub.roomId && sub.roomId !== event.roomId) {
        continue;
      }
      if (sub.actorId && sub.actorId !== event.actorId) {
        continue;
      }
      if (sub.types?.length && !sub.types.includes(event.type)) {
        continue;
      }
      try {
        sub.onEvent(event);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  subscribe({ tenantId, roomId, actorId, types, onEvent }) {
    const sub = {
      tenantId: tenantId || null,
      roomId: roomId || null,
      actorId: actorId || null,
      types: Array.isArray(types) && types.length ? types : null,
      onEvent
    };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }
}

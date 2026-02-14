import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  entries: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asIso(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

export class FileOperatorAuditStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/operator-audit.json");
    this.data = clone(DEFAULT_DATA);
    this.nextSeq = 1;
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
      const maxSeq = this.data.entries.reduce((max, item) => {
        const seq = Number(item.auditSeq || 0);
        return Number.isFinite(seq) ? Math.max(max, seq) : max;
      }, 0);
      this.nextSeq = maxSeq + 1;
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

  async append({
    tenantId,
    roomId,
    operatorId,
    action,
    targetActorId = null,
    reason = null,
    metadata = {},
    correlationId = null,
    requestId = null,
    outcome = "applied",
    eventId = null
  }) {
    const row = {
      id: randomUUID(),
      auditSeq: this.nextSeq++,
      tenantId,
      roomId,
      operatorId,
      action,
      targetActorId,
      reason,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      correlationId,
      requestId,
      outcome,
      eventId,
      createdAt: new Date().toISOString()
    };
    this.data.entries.push(row);
    await this.persist();
    return clone(row);
  }

  async list({
    tenantId,
    roomId,
    operatorId,
    action,
    fromTs,
    toTs,
    cursor,
    limit = 100,
    order = "desc"
  } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 1000));
    let rows = this.data.entries;
    if (tenantId) {
      rows = rows.filter((item) => item.tenantId === tenantId);
    }
    if (roomId) {
      rows = rows.filter((item) => item.roomId === roomId);
    }
    if (operatorId) {
      rows = rows.filter((item) => item.operatorId === operatorId);
    }
    if (action) {
      rows = rows.filter((item) => item.action === action);
    }
    if (fromTs) {
      const from = Date.parse(fromTs);
      if (Number.isFinite(from)) {
        rows = rows.filter((item) => Date.parse(item.createdAt) >= from);
      }
    }
    if (toTs) {
      const to = Date.parse(toTs);
      if (Number.isFinite(to)) {
        rows = rows.filter((item) => Date.parse(item.createdAt) <= to);
      }
    }
    const dir = order === "asc" ? "asc" : "desc";
    rows = [...rows].sort((a, b) =>
      dir === "asc" ? Number(a.auditSeq) - Number(b.auditSeq) : Number(b.auditSeq) - Number(a.auditSeq)
    );
    const cursorNum = Number(cursor);
    if (Number.isFinite(cursorNum)) {
      rows = rows.filter((item) =>
        dir === "asc" ? Number(item.auditSeq) > cursorNum : Number(item.auditSeq) < cursorNum
      );
    }
    return clone(rows.slice(0, max));
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  tasks: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, taskId) {
  return `${tenantId}:${taskId}`;
}

export class FileTaskStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/tasks.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {}
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

  async get({ tenantId, taskId }) {
    const found = this.data.tasks[key(tenantId, taskId)];
    return found ? clone(found) : null;
  }

  async create({
    tenantId,
    roomId,
    actorId,
    title,
    description = null,
    assigneeActorId = null,
    state = "open",
    progress = 0,
    metadata = {}
  }) {
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const normalizedState = String(state || "open");
    const next = {
      taskId,
      tenantId,
      roomId,
      title: String(title || "").trim(),
      description: description == null || description === "" ? null : String(description),
      state: normalizedState,
      createdBy: actorId,
      assigneeActorId: assigneeActorId == null || assigneeActorId === "" ? null : String(assigneeActorId),
      progress: Math.max(0, Math.min(100, Number(progress) || 0)),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      createdAt: now,
      updatedAt: now,
      completedAt: normalizedState === "done" ? now : null,
      completedBy: normalizedState === "done" ? actorId : null
    };
    this.data.tasks[key(tenantId, taskId)] = next;
    await this.persist();
    return clone(next);
  }

  async patch({ tenantId, taskId, actorId, patch }) {
    const existing = await this.get({ tenantId, taskId });
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const nextState = "state" in patch ? String(patch.state) : existing.state;
    const next = {
      ...existing,
      ...patch,
      tenantId,
      taskId,
      createdAt: existing.createdAt,
      updatedAt: now
    };

    if (nextState === "done") {
      if (existing.state !== "done") {
        next.completedAt = now;
        next.completedBy = actorId;
      } else {
        next.completedAt = existing.completedAt || now;
        next.completedBy = existing.completedBy || actorId;
      }
      if (!("progress" in patch)) {
        next.progress = 100;
      }
    } else {
      next.completedAt = null;
      next.completedBy = null;
    }

    this.data.tasks[key(tenantId, taskId)] = next;
    await this.persist();
    return clone(next);
  }

  async list({ tenantId, roomId, state, assigneeActorId, createdBy, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const out = [];
    for (const row of Object.values(this.data.tasks)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (roomId && row.roomId !== roomId) {
        continue;
      }
      if (state && row.state !== state) {
        continue;
      }
      if (assigneeActorId && row.assigneeActorId !== assigneeActorId) {
        continue;
      }
      if (createdBy && row.createdBy !== createdBy) {
        continue;
      }
      out.push(clone(row));
    }
    out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return out.slice(0, max);
  }
}

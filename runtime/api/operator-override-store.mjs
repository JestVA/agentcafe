import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPERATOR_ACTIONS } from "./operator-policy.mjs";

const DEFAULT_DATA = {
  version: 1,
  rooms: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, roomId) {
  return `${tenantId}:${roomId}`;
}

function normalizeState(record, tenantId, roomId) {
  const mutedActors = record?.mutedActors && typeof record.mutedActors === "object" ? record.mutedActors : {};
  return {
    tenantId,
    roomId,
    roomPaused: Boolean(record?.roomPaused),
    pausedBy: record?.pausedBy || null,
    pauseReason: record?.pauseReason || null,
    pausedAt: record?.pausedAt || null,
    resumedAt: record?.resumedAt || null,
    mutedActors,
    mutedActorIds: Object.keys(mutedActors),
    metadata: record?.metadata && typeof record.metadata === "object" ? record.metadata : {},
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null
  };
}

export class FileOperatorOverrideStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/operator-overrides.json");
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

  async getRoomState({ tenantId, roomId }) {
    const current = this.data.rooms[key(tenantId, roomId)] || null;
    return normalizeState(current, tenantId, roomId);
  }

  async list({ tenantId, roomId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const rows = [];
    for (const [k, value] of Object.entries(this.data.rooms)) {
      const [t, r] = k.split(":");
      if (tenantId && t !== tenantId) {
        continue;
      }
      if (roomId && r !== roomId) {
        continue;
      }
      rows.push(normalizeState(value, t, r));
    }
    rows.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return rows.slice(0, max).map((item) => clone(item));
  }

  async applyAction({
    tenantId,
    roomId,
    operatorId,
    action,
    targetActorId = null,
    reason = null,
    metadata = {},
    nowIso = new Date().toISOString()
  }) {
    const k = key(tenantId, roomId);
    const existing = this.data.rooms[k] || null;
    const next = normalizeState(existing, tenantId, roomId);
    next.createdAt = next.createdAt || nowIso;
    next.updatedAt = nowIso;
    next.metadata = metadata && typeof metadata === "object" ? metadata : {};
    const safeReason = reason == null || reason === "" ? null : String(reason);
    const safeTarget = targetActorId == null || targetActorId === "" ? null : String(targetActorId);

    if (action === OPERATOR_ACTIONS.PAUSE_ROOM) {
      next.roomPaused = true;
      next.pausedBy = String(operatorId);
      next.pauseReason = safeReason;
      next.pausedAt = nowIso;
      next.resumedAt = null;
    } else if (action === OPERATOR_ACTIONS.RESUME_ROOM) {
      next.roomPaused = false;
      next.resumedAt = nowIso;
    } else if (action === OPERATOR_ACTIONS.MUTE_AGENT) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for mute_agent");
      }
      next.mutedActors = next.mutedActors || {};
      next.mutedActors[safeTarget] = {
        actorId: safeTarget,
        mutedBy: String(operatorId),
        mutedAt: nowIso,
        reason: safeReason
      };
    } else if (action === OPERATOR_ACTIONS.UNMUTE_AGENT) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for unmute_agent");
      }
      next.mutedActors = next.mutedActors || {};
      delete next.mutedActors[safeTarget];
    } else if (action === OPERATOR_ACTIONS.FORCE_LEAVE) {
      if (!safeTarget) {
        throw new Error("targetActorId is required for force_leave");
      }
      // force_leave is ephemeral; no persistent room-state mutation required
    } else {
      throw new Error(`unsupported operator action: ${action}`);
    }

    this.data.rooms[k] = {
      roomPaused: next.roomPaused,
      pausedBy: next.pausedBy,
      pauseReason: next.pauseReason,
      pausedAt: next.pausedAt,
      resumedAt: next.resumedAt,
      mutedActors: next.mutedActors,
      metadata: next.metadata,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt
    };
    await this.persist();

    return {
      state: normalizeState(this.data.rooms[k], tenantId, roomId),
      action: {
        action,
        operatorId: String(operatorId),
        targetActorId: safeTarget,
        reason: safeReason,
        metadata: metadata && typeof metadata === "object" ? metadata : {},
        at: nowIso
      }
    };
  }
}

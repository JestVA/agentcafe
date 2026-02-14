import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = {
  version: 1,
  sessions: {}
};

const STATUS_VALUES = new Set(["active", "ended"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function key(tenantId, sessionId) {
  return `${tenantId}:${sessionId}`;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  return STATUS_VALUES.has(status) ? status : "active";
}

function normalizeText(value) {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function normalizeActorIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const actorId = String(item || "").trim();
    if (!actorId || seen.has(actorId)) {
      continue;
    }
    seen.add(actorId);
    out.push(actorId);
  }
  return out;
}

function normalizePlanId(value) {
  const planId = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  return planId || "cappuccino";
}

function normalizeAmountUsd(value, fallback = 0) {
  const parsed = Number(value == null || value === "" ? fallback : value);
  if (!Number.isFinite(parsed)) {
    return Number(fallback) || 0;
  }
  return Math.max(0, Math.round(parsed * 100) / 100);
}

function withDefaults(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    planId: normalizePlanId(row.planId)
  };
}

export class FileTableSessionStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.resolve("./runtime/data/table-sessions.json");
    this.data = clone(DEFAULT_DATA);
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {}
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

  async get({ tenantId, sessionId }) {
    const found = this.data.sessions[key(tenantId, sessionId)];
    return found ? clone(withDefaults(found)) : null;
  }

  async create({
    tenantId,
    roomId,
    ownerActorId,
    planId = "cappuccino",
    invitedActorIds = [],
    status = "active",
    startedAt,
    expiresAt,
    paymentRef = null,
    paymentAmountUsd = 0,
    paymentProvider = "stub",
    metadata = {}
  }) {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const normalizedStatus = normalizeStatus(status);
    const next = {
      sessionId,
      tenantId,
      roomId,
      ownerActorId: String(ownerActorId),
      planId: normalizePlanId(planId),
      invitedActorIds: normalizeActorIds(invitedActorIds),
      status: normalizedStatus,
      startedAt: normalizeText(startedAt) || now,
      expiresAt: normalizeText(expiresAt),
      endedAt: normalizedStatus === "ended" ? now : null,
      paymentRef: normalizeText(paymentRef),
      paymentAmountUsd: normalizeAmountUsd(paymentAmountUsd, 0),
      paymentProvider: normalizeText(paymentProvider) || "stub",
      metadata: asObject(metadata),
      createdAt: now,
      updatedAt: now
    };
    this.data.sessions[key(tenantId, sessionId)] = next;
    await this.persist();
    return clone(next);
  }

  async patch({ tenantId, sessionId, patch }) {
    const existing = await this.get({ tenantId, sessionId });
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...patch,
      tenantId,
      sessionId,
      ownerActorId: existing.ownerActorId,
      createdAt: existing.createdAt,
      updatedAt: now
    };

    if ("invitedActorIds" in patch) {
      next.invitedActorIds = normalizeActorIds(patch.invitedActorIds);
    }
    if ("planId" in patch) {
      next.planId = normalizePlanId(patch.planId);
    } else {
      next.planId = normalizePlanId(existing.planId);
    }
    if ("status" in patch) {
      next.status = normalizeStatus(patch.status);
      if (next.status === "ended" && !next.endedAt) {
        next.endedAt = now;
      }
      if (next.status !== "ended") {
        next.endedAt = null;
      }
    }
    if ("startedAt" in patch) {
      next.startedAt = normalizeText(patch.startedAt) || existing.startedAt;
    }
    if ("expiresAt" in patch) {
      next.expiresAt = normalizeText(patch.expiresAt);
    }
    if ("paymentRef" in patch) {
      next.paymentRef = normalizeText(patch.paymentRef);
    }
    if ("paymentAmountUsd" in patch) {
      next.paymentAmountUsd = normalizeAmountUsd(patch.paymentAmountUsd, existing.paymentAmountUsd);
    }
    if ("paymentProvider" in patch) {
      next.paymentProvider = normalizeText(patch.paymentProvider) || existing.paymentProvider;
    }
    if ("metadata" in patch) {
      next.metadata = asObject(patch.metadata);
    }

    this.data.sessions[key(tenantId, sessionId)] = next;
    await this.persist();
    return clone(next);
  }

  async list({ tenantId, roomId, ownerActorId, status, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const out = [];
    for (const row of Object.values(this.data.sessions)) {
      if (tenantId && row.tenantId !== tenantId) {
        continue;
      }
      if (roomId && row.roomId !== roomId) {
        continue;
      }
      if (ownerActorId && row.ownerActorId !== ownerActorId) {
        continue;
      }
      if (status && row.status !== status) {
        continue;
      }
      out.push(clone(withDefaults(row)));
    }
    out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
    return out.slice(0, max);
  }
}

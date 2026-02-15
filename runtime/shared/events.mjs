import { randomUUID } from "node:crypto";

export const EVENT_TYPES = {
  ENTER: "agent_entered",
  LEAVE: "agent_left",
  MOVE: "actor_moved",
  SPEAK: "bubble_posted",
  ORDER: "order_changed",
  MENTION_CREATED: "mention_created",
  ROOM_CONTEXT_PINNED: "room_context_pinned",
  PRESENCE_HEARTBEAT: "presence_heartbeat",
  STATUS_CHANGED: "status_changed",
  OPERATOR_OVERRIDE_APPLIED: "operator_override_applied",
  TASK_CREATED: "task_created",
  TASK_UPDATED: "task_updated",
  TASK_ASSIGNED: "task_assigned",
  TASK_PROGRESS_UPDATED: "task_progress_updated",
  TASK_COMPLETED: "task_completed",
  TASK_HANDOFF: "task_handoff",
  SHARED_OBJECT_CREATED: "shared_object_created",
  SHARED_OBJECT_UPDATED: "shared_object_updated",
  ROOM_CREATED: "room_created",
  ROOM_UPDATED: "room_updated",
  TABLE_SESSION_CREATED: "table_session_created",
  TABLE_SESSION_UPDATED: "table_session_updated",
  TABLE_SESSION_ENDED: "table_session_ended",
  CONVERSATION_MESSAGE: "conversation_message_posted",
  INTENT_PLANNED: "intent_planned",
  INTENT_COMPLETED: "intent_completed",
  SNAPSHOT_CREATED: "snapshot_created"
};

const STATUS_VALUES = new Set(["thinking", "idle", "busy", "inactive"]);

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function asIso(value, fallbackIso) {
  if (!value) {
    return fallbackIso;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return fallbackIso;
}

function asStatus(value, { field, allowNull = false } = {}) {
  if (value == null || value === "") {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${field} is required`);
  }
  const status = String(value).trim().toLowerCase();
  if (!STATUS_VALUES.has(status)) {
    throw new TypeError(`${field} must be one of thinking|idle|busy|inactive`);
  }
  return status;
}

function normalizeEnterPayload(payload, timestamp) {
  const raw = asObject(payload);
  const x = Number(raw?.position?.x);
  const y = Number(raw?.position?.y);
  return {
    source: raw.source ? String(raw.source) : "agent",
    reason: raw.reason ? String(raw.reason) : "manual_enter",
    enteredAt: asIso(raw.enteredAt, timestamp),
    position:
      Number.isFinite(x) && Number.isFinite(y)
        ? {
            x,
            y
          }
        : null,
    metadata: asObject(raw.metadata)
  };
}

function normalizeLeavePayload(payload, timestamp) {
  const raw = asObject(payload);
  const forced = Boolean(raw.forced);
  return {
    source: raw.source ? String(raw.source) : forced ? "operator" : "agent",
    reason: raw.reason ? String(raw.reason) : forced ? "operator_force_leave" : "manual_leave",
    leftAt: asIso(raw.leftAt, timestamp),
    forced,
    operatorId: raw.operatorId ? String(raw.operatorId) : null,
    metadata: asObject(raw.metadata)
  };
}

function normalizeStatusChangedPayload(payload, timestamp) {
  const raw = asObject(payload);
  const fromStatus = asStatus(raw.fromStatus ?? raw.from ?? null, {
    field: "status_changed.fromStatus",
    allowNull: true
  });
  const toStatus = asStatus(raw.toStatus ?? raw.to, {
    field: "status_changed.toStatus",
    allowNull: false
  });
  const out = {
    fromStatus,
    toStatus,
    reason: raw.reason ? String(raw.reason) : "status_update",
    source: raw.source ? String(raw.source) : "system",
    changedAt: asIso(raw.changedAt, timestamp),
    lastHeartbeatAt: raw.lastHeartbeatAt ? asIso(raw.lastHeartbeatAt, timestamp) : null,
    expiresAt: raw.expiresAt ? asIso(raw.expiresAt, timestamp) : null,
    operatorId: raw.operatorId ? String(raw.operatorId) : null,
    metadata: asObject(raw.metadata)
  };

  // Backward compatibility for existing readers during migration.
  out.from = out.fromStatus;
  out.to = out.toStatus;
  return out;
}

function normalizePayloadForType(type, payload, timestamp) {
  if (type === EVENT_TYPES.ENTER) {
    return normalizeEnterPayload(payload, timestamp);
  }
  if (type === EVENT_TYPES.LEAVE) {
    return normalizeLeavePayload(payload, timestamp);
  }
  if (type === EVENT_TYPES.STATUS_CHANGED) {
    return normalizeStatusChangedPayload(payload, timestamp);
  }
  return payload || {};
}

export function createEvent({
  tenantId = "default",
  roomId = "main",
  actorId,
  type,
  payload,
  correlationId,
  causationId
}) {
  const now = new Date().toISOString();
  if (!type) {
    throw new TypeError("event type is required");
  }
  const safeActorId = String(actorId || "").trim();
  if (!safeActorId) {
    throw new TypeError("actorId is required");
  }
  return {
    eventId: randomUUID(),
    tenantId,
    roomId,
    actorId: safeActorId,
    type,
    timestamp: now,
    payload: normalizePayloadForType(type, payload, now),
    correlationId: correlationId || randomUUID(),
    causationId: causationId || null
  };
}

import http from "node:http";
import { randomUUID } from "node:crypto";
import { AppError, errorBody, getRequestId, normalizeError } from "../shared/errors.mjs";
import { buildConversationObject } from "../shared/conversation.mjs";
import { createEvent, EVENT_TYPES } from "../shared/events.mjs";
import { json, readJson, sendRateLimitHeaders } from "../shared/http.mjs";
import { optionalObject, optionalString, requireString } from "../shared/validate.mjs";
import { createPostgresPool } from "../db/postgres.mjs";
import { applyPostgresMigrations } from "../db/migrate.mjs";
import { ProjectionState } from "../projector/projection-state.mjs";
import { PgEventStore } from "./event-store-pg.mjs";
import { InMemoryEventStore } from "./event-store.mjs";
import { hashRequest, InMemoryIdempotencyStore } from "./idempotency-store.mjs";
import { PgIdempotencyStore } from "./idempotency-store-pg.mjs";
import { IntentPlanner } from "./intent-planner.mjs";
import { projectLastSeen } from "./last-seen-projection.mjs";
import { ModerationPolicy } from "./moderation-policy.mjs";
import { calculateCollaborationScore } from "./collaboration-score.mjs";
import { PgOperatorAuditStore } from "./operator-audit-store-pg.mjs";
import { FileOperatorAuditStore } from "./operator-audit-store.mjs";
import { PgOperatorOverrideStore } from "./operator-override-store-pg.mjs";
import { FileOperatorOverrideStore } from "./operator-override-store.mjs";
import { evaluateOperatorBlock, isOperatorAction, OPERATOR_ACTIONS } from "./operator-policy.mjs";
import { PgPermissionStore } from "./permission-store-pg.mjs";
import { FilePermissionStore } from "./permission-store.mjs";
import { PgPresenceStore } from "./presence-store-pg.mjs";
import { FilePresenceStore } from "./presence-store.mjs";
import { PgProfileStore } from "./profile-store-pg.mjs";
import { FileProfileStore } from "./profile-store.mjs";
import { PgPinnedContextStore } from "./pinned-context-store-pg.mjs";
import { FilePinnedContextStore } from "./pinned-context-store.mjs";
import { PgSharedObjectStore } from "./shared-object-store-pg.mjs";
import { FileSharedObjectStore } from "./shared-object-store.mjs";
import { PgRoomStore } from "./room-store-pg.mjs";
import { FileRoomStore } from "./room-store.mjs";
import { PgTableSessionStore } from "./table-session-store-pg.mjs";
import { FileTableSessionStore } from "./table-session-store.mjs";
import { ReactionEngine } from "./reaction-engine.mjs";
import { PgReactionStore } from "./reaction-store-pg.mjs";
import { FileReactionStore } from "./reaction-store.mjs";
import { PgTaskStore } from "./task-store-pg.mjs";
import { FileTaskStore } from "./task-store.mjs";
import { FixedWindowRateLimiter } from "./rate-limit.mjs";
import { InMemorySnapshotStore } from "./snapshot-store.mjs";
import { PgSnapshotStore } from "./snapshot-store-pg.mjs";
import { PgSubscriptionStore } from "./subscription-store-pg.mjs";
import { FileSubscriptionStore } from "./subscription-store.mjs";
import { InMemoryTraceStore, REASON_CODES } from "./trace-store.mjs";
import { PgTraceStore } from "./trace-store-pg.mjs";
import { WebhookDispatcher } from "./webhook-dispatcher.mjs";
import { createInboxCounterStore } from "./inbox-counter-store.mjs";
import { PgInboxStore } from "./inbox-store-pg.mjs";
import { FileInboxStore } from "./inbox-store.mjs";

const HOST = process.env.API_HOST || "0.0.0.0";
const PORT = Number(process.env.API_PORT || process.env.PORT || 3850);
const STREAM_HEARTBEAT_MS = Number(process.env.API_STREAM_HEARTBEAT_MS || 15000);
const EVENT_STORE_FILE = process.env.EVENT_STORE_FILE || "./runtime/data/events.json";
const SUBSCRIPTIONS_FILE = process.env.SUBSCRIPTIONS_FILE || "./runtime/data/subscriptions.json";
const ROOM_CONTEXT_FILE = process.env.ROOM_CONTEXT_FILE || "./runtime/data/room-context.json";
const PERMISSIONS_FILE = process.env.PERMISSIONS_FILE || "./runtime/data/permissions.json";
const OPERATOR_OVERRIDES_FILE =
  process.env.OPERATOR_OVERRIDES_FILE || "./runtime/data/operator-overrides.json";
const OPERATOR_AUDIT_FILE = process.env.OPERATOR_AUDIT_FILE || "./runtime/data/operator-audit.json";
const PRESENCE_FILE = process.env.PRESENCE_FILE || "./runtime/data/presence.json";
const PROFILES_FILE = process.env.PROFILES_FILE || "./runtime/data/profiles.json";
const REACTIONS_FILE = process.env.REACTIONS_FILE || "./runtime/data/reactions.json";
const TASKS_FILE = process.env.TASKS_FILE || "./runtime/data/tasks.json";
const OBJECTS_FILE = process.env.OBJECTS_FILE || "./runtime/data/objects.json";
const ROOMS_FILE = process.env.ROOMS_FILE || "./runtime/data/rooms.json";
const TABLE_SESSIONS_FILE = process.env.TABLE_SESSIONS_FILE || "./runtime/data/table-sessions.json";
const INBOX_FILE = process.env.INBOX_FILE || "./runtime/data/inbox.json";
const PRESENCE_DEFAULT_TTL_MS = Math.max(1000, Number(process.env.PRESENCE_DEFAULT_TTL_MS || 60000));
const PRESENCE_SWEEP_MS = Math.max(500, Number(process.env.PRESENCE_SWEEP_MS || 2000));
const API_DB_AUTO_MIGRATE = String(process.env.API_DB_AUTO_MIGRATE ?? "true").toLowerCase() !== "false";
const API_MAX_CHAT_MESSAGE_CHARS = Math.max(
  1,
  Number(process.env.API_MAX_CHAT_MESSAGE_CHARS || process.env.AGENTCAFE_MAX_CHAT_MESSAGE_CHARS || 120)
);
const API_AUTH_TOKEN = String(process.env.API_AUTH_TOKEN || process.env.AGENTCAFE_RUNTIME_API_KEY || "").trim();
const API_AUTH_QUERY_PARAM = String(process.env.API_AUTH_QUERY_PARAM || "apiKey").trim() || "apiKey";
const API_IDEMPOTENCY_TTL_MS = Math.max(60 * 1000, Number(process.env.API_IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000));
const PRIVATE_TABLE_PRICE_USD = Math.max(0, Number(process.env.PRIVATE_TABLE_PRICE_USD || 3.5));
const PRIVATE_TABLE_PAYMENT_MODE = String(process.env.PRIVATE_TABLE_PAYMENT_MODE || "stub").trim().toLowerCase();
const PRIVATE_TABLE_PAYMENT_STUB_PROOF = String(
  process.env.PRIVATE_TABLE_PAYMENT_STUB_PROOF || "coffee_paid"
).trim();
const PRIVATE_TABLE_PAYMENT_WEBHOOK_URL = String(process.env.PRIVATE_TABLE_PAYMENT_WEBHOOK_URL || "").trim();
const PRIVATE_TABLE_PAYMENT_WEBHOOK_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.PRIVATE_TABLE_PAYMENT_WEBHOOK_TIMEOUT_MS || 4000)
);
const PRIVATE_TABLE_DEFAULT_SESSION_MINUTES = Math.max(
  5,
  Number(process.env.PRIVATE_TABLE_DEFAULT_SESSION_MINUTES || 90)
);
const TABLE_SESSION_SWEEP_MS = Math.max(1000, Number(process.env.TABLE_SESSION_SWEEP_MS || 5000));
const TABLE_PLAN_DEFAULT_ID_RAW = String(process.env.TABLE_PLAN_DEFAULT_ID || "cappuccino")
  .trim()
  .toLowerCase();
const TABLE_PLAN_CATALOG = parseTablePlanCatalog(process.env.TABLE_PLAN_CATALOG_JSON);
const TABLE_PLAN_DEFAULT_ID = resolveDefaultTablePlanId(TABLE_PLAN_CATALOG, TABLE_PLAN_DEFAULT_ID_RAW);

const pgPool = await createPostgresPool();
if (pgPool && API_DB_AUTO_MIGRATE) {
  const migrationResult = await applyPostgresMigrations({ pool: pgPool });
  if (migrationResult.applied.length > 0) {
    process.stdout.write(
      `agentcafe-api applied ${migrationResult.applied.length} migration(s): ${migrationResult.applied.join(", ")}\n`
    );
  } else {
    process.stdout.write("agentcafe-api migrations already up to date\n");
  }
}
const eventStore = pgPool
  ? new PgEventStore({ pool: pgPool })
  : new InMemoryEventStore({ filePath: EVENT_STORE_FILE });
const idempotency = pgPool
  ? new PgIdempotencyStore({ pool: pgPool, ttlMs: API_IDEMPOTENCY_TTL_MS })
  : new InMemoryIdempotencyStore({ ttlMs: API_IDEMPOTENCY_TTL_MS });
const rateLimiter = new FixedWindowRateLimiter();
const moderationPolicy = new ModerationPolicy();
const snapshots = pgPool
  ? new PgSnapshotStore({ pool: pgPool })
  : new InMemorySnapshotStore();
const planner = new IntentPlanner();
const traces = pgPool
  ? new PgTraceStore({ pool: pgPool })
  : new InMemoryTraceStore();
const inboxCounterStore = await createInboxCounterStore();
const subscriptionStore = pgPool
  ? new PgSubscriptionStore({ pool: pgPool })
  : new FileSubscriptionStore({ filePath: SUBSCRIPTIONS_FILE });
const permissionStore = pgPool
  ? new PgPermissionStore({ pool: pgPool })
  : new FilePermissionStore({ filePath: PERMISSIONS_FILE });
const operatorOverrideStore = pgPool
  ? new PgOperatorOverrideStore({ pool: pgPool })
  : new FileOperatorOverrideStore({ filePath: OPERATOR_OVERRIDES_FILE });
const operatorAuditStore = pgPool
  ? new PgOperatorAuditStore({ pool: pgPool })
  : new FileOperatorAuditStore({ filePath: OPERATOR_AUDIT_FILE });
const presenceStore = pgPool
  ? new PgPresenceStore({ pool: pgPool })
  : new FilePresenceStore({ filePath: PRESENCE_FILE });
const profileStore = pgPool
  ? new PgProfileStore({ pool: pgPool })
  : new FileProfileStore({ filePath: PROFILES_FILE });
const reactionStore = pgPool
  ? new PgReactionStore({ pool: pgPool })
  : new FileReactionStore({ filePath: REACTIONS_FILE });
const taskStore = pgPool
  ? new PgTaskStore({ pool: pgPool })
  : new FileTaskStore({ filePath: TASKS_FILE });
const sharedObjectStore = pgPool
  ? new PgSharedObjectStore({ pool: pgPool })
  : new FileSharedObjectStore({ filePath: OBJECTS_FILE });
const roomStore = pgPool
  ? new PgRoomStore({ pool: pgPool })
  : new FileRoomStore({ filePath: ROOMS_FILE });
const tableSessionStore = pgPool
  ? new PgTableSessionStore({ pool: pgPool })
  : new FileTableSessionStore({ filePath: TABLE_SESSIONS_FILE });
const pinnedContextStore = pgPool
  ? new PgPinnedContextStore({ pool: pgPool })
  : new FilePinnedContextStore({ filePath: ROOM_CONTEXT_FILE });
const inboxStore = pgPool
  ? new PgInboxStore({ pool: pgPool, counterStore: inboxCounterStore })
  : new FileInboxStore({ filePath: INBOX_FILE, counterStore: inboxCounterStore });
await eventStore.init?.();
await idempotency.init?.();
await subscriptionStore.init();
await permissionStore.init();
await operatorOverrideStore.init();
await operatorAuditStore.init();
await presenceStore.init();
await profileStore.init();
await reactionStore.init();
await taskStore.init();
await sharedObjectStore.init();
await roomStore.init();
await tableSessionStore.init();
await pinnedContextStore.init();
await inboxStore.init();
await snapshots.init?.();
await traces.init?.();
const webhookDispatcher = new WebhookDispatcher({
  eventStore,
  subscriptionStore,
  maxConcurrency: Number(process.env.WEBHOOK_MAX_CONCURRENCY || 4)
});
webhookDispatcher.start();
const reactionEngine = new ReactionEngine({
  eventStore,
  reactionStore,
  permissionStore,
  operatorOverrideStore,
  moderationPolicy,
  maxConcurrency: Number(process.env.REACTION_MAX_CONCURRENCY || 4)
});
reactionEngine.start();

const inboxProjectorState = {
  cursor: 0,
  projectedEvents: 0,
  insertedItems: 0,
  rebuiltCounters: 0,
  bootstrappedAt: null,
  lastProjectedAt: null,
  lastError: null
};

let inboxProjectionQueue = Promise.resolve();

async function runInboxProjection(event) {
  if (!event || typeof event !== "object") {
    return;
  }
  const inserted = await inboxStore.projectEvent(event);
  const sequence = Number(event.sequence || 0);
  if (Number.isFinite(sequence) && sequence > 0) {
    inboxProjectorState.cursor = Math.max(inboxProjectorState.cursor, sequence);
    await inboxStore.setProjectorCursor({ cursor: inboxProjectorState.cursor });
  }
  inboxProjectorState.projectedEvents += 1;
  inboxProjectorState.insertedItems += inserted.length;
  inboxProjectorState.lastProjectedAt = new Date().toISOString();
}

function queueInboxProjection(event) {
  inboxProjectionQueue = inboxProjectionQueue
    .then(async () => {
      await runInboxProjection(event);
      inboxProjectorState.lastError = null;
    })
    .catch((error) => {
      inboxProjectorState.lastError = error instanceof Error ? error.message : String(error);
    });
}

async function bootstrapInboxProjection() {
  let cursor = Number(await inboxStore.getProjectorCursor()) || 0;
  inboxProjectorState.cursor = cursor;
  const batchSize = 500;

  while (true) {
    const events = await eventStore.list({
      afterCursor: cursor,
      limit: batchSize,
      order: "asc"
    });
    if (!events.length) {
      break;
    }

    for (const event of events) {
      const inserted = await inboxStore.projectEvent(event);
      inboxProjectorState.projectedEvents += 1;
      inboxProjectorState.insertedItems += inserted.length;
      inboxProjectorState.lastProjectedAt = new Date().toISOString();
      const sequence = Number(event.sequence || 0);
      if (Number.isFinite(sequence) && sequence > 0) {
        cursor = Math.max(cursor, sequence);
      }
    }
    inboxProjectorState.cursor = cursor;
    await inboxStore.setProjectorCursor({ cursor });
  }

  const counters = await inboxStore.rebuildUnreadCounters?.();
  inboxProjectorState.rebuiltCounters = Number(counters?.updated || 0);
  inboxProjectorState.bootstrappedAt = new Date().toISOString();
}

await bootstrapInboxProjection();
eventStore.subscribe({
  onEvent: (event) => {
    queueInboxProjection(event);
  }
});

async function sweepPresenceExpirations() {
  const nowIso = new Date().toISOString();
  const expired = await presenceStore.expireDue({ nowIso });
  for (const item of expired) {
    await eventStore.append(
      createEvent({
        tenantId: item.state.tenantId,
        roomId: item.state.roomId,
        actorId: item.state.actorId,
        type: EVENT_TYPES.STATUS_CHANGED,
        payload: {
          from: item.previousStatus || null,
          to: "inactive",
          reason: "heartbeat_ttl_expired",
          expiresAt: item.state.expiresAt
        }
      })
    );
  }
}

const presenceSweepHandle = setInterval(() => {
  sweepPresenceExpirations().catch(() => {
    // keep server alive even if sweeper fails
  });
}, PRESENCE_SWEEP_MS);
presenceSweepHandle.unref?.();

async function sweepExpiredTableSessions() {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const sessions = await tableSessionStore.list({
    status: "active",
    limit: 1000
  });
  for (const session of sessions) {
    if (!tableSessionExpired(session, nowMs)) {
      continue;
    }
    const ended = await tableSessionStore.patch({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      patch: {
        status: "ended",
        endedAt: nowIso
      }
    });
    if (!ended) {
      continue;
    }
    const updatedEvent = await eventStore.append(
      createEvent({
        tenantId: ended.tenantId,
        roomId: ended.roomId,
        actorId: ended.ownerActorId,
        type: EVENT_TYPES.TABLE_SESSION_UPDATED,
        payload: {
          sessionId: ended.sessionId,
          status: ended.status,
          planId: ended.planId,
          invitedActorIds: ended.invitedActorIds,
          startedAt: ended.startedAt,
          expiresAt: ended.expiresAt,
          endedAt: ended.endedAt,
          metadata: ended.metadata,
          changedFields: ["status", "endedAt"]
        }
      })
    );
    await eventStore.append(
      createEvent({
        tenantId: ended.tenantId,
        roomId: ended.roomId,
        actorId: ended.ownerActorId,
        type: EVENT_TYPES.TABLE_SESSION_ENDED,
        payload: {
          sessionId: ended.sessionId,
          endedAt: ended.endedAt,
          ownerActorId: ended.ownerActorId,
          reason: "expired"
        },
        causationId: updatedEvent.eventId
      })
    );
  }
}

const tableSessionSweepHandle = setInterval(() => {
  sweepExpiredTableSessions().catch(() => {
    // keep server alive even if sweeper fails
  });
}, TABLE_SESSION_SWEEP_MS);
tableSessionSweepHandle.unref?.();

const COMMAND_ROUTES = new Map([
  ["/v1/commands/enter", { type: EVENT_TYPES.ENTER, action: "enter" }],
  ["/v1/commands/leave", { type: EVENT_TYPES.LEAVE, action: "leave" }],
  ["/v1/commands/move", { type: EVENT_TYPES.MOVE, action: "move" }],
  ["/v1/commands/say", { type: EVENT_TYPES.CONVERSATION_MESSAGE, action: "say" }],
  ["/v1/commands/order", { type: EVENT_TYPES.ORDER, action: "order" }],
  ["/v1/conversations/messages", { type: EVENT_TYPES.CONVERSATION_MESSAGE, action: "conversation_message" }]
]);

const LOCAL_MEMORY_EVENT_TYPES = [
  EVENT_TYPES.CONVERSATION_MESSAGE,
  EVENT_TYPES.ORDER,
  EVENT_TYPES.MOVE,
  EVENT_TYPES.ENTER,
  EVENT_TYPES.LEAVE,
  EVENT_TYPES.INTENT_COMPLETED,
  EVENT_TYPES.ROOM_CONTEXT_PINNED,
  EVENT_TYPES.OPERATOR_OVERRIDE_APPLIED,
  EVENT_TYPES.TASK_CREATED,
  EVENT_TYPES.TASK_UPDATED,
  EVENT_TYPES.TASK_ASSIGNED,
  EVENT_TYPES.TASK_PROGRESS_UPDATED,
  EVENT_TYPES.TASK_COMPLETED,
  EVENT_TYPES.SHARED_OBJECT_CREATED,
  EVENT_TYPES.SHARED_OBJECT_UPDATED
];
const COLLABORATION_SCORE_EVENT_TYPES = [
  EVENT_TYPES.CONVERSATION_MESSAGE,
  EVENT_TYPES.TASK_ASSIGNED,
  EVENT_TYPES.TASK_COMPLETED,
  EVENT_TYPES.SHARED_OBJECT_CREATED,
  EVENT_TYPES.SHARED_OBJECT_UPDATED
];

const CAPABILITY_KEYS = new Set(["canMove", "canSpeak", "canOrder", "canEnterLeave", "canModerate"]);
const PRESENCE_STATUS_VALUES = new Set(["thinking", "idle", "busy", "inactive"]);
const TASK_STATE_VALUES = new Set(["open", "active", "done"]);
const OBJECT_TYPE_VALUES = new Set(["whiteboard", "note", "token"]);
const ROOM_TYPE_VALUES = new Set(["lobby", "private_table"]);
const TABLE_SESSION_STATUS_VALUES = new Set(["active", "ended"]);
const MOVE_DIRECTIONS = new Set(["N", "S", "E", "W"]);
const THEME_FIELDS = ["bubbleColor", "textColor", "accentColor"];
const THEME_COLOR_RE = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function capabilityForEventType(type) {
  if (type === EVENT_TYPES.MOVE) {
    return "canMove";
  }
  if (type === EVENT_TYPES.CONVERSATION_MESSAGE) {
    return "canSpeak";
  }
  if (type === EVENT_TYPES.ORDER) {
    return "canOrder";
  }
  if (type === EVENT_TYPES.ENTER || type === EVENT_TYPES.LEAVE) {
    return "canEnterLeave";
  }
  return null;
}

function parsePermissionPatch(body) {
  const patch = {};
  for (const key of CAPABILITY_KEYS) {
    if (key in body) {
      patch[key] = Boolean(body[key]);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError("ERR_VALIDATION", "At least one permission field is required", {
      fields: [...CAPABILITY_KEYS]
    });
  }
  return patch;
}

function parsePresenceStatus(value, fallback = "idle") {
  const status = String(value || fallback).trim().toLowerCase();
  if (!PRESENCE_STATUS_VALUES.has(status)) {
    throw new AppError("ERR_INVALID_ENUM", "status must be one of thinking|idle|busy|inactive", {
      field: "status",
      allowed: [...PRESENCE_STATUS_VALUES]
    });
  }
  return status;
}

function parseMoveDirection(value, { field = "direction" } = {}) {
  const direction = String(value || "").trim().toUpperCase();
  if (!MOVE_DIRECTIONS.has(direction)) {
    throw new AppError("ERR_INVALID_DIRECTION", `${field} must be one of N|S|E|W`, {
      field,
      allowed: [...MOVE_DIRECTIONS]
    });
  }
  return direction;
}

function parseBoundedSteps(value, { field = "steps", min = 1, max = 50, fallback = 1 } = {}) {
  const numeric = value == null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be a number between ${min} and ${max}`, {
      field,
      min,
      max,
      value
    });
  }
  const rounded = Math.round(numeric);
  if (rounded < min || rounded > max) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be a number between ${min} and ${max}`, {
      field,
      min,
      max,
      value: rounded
    });
  }
  return rounded;
}

function parseProfileTheme(value, { field = "theme", partial = false } = {}) {
  if (value == null) {
    return partial ? null : null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("ERR_VALIDATION", `${field} must be an object or null`, { field });
  }

  const out = {};
  for (const key of THEME_FIELDS) {
    if (!(key in value)) {
      continue;
    }
    const color = optionalString(value, key, null);
    if (color == null || color === "") {
      out[key] = null;
      continue;
    }
    if (!THEME_COLOR_RE.test(color)) {
      throw new AppError("ERR_INVALID_COLOR", `${field}.${key} must be a hex color`, {
        field: `${field}.${key}`,
        value: color
      });
    }
    out[key] = color.toLowerCase();
  }

  if (!Object.keys(out).length) {
    return null;
  }
  return out;
}

function validateOperatorOverrideInput(input) {
  const action = optionalString(input, "action");
  if (!action || !isOperatorAction(action)) {
    throw new AppError("ERR_INVALID_ENUM", "action must be a valid operator override action", {
      field: "action",
      allowed: Object.values(OPERATOR_ACTIONS)
    });
  }

  const targetActorId = optionalString(input, "targetActorId", null);
  if (
    (action === OPERATOR_ACTIONS.MUTE_AGENT ||
      action === OPERATOR_ACTIONS.UNMUTE_AGENT ||
      action === OPERATOR_ACTIONS.FORCE_LEAVE) &&
    !targetActorId
  ) {
    throw new AppError("ERR_MISSING_FIELD", "Missing required field: targetActorId", {
      field: "targetActorId"
    });
  }

  return {
    action,
    targetActorId,
    reason: optionalString(input, "reason", null),
    metadata: optionalObject(input, "metadata", {})
  };
}

function parseTaskState(value, { field = "state", fallback = "open" } = {}) {
  const state = String(value == null ? fallback : value).trim().toLowerCase();
  if (!TASK_STATE_VALUES.has(state)) {
    throw new AppError("ERR_INVALID_ENUM", `${field} must be one of open|active|done`, {
      field,
      allowed: [...TASK_STATE_VALUES]
    });
  }
  return state;
}

function parseTaskProgress(value, { field = "progress", fallback = 0 } = {}) {
  const number = value == null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be a number between 0 and 100`, {
      field,
      min: 0,
      max: 100,
      value
    });
  }
  const rounded = Math.round(number);
  if (rounded < 0 || rounded > 100) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be a number between 0 and 100`, {
      field,
      min: 0,
      max: 100,
      value: rounded
    });
  }
  return rounded;
}

function sanitizeTaskPatch(input) {
  const allowed = ["title", "description", "state", "assigneeActorId", "progress", "metadata"];
  const out = {};
  for (const key of allowed) {
    if (key in input) {
      out[key] = input[key];
    }
  }
  return out;
}

function validateTaskInput(input, { partial = false } = {}) {
  const out = {};

  if (!partial || "title" in input) {
    const title = optionalString(input, "title", null);
    if (title == null || !title.trim()) {
      throw new AppError("ERR_MISSING_FIELD", "Missing required field: title", {
        field: "title"
      });
    }
    out.title = title.trim();
  }

  if (!partial || "description" in input) {
    out.description = optionalString(input, "description", null);
  }

  if (!partial || "state" in input) {
    out.state = parseTaskState(input.state, { field: "state", fallback: "open" });
  }

  if (!partial || "assigneeActorId" in input) {
    out.assigneeActorId = optionalString(input, "assigneeActorId", null);
  }

  if (!partial || "progress" in input) {
    out.progress = parseTaskProgress(input.progress, { field: "progress", fallback: 0 });
  }

  if (!partial || "metadata" in input) {
    out.metadata = optionalObject(input, "metadata", {});
  }

  if (partial && Object.keys(out).length === 0) {
    throw new AppError("ERR_VALIDATION", "At least one task field must be provided", {
      fields: ["title", "description", "state", "assigneeActorId", "progress", "metadata"]
    });
  }

  return out;
}

function parseSharedObjectType(value, { field = "objectType", fallback = "note" } = {}) {
  const objectType = String(value == null ? fallback : value).trim().toLowerCase();
  if (!OBJECT_TYPE_VALUES.has(objectType)) {
    throw new AppError(
      "ERR_INVALID_ENUM",
      `${field} must be one of whiteboard|note|token`,
      {
        field,
        allowed: [...OBJECT_TYPE_VALUES]
      }
    );
  }
  return objectType;
}

function parseSharedObjectQuantity(value, { field = "quantity", fallback = null } = {}) {
  if (value == null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be an integer >= 0`, {
      field,
      min: 0,
      value
    });
  }
  const rounded = Math.round(number);
  if (rounded < 0) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be an integer >= 0`, {
      field,
      min: 0,
      value: rounded
    });
  }
  return rounded;
}

function sanitizeSharedObjectPatch(input) {
  const allowed = ["objectType", "objectKey", "title", "content", "data", "quantity", "metadata"];
  const out = {};
  for (const key of allowed) {
    if (key in input) {
      out[key] = input[key];
    }
  }
  return out;
}

function validateSharedObjectInput(input, { partial = false } = {}) {
  const out = {};

  if (!partial || "objectType" in input) {
    out.objectType = parseSharedObjectType(input.objectType, {
      field: "objectType",
      fallback: "note"
    });
  }

  if (!partial || "objectKey" in input) {
    out.objectKey = optionalString(input, "objectKey", null);
  }

  if (!partial || "title" in input) {
    out.title = optionalString(input, "title", null);
  }

  if (!partial || "content" in input) {
    out.content = optionalString(input, "content", null);
  }

  if (!partial || "data" in input) {
    out.data = optionalObject(input, "data", {});
  }

  if (!partial || "quantity" in input) {
    out.quantity = parseSharedObjectQuantity(input.quantity, {
      field: "quantity",
      fallback: null
    });
  }

  if (!partial || "metadata" in input) {
    out.metadata = optionalObject(input, "metadata", {});
  }

  if (!partial && out.objectType === "token" && out.quantity == null) {
    out.quantity = 0;
  }

  if (partial && Object.keys(out).length === 0) {
    throw new AppError("ERR_VALIDATION", "At least one shared object field must be provided", {
      fields: ["objectType", "objectKey", "title", "content", "data", "quantity", "metadata"]
    });
  }

  return out;
}

function parseRoomType(value, { field = "roomType", fallback = "lobby" } = {}) {
  const roomType = String(value == null ? fallback : value).trim().toLowerCase();
  if (!ROOM_TYPE_VALUES.has(roomType)) {
    throw new AppError("ERR_INVALID_ENUM", `${field} must be one of lobby|private_table`, {
      field,
      allowed: [...ROOM_TYPE_VALUES]
    });
  }
  return roomType;
}

function parseTableSessionStatus(value, { field = "status", fallback = "active" } = {}) {
  const status = String(value == null ? fallback : value).trim().toLowerCase();
  if (!TABLE_SESSION_STATUS_VALUES.has(status)) {
    throw new AppError("ERR_INVALID_ENUM", `${field} must be one of active|ended`, {
      field,
      allowed: [...TABLE_SESSION_STATUS_VALUES]
    });
  }
  return status;
}

function parseActorIdList(value, { field = "actorIds" } = {}) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AppError("ERR_VALIDATION", `${field} must be an array of actor ids`, { field });
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

function parseUsdAmount(value, { field = "amountUsd", fallback = PRIVATE_TABLE_PRICE_USD } = {}) {
  const parsed = value == null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be a non-negative number`, {
      field,
      min: 0,
      value
    });
  }
  return Math.round(parsed * 100) / 100;
}

function parseDurationMinutes(value, { field = "durationMinutes", fallback = PRIVATE_TABLE_DEFAULT_SESSION_MINUTES } = {}) {
  const parsed = value == null || value === "" ? Number(fallback) : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be between 5 and 1440`, {
      field,
      min: 5,
      max: 1440,
      value
    });
  }
  const rounded = Math.round(parsed);
  if (rounded < 5 || rounded > 1440) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `${field} must be between 5 and 1440`, {
      field,
      min: 5,
      max: 1440,
      value: rounded
    });
  }
  return rounded;
}

function defaultTablePlanCatalog() {
  return {
    espresso: {
      planId: "espresso",
      maxAgents: 2,
      durationMinutes: 30,
      features: ["basic_thread_chat"],
      price: 3
    },
    cappuccino: {
      planId: "cappuccino",
      maxAgents: 4,
      durationMinutes: 90,
      features: ["basic_thread_chat", "task_board", "shared_objects"],
      price: 6
    },
    americano: {
      planId: "americano",
      maxAgents: 8,
      durationMinutes: 240,
      features: ["basic_thread_chat", "task_board", "shared_objects", "replay", "event_subscriptions", "export"],
      price: 10
    },
    decaf_night_shift: {
      planId: "decaf_night_shift",
      maxAgents: 8,
      durationMinutes: 720,
      features: ["basic_thread_chat", "task_board", "shared_objects", "replay", "event_subscriptions", "export"],
      price: 15
    }
  };
}

function normalizeFeatureList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const feature = String(item || "").trim().toLowerCase();
    if (!feature || seen.has(feature)) {
      continue;
    }
    seen.add(feature);
    out.push(feature);
  }
  return out;
}

function normalizePlanId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

function normalizeTablePlan(id, raw) {
  const planId = normalizePlanId(id);
  const maxAgents = Math.max(1, Math.min(32, Math.round(Number(raw?.maxAgents || 1))));
  const durationMinutes = Math.max(5, Math.min(1440, Math.round(Number(raw?.durationMinutes || 30))));
  const features = normalizeFeatureList(raw?.features);
  const price = Math.max(0, Math.round(Number(raw?.price || 0) * 100) / 100);
  return {
    planId,
    maxAgents,
    durationMinutes,
    features,
    price
  };
}

function parseTablePlanCatalog(rawJson) {
  const fallback = defaultTablePlanCatalog();
  if (!rawJson) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    const next = {};
    for (const [id, rawPlan] of Object.entries(parsed)) {
      const normalized = normalizeTablePlan(id, rawPlan);
      if (!normalized.planId) {
        continue;
      }
      next[normalized.planId] = normalized;
    }
    return Object.keys(next).length ? next : fallback;
  } catch {
    return fallback;
  }
}

function resolveDefaultTablePlanId(catalog, requestedId) {
  const candidate = normalizePlanId(requestedId);
  if (candidate && catalog[candidate]) {
    return candidate;
  }
  if (catalog.cappuccino) {
    return "cappuccino";
  }
  return Object.keys(catalog)[0] || "espresso";
}

function parseTablePlanId(value, { field = "planId" } = {}) {
  const planId = normalizePlanId(value);
  if (!planId) {
    throw new AppError("ERR_MISSING_FIELD", `Missing required field: ${field}`, { field });
  }
  if (!TABLE_PLAN_CATALOG[planId]) {
    throw new AppError("ERR_INVALID_ENUM", `${field} must reference a configured table plan`, {
      field,
      value,
      allowed: Object.keys(TABLE_PLAN_CATALOG)
    });
  }
  return planId;
}

function resolveTablePlan(planId) {
  const normalized = normalizePlanId(planId);
  return TABLE_PLAN_CATALOG[normalized] || TABLE_PLAN_CATALOG[TABLE_PLAN_DEFAULT_ID];
}

function tableSessionExpired(session, nowMs = Date.now()) {
  const expiresMs = Date.parse(session?.expiresAt || "");
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function actorCanUseTableSession(session, actorId) {
  if (!session || !actorId) {
    return false;
  }
  if (session.ownerActorId === actorId) {
    return true;
  }
  return Array.isArray(session.invitedActorIds) && session.invitedActorIds.includes(actorId);
}

async function resolveActiveTableSession({ tenantId, roomId, actorId, nowMs = Date.now() }) {
  const sessions = await tableSessionStore.list({
    tenantId,
    roomId,
    status: "active",
    limit: 250
  });
  let firstNonExpired = null;
  let firstExpired = null;
  for (const session of sessions) {
    if (tableSessionExpired(session, nowMs)) {
      if (!firstExpired) {
        firstExpired = session;
      }
      continue;
    }
    if (!firstNonExpired) {
      firstNonExpired = session;
    }
    if (actorCanUseTableSession(session, actorId)) {
      return {
        session,
        plan: resolveTablePlan(session.planId)
      };
    }
  }
  if (firstNonExpired) {
    return {
      session: firstNonExpired,
      plan: resolveTablePlan(firstNonExpired.planId)
    };
  }
  return {
    session: null,
    plan: null,
    expiredSession: firstExpired
  };
}

async function enforceTableSessionAccess({
  tenantId,
  roomId,
  actorId,
  action,
  checkSeatCap = false,
  requiredFeature = null
}) {
  const room = await roomStore.get({ tenantId, roomId });
  if (!room || room.roomType !== "private_table") {
    return null;
  }

  if (!actorId) {
    throw new AppError("ERR_MISSING_FIELD", "Missing required field: actorId", {
      field: "actorId",
      roomId,
      action
    });
  }

  const nowMs = Date.now();
  const resolved = await resolveActiveTableSession({
    tenantId,
    roomId,
    actorId,
    nowMs
  });

  if (!resolved.session) {
    if (resolved.expiredSession) {
      throw new AppError("ERR_FORBIDDEN", "Private table session has expired", {
        tenantId,
        roomId,
        actorId,
        action,
        sessionId: resolved.expiredSession.sessionId,
        expiredAt: resolved.expiredSession.expiresAt
      }, 403);
    }
    throw new AppError("ERR_PAYMENT_REQUIRED", "No active private table session for this room", {
      tenantId,
      roomId,
      actorId,
      action
    }, 402);
  }

  const { session, plan } = resolved;
  if (tableSessionExpired(session, nowMs)) {
    throw new AppError("ERR_FORBIDDEN", "Private table session has expired", {
      tenantId,
      roomId,
      actorId,
      action,
      sessionId: session.sessionId,
      expiredAt: session.expiresAt
    }, 403);
  }

  if (!actorCanUseTableSession(session, actorId)) {
    throw new AppError("ERR_FORBIDDEN", "Actor is not allowed in this private table session", {
      tenantId,
      roomId,
      actorId,
      action,
      sessionId: session.sessionId
    }, 403);
  }

  if (requiredFeature && !plan.features.includes(requiredFeature)) {
    throw new AppError("ERR_PLAN_FEATURE_DISABLED", `Plan '${plan.planId}' does not include '${requiredFeature}'`, {
      tenantId,
      roomId,
      actorId,
      action,
      sessionId: session.sessionId,
      planId: plan.planId,
      requiredFeature,
      enabledFeatures: plan.features
    }, 403);
  }

  if (checkSeatCap) {
    const activePresence = await presenceStore.list({
      tenantId,
      roomId,
      active: true,
      limit: 1000
    });
    const activeActorIds = new Set(activePresence.map((row) => row.actorId).filter(Boolean));
    if (!activeActorIds.has(actorId) && activeActorIds.size >= plan.maxAgents) {
      throw new AppError("ERR_OUT_OF_BOUNDS", "Private table seat capacity reached", {
        tenantId,
        roomId,
        actorId,
        action,
        sessionId: session.sessionId,
        planId: plan.planId,
        maxAgents: plan.maxAgents,
        activeAgents: activeActorIds.size
      });
    }
  }

  return {
    room,
    session,
    plan
  };
}

async function verifyPrivateTablePayment({
  tenantId,
  roomId,
  ownerActorId,
  paymentProof,
  paymentRef,
  amountUsd = PRIVATE_TABLE_PRICE_USD,
  requestId
}) {
  const mode = PRIVATE_TABLE_PAYMENT_MODE || "stub";
  const normalizedAmountUsd = parseUsdAmount(amountUsd, { field: "paymentAmountUsd" });
  if (mode === "off") {
    return {
      verified: true,
      paymentProvider: "off",
      paymentRef: paymentRef || null,
      amountUsd: normalizedAmountUsd
    };
  }

  if (mode === "stub") {
    const proof = String(paymentProof || "").trim();
    if (!proof || proof !== PRIVATE_TABLE_PAYMENT_STUB_PROOF) {
      throw new AppError("ERR_PAYMENT_REQUIRED", "Payment required to create a private table", {
        tenantId,
        roomId,
        ownerActorId,
        expectedProofHint: "Provide paymentProof accepted by current payment gate mode",
        mode,
        amountUsd: normalizedAmountUsd
      }, 402);
    }
    return {
      verified: true,
      paymentProvider: "stub",
      paymentRef: paymentRef || proof,
      amountUsd: normalizedAmountUsd
    };
  }

  if (mode === "webhook") {
    if (!PRIVATE_TABLE_PAYMENT_WEBHOOK_URL) {
      throw new AppError("ERR_PAYMENT_REQUIRED", "Payment verification is not configured", {
        mode,
        reason: "PRIVATE_TABLE_PAYMENT_WEBHOOK_URL is missing"
      }, 402);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, PRIVATE_TABLE_PAYMENT_WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(PRIVATE_TABLE_PAYMENT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId
        },
        body: JSON.stringify({
          tenantId,
          roomId,
          ownerActorId,
          paymentProof: paymentProof || null,
          paymentRef: paymentRef || null,
          amountUsd: normalizedAmountUsd
        }),
        signal: controller.signal
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const paid = Boolean(payload?.paid ?? payload?.ok);
      if (!response.ok || !paid) {
        throw new AppError("ERR_PAYMENT_REQUIRED", "Payment verification failed", {
          mode,
          status: response.status,
          providerMessage: payload?.message || null
        }, 402);
      }
      return {
        verified: true,
        paymentProvider: String(payload?.provider || "webhook"),
        paymentRef: String(payload?.paymentRef || paymentRef || "").trim() || null,
        amountUsd: normalizedAmountUsd
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("ERR_PAYMENT_REQUIRED", "Payment verification failed", {
        mode,
        cause: error instanceof Error ? error.message : String(error)
      }, 402);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new AppError("ERR_PAYMENT_REQUIRED", "Unknown payment gate mode", { mode }, 402);
}

function parseTypes(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, fallback = undefined) {
  if (value == null || value === "") {
    return fallback;
  }
  const text = String(value).toLowerCase();
  if (text === "true" || text === "1" || text === "yes") {
    return true;
  }
  if (text === "false" || text === "0" || text === "no") {
    return false;
  }
  return fallback;
}

function parseIsoQuery(value, { field }) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new AppError("ERR_VALIDATION", `${field} must be a valid ISO-8601 timestamp`, {
      field,
      value
    });
  }
  return new Date(parsed).toISOString();
}

function parseIsoInput(value, { field, fallback = null } = {}) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new AppError("ERR_VALIDATION", `${field} must be a valid ISO-8601 timestamp`, {
      field,
      value
    });
  }
  return new Date(parsed).toISOString();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function writeSseEvent(res, { type, data, id }) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  if (type) {
    res.write(`event: ${type}\n`);
  }
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function mutatingRoute(pathname, method) {
  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    return false;
  }
  if (COMMAND_ROUTES.has(pathname)) {
    return true;
  }
  if (
    pathname === "/v1/intents/execute" ||
    pathname === "/v1/snapshots/room" ||
    pathname === "/v1/snapshots/agent" ||
    pathname === "/v1/presence/heartbeat" ||
    pathname === "/v1/rooms/context/pin" ||
    pathname === "/v1/permissions" ||
    pathname === "/v1/operator/overrides" ||
    pathname === "/v1/tasks" ||
    pathname === "/v1/objects" ||
    pathname === "/v1/rooms" ||
    pathname === "/v1/table-sessions" ||
    pathname === "/v1/profiles" ||
    pathname === "/v1/reactions/subscriptions" ||
    pathname === "/v1/subscriptions" ||
    pathname === "/v1/inbox/ack"
  ) {
    return true;
  }
  if (
    pathname.startsWith("/v1/subscriptions/") ||
    pathname.startsWith("/v1/reactions/subscriptions/") ||
    pathname.startsWith("/v1/tasks/") ||
    pathname.startsWith("/v1/objects/") ||
    pathname.startsWith("/v1/rooms/") ||
    pathname.startsWith("/v1/table-sessions/") ||
    pathname.startsWith("/v1/profiles/") ||
    pathname.startsWith("/v1/inbox/")
  ) {
    return true;
  }
  return false;
}

function requireIdempotencyKey(req) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key.trim()) {
    throw new AppError("ERR_IDEMPOTENCY_KEY_REQUIRED");
  }
  return key.trim();
}

function readProvidedAuthToken(req, url) {
  const headerKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : "";
  if (headerKey) {
    return headerKey;
  }
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, "").trim();
  }
  return String(url.searchParams.get(API_AUTH_QUERY_PARAM) || "").trim();
}

function requireRuntimeAuth(req, res, url, requestId, rateHeaders) {
  if (!API_AUTH_TOKEN) {
    return true;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return true;
  }
  if (readProvidedAuthToken(req, url) === API_AUTH_TOKEN) {
    return true;
  }
  const unauthorized = new AppError("ERR_FORBIDDEN", "Unauthorized", {
    auth: {
      header: "x-api-key",
      query: API_AUTH_QUERY_PARAM
    }
  }, 401);
  json(res, 401, errorBody(unauthorized, requestId), {
    "x-request-id": requestId,
    ...rateHeaders
  });
  return false;
}

function sendError(res, requestId, error, rateHeaders = {}) {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const normalized = normalizeError(error);
  const correlationId = normalized.details?.correlationId;
  json(res, normalized.status, errorBody(normalized, requestId), {
    "x-request-id": requestId,
    ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    ...rateHeaders
  });
}

function buildPayload(type, body) {
  if (type === EVENT_TYPES.MOVE) {
    return {
      direction: parseMoveDirection(requireString(body, "direction"), { field: "direction" }),
      steps: parseBoundedSteps(body.steps, { field: "steps", min: 1, max: 50, fallback: 1 }),
      intent: optionalString(body, "intent")
    };
  }

  if (type === EVENT_TYPES.CONVERSATION_MESSAGE) {
    requireString(body, "text");
    const conversation = buildConversationObject(body, { maxTextLength: API_MAX_CHAT_MESSAGE_CHARS });
    return {
      conversation,
      bubble: {
        text: conversation.text,
        ttlMs: Math.max(2000, Math.min(30000, Number(body.ttlMs || 7000)))
      }
    };
  }

  if (type === EVENT_TYPES.ORDER) {
    return {
      itemId: requireString(body, "itemId"),
      size: optionalString(body, "size", "regular")
    };
  }

  return optionalObject(body, "payload", {});
}

function createTraceContext({ requestId, route, method, body, tenantId, roomId, actorId }) {
  const trace = traces.start({
    requestId,
    correlationId: optionalString(body || {}, "correlationId"),
    route,
    method,
    actorId,
    tenantId,
    roomId
  });
  traces.step(trace.correlationId, REASON_CODES.RC_REQUEST_RECEIVED, {
    route,
    method,
    actorId,
    roomId,
    tenantId
  });
  return trace;
}

async function idempotencyGuard({ req, tenantId, scope, body, traceCorrelationId }) {
  const idempotencyKey = requireIdempotencyKey(req);
  const requestHash = hashRequest({ path: scope, method: req.method, body });
  const check = await idempotency.check({ tenantId, scope, idempotencyKey, requestHash });

  if (check.status === "conflict") {
    throw new AppError("ERR_IDEMPOTENCY_KEY_CONFLICT", undefined, {
      scope,
      idempotencyKey,
      correlationId: traceCorrelationId
    });
  }

  traces.step(
    traceCorrelationId,
    check.status === "replay" ? REASON_CODES.RC_IDEMPOTENCY_REPLAY : REASON_CODES.RC_IDEMPOTENCY_NEW,
    { scope }
  );

  return {
    idempotencyKey,
    requestHash,
    check
  };
}

async function enforceCapability({
  tenantId,
  roomId,
  actorId,
  capability,
  action,
  traceCorrelationId = null
}) {
  if (!capability) {
    return;
  }
  const permissions = await permissionStore.get({ tenantId, roomId, actorId });
  if (!permissions[capability]) {
    throw new AppError(
      "ERR_FORBIDDEN",
      "Permission denied for requested action",
      {
        tenantId,
        roomId,
        actorId,
        capability,
        action,
        correlationId: traceCorrelationId
      },
      403
    );
  }
}

async function enforceOperatorOverrides({
  tenantId,
  roomId,
  actorId,
  action,
  traceCorrelationId = null
}) {
  const state = await operatorOverrideStore.getRoomState({ tenantId, roomId });
  const decision = evaluateOperatorBlock(state, { actorId, action });
  if (!decision.blocked) {
    return;
  }
  if (traceCorrelationId) {
    traces.step(traceCorrelationId, REASON_CODES.RC_OPERATOR_OVERRIDE_BLOCKED, {
      reasonCode: decision.reasonCode,
      ...decision.details
    });
  }
  throw new AppError(
    "ERR_OPERATOR_OVERRIDE_BLOCKED",
    "Action blocked by active operator override",
    {
      tenantId,
      roomId,
      actorId,
      action,
      reasonCode: decision.reasonCode,
      ...decision.details,
      correlationId: traceCorrelationId
    },
    423
  );
}

function enforceModeration({
  tenantId,
  roomId,
  actorId,
  action,
  text = null,
  source = "api",
  traceCorrelationId = null
}) {
  const decision = moderationPolicy.evaluateAndRecord({
    tenantId,
    roomId,
    actorId,
    action,
    text,
    source
  });
  if (decision.allowed) {
    return;
  }
  if (traceCorrelationId) {
    traces.step(traceCorrelationId, REASON_CODES.RC_MODERATION_BLOCKED, {
      reasonCode: decision.reasonCode,
      ...decision.details
    });
  }
  throw new AppError(
    "ERR_MODERATION_BLOCKED",
    "Moderation policy blocked action",
    {
      tenantId,
      roomId,
      actorId,
      action,
      reasonCode: decision.reasonCode,
      ...decision.details,
      correlationId: traceCorrelationId
    },
    429
  );
}

async function emitPresenceHeartbeat({
  tenantId,
  roomId,
  actorId,
  status = "busy",
  ttlMs = PRESENCE_DEFAULT_TTL_MS,
  reason = "activity",
  source = "system",
  correlationId = null,
  causationId = null
}) {
  const heartbeat = await presenceStore.heartbeat({
    tenantId,
    roomId,
    actorId,
    status,
    ttlMs
  });

  const emitted = [];
  const heartbeatEvent = await eventStore.append(
    createEvent({
      tenantId,
      roomId,
      actorId,
      type: EVENT_TYPES.PRESENCE_HEARTBEAT,
      payload: {
        status,
        ttlMs,
        lastHeartbeatAt: heartbeat.state.lastHeartbeatAt,
        expiresAt: heartbeat.state.expiresAt
      },
      correlationId,
      causationId
    })
  );
  emitted.push(heartbeatEvent);

  if (heartbeat.statusChanged) {
    const statusEvent = await eventStore.append(
      createEvent({
        tenantId,
        roomId,
        actorId,
        type: EVENT_TYPES.STATUS_CHANGED,
        payload: {
          from: heartbeat.previousStatus,
          to: heartbeat.state.status,
          reason,
          source,
          lastHeartbeatAt: heartbeat.state.lastHeartbeatAt
        },
        correlationId,
        causationId: heartbeatEvent.eventId
      })
    );
    emitted.push(statusEvent);
  }

  return {
    presence: heartbeat.state,
    emitted
  };
}

async function emitPresenceInactive({
  tenantId,
  roomId,
  actorId,
  reason = "agent_left",
  source = "system",
  correlationId = null,
  causationId = null
}) {
  const inactivated = await presenceStore.setInactive({ tenantId, roomId, actorId });
  if (!inactivated) {
    return {
      presence: null,
      emitted: []
    };
  }
  if (!inactivated.statusChanged) {
    return {
      presence: inactivated.state,
      emitted: []
    };
  }

  const statusEvent = await eventStore.append(
    createEvent({
      tenantId,
      roomId,
      actorId,
      type: EVENT_TYPES.STATUS_CHANGED,
      payload: {
        from: inactivated.previousStatus,
        to: "inactive",
        reason,
        source,
        changedAt: new Date().toISOString(),
        lastHeartbeatAt: inactivated.state.lastHeartbeatAt,
        expiresAt: inactivated.state.expiresAt
      },
      correlationId,
      causationId
    })
  );

  return {
    presence: inactivated.state,
    emitted: [statusEvent]
  };
}

async function applyPresenceFromCommand({
  tenantId,
  roomId,
  actorId,
  commandType,
  correlationId,
  causationId,
  traceCorrelationId = null
}) {
  try {
    if (commandType === EVENT_TYPES.LEAVE) {
      return await emitPresenceInactive({
        tenantId,
        roomId,
        actorId,
        reason: "agent_left",
        source: "agent",
        correlationId,
        causationId
      });
    }

    const status = commandType === EVENT_TYPES.ENTER ? "idle" : "busy";
    return await emitPresenceHeartbeat({
      tenantId,
      roomId,
      actorId,
      status,
      ttlMs: PRESENCE_DEFAULT_TTL_MS,
      reason: "command_activity",
      source: "agent",
      correlationId,
      causationId
    });
  } catch (error) {
    if (traceCorrelationId) {
      traces.step(traceCorrelationId, REASON_CODES.RC_INTERNAL_ERROR, {
        phase: "presence_auto_command",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return {
      presence: null,
      emitted: []
    };
  }
}

async function applyPresenceFromIntent({
  tenantId,
  roomId,
  actorId,
  correlationId,
  causationId,
  traceCorrelationId = null
}) {
  try {
    return await emitPresenceHeartbeat({
      tenantId,
      roomId,
      actorId,
      status: "busy",
      ttlMs: PRESENCE_DEFAULT_TTL_MS,
      reason: "intent_activity",
      source: "agent",
      correlationId,
      causationId
    });
  } catch (error) {
    if (traceCorrelationId) {
      traces.step(traceCorrelationId, REASON_CODES.RC_INTERNAL_ERROR, {
        phase: "presence_auto_intent",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return {
      presence: null,
      emitted: []
    };
  }
}

async function handleCommand(req, res, url, requestId, rateHeaders) {
  const route = COMMAND_ROUTES.get(url.pathname);
  if (!route) {
    throw new AppError("ERR_UNSUPPORTED_ACTION", "Unknown command route", { route: url.pathname }, 404);
  }

  const body = await readJson(req);
  const tenantId = optionalString(body, "tenantId", "default");
  const roomId = optionalString(body, "roomId", "main");
  const actorId = requireString(body, "actorId");
  const trace = createTraceContext({
    requestId,
    route: url.pathname,
    method: req.method,
    body,
    tenantId,
    roomId,
    actorId
  });

  try {
    const scope = `${roomId}:${actorId}:${url.pathname}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    if (route.type !== EVENT_TYPES.LEAVE) {
      await enforceTableSessionAccess({
        tenantId,
        roomId,
        actorId,
        action: route.action,
        checkSeatCap: route.type === EVENT_TYPES.ENTER
      });
    }

    await enforceCapability({
      tenantId,
      roomId,
      actorId,
      capability: capabilityForEventType(route.type),
      action: route.action,
      traceCorrelationId: trace.correlationId
    });
    await enforceOperatorOverrides({
      tenantId,
      roomId,
      actorId,
      action: route.action,
      traceCorrelationId: trace.correlationId
    });

    const payload = buildPayload(route.type, body);
    enforceModeration({
      tenantId,
      roomId,
      actorId,
      action: route.action,
      text:
        route.type === EVENT_TYPES.CONVERSATION_MESSAGE
          ? payload?.conversation?.text || payload?.bubble?.text || null
          : null,
      source: "api",
      traceCorrelationId: trace.correlationId
    });

    const event = createEvent({
      tenantId,
      roomId,
      actorId,
      type: route.type,
      payload,
      correlationId: trace.correlationId,
      causationId: optionalString(body, "causationId")
    });

    const persisted = await eventStore.append(event);
    traces.step(trace.correlationId, REASON_CODES.RC_EVENT_APPEND_OK, {
      eventId: persisted.eventId,
      sequence: persisted.sequence,
      eventType: persisted.type
    });

    const generatedEvents = [persisted];
    if (route.type === EVENT_TYPES.CONVERSATION_MESSAGE) {
      const mentions = Array.isArray(payload?.conversation?.mentions)
        ? payload.conversation.mentions
        : [];
      for (const mentionedActorId of mentions) {
        const mentionEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId,
            actorId,
            type: EVENT_TYPES.MENTION_CREATED,
            payload: {
              mentionedActorId,
              sourceMessageId: payload.conversation?.messageId || persisted.eventId,
              threadId: payload.conversation?.threadId || payload.conversation?.messageId || null
            },
            correlationId: trace.correlationId,
            causationId: persisted.eventId
          })
        );
        generatedEvents.push(mentionEvent);
      }
    }

    const presenceSideEffect = await applyPresenceFromCommand({
      tenantId,
      roomId,
      actorId,
      commandType: route.type,
      correlationId: trace.correlationId,
      causationId: persisted.eventId,
      traceCorrelationId: trace.correlationId
    });
    generatedEvents.push(...presenceSideEffect.emitted);

    const response = {
      ok: true,
      data: {
        accepted: true,
        action: route.action,
        eventId: persisted.eventId,
        sequence: persisted.sequence,
        correlationId: trace.correlationId,
        eventType: persisted.type,
        emittedEvents: generatedEvents.map((item) => ({
          eventId: item.eventId,
          sequence: item.sequence,
          eventType: item.type
        })),
        presence: presenceSideEffect.presence,
        actorId,
        roomId,
        tenantId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 202,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success", { replay: false });

    return json(res, 202, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  } catch (error) {
    traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
      message: error instanceof Error ? error.message : String(error)
    });
    traces.finish(trace.correlationId, "error");
    if (error instanceof AppError) {
      error.details = {
        ...(error.details || {}),
        correlationId: trace.correlationId
      };
    }
    throw error;
  }
}

async function handleIntent(req, res, url, requestId, rateHeaders) {
  const body = await readJson(req);
  const tenantId = optionalString(body, "tenantId", "default");
  const roomId = optionalString(body, "roomId", "main");
  const actorId = requireString(body, "actorId");
  const intent = requireString(body, "intent");
  const payload = optionalObject(body, "payload", body);

  const trace = createTraceContext({
    requestId,
    route: url.pathname,
    method: req.method,
    body,
    tenantId,
    roomId,
    actorId
  });

  try {
    const scope = `${roomId}:${actorId}:${url.pathname}:${intent}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    await enforceTableSessionAccess({
      tenantId,
      roomId,
      actorId,
      action: `intent:${intent}`
    });

    await enforceCapability({
      tenantId,
      roomId,
      actorId,
      capability: "canMove",
      action: intent,
      traceCorrelationId: trace.correlationId
    });
    await enforceOperatorOverrides({
      tenantId,
      roomId,
      actorId,
      action: intent,
      traceCorrelationId: trace.correlationId
    });
    enforceModeration({
      tenantId,
      roomId,
      actorId,
      action: `intent:${intent}`,
      source: "api",
      traceCorrelationId: trace.correlationId
    });

    const from = planner.getPosition({ tenantId, roomId, actorId });
    const resolved = planner.resolveTarget(intent, payload);
    const path = planner.planPath(from, resolved.target);

    traces.step(trace.correlationId, REASON_CODES.RC_INTENT_PLANNED, {
      intent,
      from,
      target: resolved.target,
      path
    });

    const generated = [];

    const plannedEvent = await eventStore.append(
      createEvent({
        tenantId,
        roomId,
        actorId,
        type: EVENT_TYPES.INTENT_PLANNED,
        payload: {
          intent,
          target: resolved.target,
          label: resolved.label,
          from,
          path
        },
        correlationId: trace.correlationId
      })
    );
    generated.push(plannedEvent);

    let current = { ...from };
    for (const move of path) {
      if (move.direction === "N") {
        current.y -= move.steps;
      } else if (move.direction === "S") {
        current.y += move.steps;
      } else if (move.direction === "E") {
        current.x += move.steps;
      } else if (move.direction === "W") {
        current.x -= move.steps;
      }

      const moveEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId,
          actorId,
          type: EVENT_TYPES.MOVE,
          payload: {
            direction: move.direction,
            steps: move.steps,
            intent,
            targetLabel: resolved.label
          },
          correlationId: trace.correlationId,
          causationId: plannedEvent.eventId
        })
      );
      generated.push(moveEvent);
    }

    planner.setPosition({
      tenantId,
      roomId,
      actorId,
      x: resolved.target.x,
      y: resolved.target.y
    });

    const completedEvent = await eventStore.append(
      createEvent({
        tenantId,
        roomId,
        actorId,
        type: EVENT_TYPES.INTENT_COMPLETED,
        payload: {
          intent,
          target: resolved.target,
          label: resolved.label,
          finalPosition: resolved.target,
          outcome: intent === "sit_at_table" ? "seated" : "arrived"
        },
        correlationId: trace.correlationId,
        causationId: plannedEvent.eventId
      })
    );
    generated.push(completedEvent);

    traces.step(trace.correlationId, REASON_CODES.RC_INTENT_EXECUTED, {
      intent,
      emittedEvents: generated.length
    });

    const presenceSideEffect = await applyPresenceFromIntent({
      tenantId,
      roomId,
      actorId,
      correlationId: trace.correlationId,
      causationId: completedEvent.eventId,
      traceCorrelationId: trace.correlationId
    });
    generated.push(...presenceSideEffect.emitted);

    const response = {
      ok: true,
      data: {
        accepted: true,
        intent,
        label: resolved.label,
        from,
        target: resolved.target,
        path,
        correlationId: trace.correlationId,
        eventIds: generated.map((item) => item.eventId),
        finalEventId: completedEvent.eventId,
        finalSequence: completedEvent.sequence,
        presence: presenceSideEffect.presence
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 202,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success", { replay: false });

    return json(res, 202, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  } catch (error) {
    traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
      message: error instanceof Error ? error.message : String(error),
      intent
    });
    traces.finish(trace.correlationId, "error");
    if (error instanceof AppError) {
      error.details = {
        ...(error.details || {}),
        correlationId: trace.correlationId
      };
    }
    throw error;
  }
}

async function handleSnapshotCreate(req, res, url, requestId, rateHeaders, scopeKind) {
  const body = await readJson(req);
  const tenantId = optionalString(body, "tenantId", "default");
  const roomId = optionalString(body, "roomId", "main");
  const actorId = scopeKind === "agent" ? requireString(body, "actorId") : optionalString(body, "actorId", "system");
  const state = optionalObject(body, "state", {});
  const ttlSeconds = Number(body.ttlSeconds || 3600);

  const trace = createTraceContext({
    requestId,
    route: url.pathname,
    method: req.method,
    body,
    tenantId,
    roomId,
    actorId
  });

  try {
    const scope = `${roomId}:${scopeKind}:${actorId || "-"}:${url.pathname}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const snapshot =
      scopeKind === "room"
        ? await snapshots.createRoomSnapshot({ tenantId, roomId, state, ttlSeconds })
        : await snapshots.createAgentSnapshot({ tenantId, roomId, actorId, state, ttlSeconds });

    await eventStore.append(
      createEvent({
        tenantId,
        roomId,
        actorId: actorId || "system",
        type: EVENT_TYPES.SNAPSHOT_CREATED,
        payload: {
          scope: scopeKind,
          version: snapshot.version,
          expiresAt: snapshot.expiresAt,
          snapshotRef: {
            roomId,
            actorId: scopeKind === "agent" ? actorId : null
          }
        },
        correlationId: trace.correlationId
      })
    );

    traces.step(trace.correlationId, REASON_CODES.RC_SNAPSHOT_CREATED, {
      scope: scopeKind,
      version: snapshot.version
    });

    const response = {
      ok: true,
      data: {
        snapshot,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 201,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 201, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  } catch (error) {
    traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
      message: error instanceof Error ? error.message : String(error),
      scope: scopeKind
    });
    traces.finish(trace.correlationId, "error");
    if (error instanceof AppError) {
      error.details = {
        ...(error.details || {}),
        correlationId: trace.correlationId
      };
    }
    throw error;
  }
}

async function handleSnapshotRead(req, res, url, requestId, rateHeaders, scopeKind) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const version = url.searchParams.get("version") || undefined;
  const actorId = scopeKind === "agent" ? url.searchParams.get("actorId") : null;

  if (scopeKind === "agent" && !actorId) {
    throw new AppError("ERR_MISSING_FIELD", "Missing required field: actorId", { field: "actorId" });
  }

  const snapshot =
    scopeKind === "room"
      ? await snapshots.findRoom({ tenantId, roomId, version })
      : await snapshots.findAgent({ tenantId, roomId, actorId, version });

  if (!snapshot) {
    throw new AppError("ERR_NOT_FOUND", "Snapshot not found", {
      tenantId,
      roomId,
      actorId,
      version
    }, 404);
  }

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        snapshot
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleEvents(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || undefined;
  const roomId = url.searchParams.get("roomId") || undefined;
  const actorId = url.searchParams.get("actorId") || undefined;
  const afterEventId = url.searchParams.get("afterEventId") || undefined;
  const afterCursor = url.searchParams.get("cursor") || undefined;
  const limit = url.searchParams.get("limit") || undefined;
  const types = parseTypes(url.searchParams.get("types"));

  const events = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    afterEventId,
    afterCursor,
    limit,
    types,
    order: "asc"
  });

  const nextCursor = events.length ? events[events.length - 1].sequence : Number(afterCursor || 0);

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        events,
        count: events.length,
        nextCursor
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleMentions(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || undefined;
  const roomId = url.searchParams.get("roomId") || undefined;
  const mentionedActorId = url.searchParams.get("mentionedActorId") || undefined;
  const cursor = url.searchParams.get("cursor") || undefined;
  const limit = url.searchParams.get("limit") || undefined;

  let events = await eventStore.list({
    tenantId,
    roomId,
    afterCursor: cursor,
    limit,
    types: [EVENT_TYPES.MENTION_CREATED],
    order: "asc"
  });

  if (mentionedActorId) {
    events = events.filter((event) => event.payload?.mentionedActorId === mentionedActorId);
  }

  const nextCursor = events.length ? events[events.length - 1].sequence : Number(cursor || 0);

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        mentions: events,
        count: events.length,
        nextCursor
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleInbox(req, res, url, requestId, rateHeaders) {
  const singleAckMatch = url.pathname.match(/^\/v1\/inbox\/([^/]+)\/ack$/);

  if (req.method === "GET" && url.pathname === "/v1/inbox") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const actorId = url.searchParams.get("actorId") || undefined;
    const unreadOnly = parseBool(url.searchParams.get("unreadOnly"), false);
    const cursor = url.searchParams.get("cursor") || undefined;
    const limit = Number(url.searchParams.get("limit") || 100);
    const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";

    const items = await inboxStore.list({
      tenantId,
      roomId,
      actorId,
      unreadOnly: Boolean(unreadOnly),
      cursor,
      limit,
      order
    });
    const nextCursor = items.length ? items[items.length - 1].inboxSeq : Number(cursor || 0);
    const unreadCount = await inboxStore.countUnread({ tenantId, roomId, actorId });
    let projectedUnreadCount = null;
    if (actorId && roomId && inboxCounterStore?.enabled) {
      try {
        projectedUnreadCount = await inboxCounterStore.get({
          tenantId,
          roomId,
          actorId
        });
      } catch {
        projectedUnreadCount = null;
      }
    }

    return json(
      res,
      200,
      {
        ok: true,
        data: {
          tenantId,
          roomId: roomId || null,
          actorId: actorId || null,
          unreadOnly: Boolean(unreadOnly),
          order,
          count: items.length,
          nextCursor,
          unreadCount,
          projectedUnreadCount,
          items
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && singleAckMatch) {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", url.searchParams.get("tenantId") || "default");
    const actorId = requireString(body, "actorId");
    const inboxId = decodeURIComponent(singleAckMatch[1]);
    if (!isUuid(inboxId)) {
      throw new AppError("ERR_VALIDATION", "inboxId must be a UUID", {
        field: "inboxId",
        value: inboxId
      });
    }
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId
    });

    try {
      const scope = `${tenantId}:${actorId}:inbox:${inboxId}:ack`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      const acked = await inboxStore.ackOne({
        tenantId,
        actorId,
        inboxId,
        ackedBy: optionalString(body, "ackedBy", actorId)
      });
      if (!acked) {
        throw new AppError("ERR_NOT_FOUND", "Inbox item not found", {
          tenantId,
          actorId,
          inboxId
        }, 404);
      }

      const unreadCount = await inboxStore.countUnread({
        tenantId,
        roomId: acked.item.roomId,
        actorId
      });
      const response = {
        ok: true,
        data: {
          item: acked.item,
          changed: acked.changed,
          unreadCount,
          correlationId: trace.correlationId
        }
      };

      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "inbox_ack_single"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/inbox/ack") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const actorId = requireString(body, "actorId");
    const roomId = optionalString(body, "roomId", null);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    for (const id of ids) {
      if (!isUuid(id)) {
        throw new AppError("ERR_VALIDATION", "ids[] values must be UUIDs", {
          field: "ids",
          value: id
        });
      }
    }
    const upToCursor =
      body.upToCursor == null || body.upToCursor === "" ? null : Number(body.upToCursor);
    if (ids.length === 0 && !Number.isFinite(upToCursor)) {
      throw new AppError("ERR_VALIDATION", "Bulk ack requires ids[] and/or upToCursor", {
        fields: ["ids", "upToCursor"]
      });
    }

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: roomId || undefined,
      actorId
    });

    try {
      const scope = `${tenantId}:${actorId}:inbox:ack:${roomId || "all"}`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      const acked = await inboxStore.ackMany({
        tenantId,
        actorId,
        roomId: roomId || undefined,
        ids,
        upToCursor,
        ackedBy: optionalString(body, "ackedBy", actorId)
      });
      const unreadCount = await inboxStore.countUnread({
        tenantId,
        roomId: roomId || undefined,
        actorId
      });
      const response = {
        ok: true,
        data: {
          ackedCount: acked.ackedCount,
          ackedIds: acked.ackedIds,
          unreadCount,
          correlationId: trace.correlationId
        }
      };

      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "inbox_ack_bulk"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Inbox route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

async function handleTimeline(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || undefined;
  const roomId = url.searchParams.get("roomId") || undefined;
  const actorId = url.searchParams.get("actorId") || undefined;
  const cursor = url.searchParams.get("cursor") || undefined;
  const limit = url.searchParams.get("limit") || undefined;
  const fromTs = url.searchParams.get("fromTs") || undefined;
  const toTs = url.searchParams.get("toTs") || undefined;
  const types = parseTypes(url.searchParams.get("types"));
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";

  const events = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    afterCursor: cursor,
    limit,
    types,
    fromTs,
    toTs,
    order
  });

  const nextCursor = events.length
    ? order === "asc"
      ? events[events.length - 1].sequence
      : events[events.length - 1].sequence
    : Number(cursor || 0);

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        events,
        count: events.length,
        order,
        nextCursor,
        fromTs: fromTs || null,
        toTs: toTs || null
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleReplay(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const actorId = url.searchParams.get("actorId") || undefined;
  const types = parseTypes(url.searchParams.get("types"));
  const minutes = Math.max(1, Math.min(Number(url.searchParams.get("minutes") || 10), 120));
  const now = Date.now();
  const fromTs = new Date(now - minutes * 60 * 1000).toISOString();
  const toTs = new Date(now).toISOString();

  await enforceTableSessionAccess({
    tenantId,
    roomId,
    actorId,
    action: "replay",
    requiredFeature: "replay"
  });

  const events = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    limit: 5000,
    types,
    fromTs,
    toTs,
    order: "asc"
  });

  const replayProjection = new ProjectionState();
  for (const event of events) {
    replayProjection.apply(event);
  }

  const snapshot = replayProjection.snapshot(tenantId, roomId);
  const actorIds = new Set();
  for (const actor of snapshot.actors) {
    if (actor?.actorId) {
      actorIds.add(actor.actorId);
    }
  }
  for (const item of snapshot.chat) {
    if (item?.actorId) {
      actorIds.add(item.actorId);
    }
  }
  for (const item of snapshot.messages) {
    if (item?.actorId) {
      actorIds.add(item.actorId);
    }
  }

  const actorThemes = {};
  for (const id of actorIds) {
    const profile = await profileStore.get({ tenantId, actorId: id });
    actorThemes[id] = profile?.theme || null;
  }

  const themedSnapshot = {
    ...snapshot,
    actors: snapshot.actors.map((actor) => ({
      ...actor,
      theme: actorThemes[actor.actorId] || null
    })),
    chat: snapshot.chat.map((item) => ({
      ...item,
      theme: actorThemes[item.actorId] || null
    })),
    messages: snapshot.messages.map((item) => ({
      ...item,
      theme: actorThemes[item.actorId] || null
    })),
    conversationContext: {
      actorThemes
    }
  };
  const startCursor = events.length ? events[0].sequence : null;
  const endCursor = events.length ? events[events.length - 1].sequence : null;

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId,
        window: {
          minutes,
          fromTs,
          toTs,
          startCursor,
          endCursor
        },
        count: events.length,
        events,
        snapshot: themedSnapshot
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleLocalMemory(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const actorId = url.searchParams.get("actorId") || undefined;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 5), 5));

  const events = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    limit,
    types: LOCAL_MEMORY_EVENT_TYPES,
    order: "desc"
  });

  const memory = events.map((event) => {
    const out = {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      actorId: event.actorId,
      ts: event.timestamp
    };
    if (event.type === EVENT_TYPES.CONVERSATION_MESSAGE) {
      out.text =
        event.payload?.conversation?.text || event.payload?.bubble?.text || event.payload?.text || "";
      out.threadId = event.payload?.conversation?.threadId || event.payload?.conversation?.messageId || null;
      out.mentions = Array.isArray(event.payload?.conversation?.mentions)
        ? event.payload.conversation.mentions
        : [];
    } else if (event.type === EVENT_TYPES.ORDER) {
      out.itemId = event.payload?.itemId || null;
      out.size = event.payload?.size || null;
    } else if (event.type === EVENT_TYPES.MOVE) {
      out.direction = event.payload?.direction || null;
      out.steps = Number(event.payload?.steps || 1);
    } else if (event.type === EVENT_TYPES.INTENT_COMPLETED) {
      out.intent = event.payload?.intent || null;
      out.outcome = event.payload?.outcome || null;
    } else if (event.type === EVENT_TYPES.OPERATOR_OVERRIDE_APPLIED) {
      out.action = event.payload?.action || null;
      out.targetActorId = event.payload?.targetActorId || null;
      out.reason = event.payload?.reason || null;
    } else if (event.type === EVENT_TYPES.TASK_CREATED || event.type === EVENT_TYPES.TASK_UPDATED) {
      out.taskId = event.payload?.taskId || null;
      out.state = event.payload?.state || null;
      out.progress = Number(event.payload?.progress || 0);
    } else if (event.type === EVENT_TYPES.TASK_ASSIGNED) {
      out.taskId = event.payload?.taskId || null;
      out.fromAssigneeActorId = event.payload?.fromAssigneeActorId || null;
      out.toAssigneeActorId = event.payload?.toAssigneeActorId || null;
    } else if (event.type === EVENT_TYPES.TASK_PROGRESS_UPDATED) {
      out.taskId = event.payload?.taskId || null;
      out.fromProgress = Number(event.payload?.fromProgress || 0);
      out.toProgress = Number(event.payload?.toProgress || 0);
    } else if (event.type === EVENT_TYPES.TASK_COMPLETED) {
      out.taskId = event.payload?.taskId || null;
      out.completedBy = event.payload?.completedBy || null;
    } else if (
      event.type === EVENT_TYPES.SHARED_OBJECT_CREATED ||
      event.type === EVENT_TYPES.SHARED_OBJECT_UPDATED
    ) {
      out.objectId = event.payload?.objectId || null;
      out.objectType = event.payload?.objectType || null;
      out.objectKey = event.payload?.objectKey || null;
      out.version = Number(event.payload?.version || 1);
      out.changedFields = Array.isArray(event.payload?.changedFields) ? event.payload.changedFields : [];
    }
    return out;
  });

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId,
        actorId: actorId || null,
        memory,
        count: memory.length
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleCollaborationScore(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const fromTs = parseIsoQuery(url.searchParams.get("fromTs"), { field: "fromTs" });
  const toTs = parseIsoQuery(url.searchParams.get("toTs"), { field: "toTs" });
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 5000), 10000));

  const events = await eventStore.list({
    tenantId,
    roomId,
    fromTs: fromTs || undefined,
    toTs: toTs || undefined,
    limit,
    types: COLLABORATION_SCORE_EVENT_TYPES,
    order: "asc"
  });
  const collaboration = calculateCollaborationScore(events);

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId,
        window: {
          fromTs,
          toTs
        },
        eventsConsidered: events.length,
        collaboration
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handlePresenceRead(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || undefined;
  const actorId = url.searchParams.get("actorId") || undefined;
  const active = parseBool(url.searchParams.get("active"), undefined);
  const limit = Number(url.searchParams.get("limit") || 200);

  if (roomId && actorId) {
    const presence = await presenceStore.get({ tenantId, roomId, actorId });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          presence
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const presence = await presenceStore.list({
    tenantId,
    roomId,
    actorId,
    active,
    limit
  });
  return json(
    res,
    200,
    {
      ok: true,
      data: {
        presence,
        count: presence.length
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handlePresenceLastSeen(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || undefined;
  const actorId = url.searchParams.get("actorId") || undefined;
  const includeSystemActors = parseBool(url.searchParams.get("includeSystemActors"), false);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 1000));
  const scanLimit = Math.max(limit, Math.min(Number(url.searchParams.get("scanLimit") || limit * 20), 5000));

  const events = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    limit: scanLimit,
    order: "desc"
  });
  const projected = projectLastSeen(events, {
    actorId,
    limit,
    includeSystemActors
  });

  let presenceByActor = new Map();
  if (roomId) {
    const presence = await presenceStore.list({
      tenantId,
      roomId,
      limit: 1000
    });
    presenceByActor = new Map(presence.map((row) => [row.actorId, row]));
  }

  const withStatus = projected.map((row) => {
    const presence = presenceByActor.get(row.actorId);
    return {
      ...row,
      status: presence?.status || null,
      isActive: typeof presence?.isActive === "boolean" ? presence.isActive : null,
      lastHeartbeatAt: presence?.lastHeartbeatAt || null
    };
  });

  if (actorId) {
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          actorId,
          lastSeen: withStatus[0] || null
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId: roomId || null,
        actors: withStatus,
        count: withStatus.length,
        scanLimitReached: events.length >= scanLimit
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handlePresenceHeartbeat(req, res, url, requestId, rateHeaders) {
  const body = await readJson(req);
  const tenantId = optionalString(body, "tenantId", "default");
  const roomId = optionalString(body, "roomId", "main");
  const actorId = requireString(body, "actorId");
  const status = parsePresenceStatus(optionalString(body, "status", "idle"), "idle");
  const ttlMs = Math.max(1000, Math.min(Number(body.ttlMs || PRESENCE_DEFAULT_TTL_MS), 10 * 60 * 1000));

  const trace = createTraceContext({
    requestId,
    route: url.pathname,
    method: req.method,
    body,
    tenantId,
    roomId,
    actorId
  });

  try {
    const scope = `${tenantId}:${roomId}:${actorId}:presence:heartbeat`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const heartbeat = await emitPresenceHeartbeat({
      tenantId,
      roomId,
      actorId,
      status,
      ttlMs,
      reason: "heartbeat_update",
      source: "agent",
      correlationId: trace.correlationId
    });

    const response = {
      ok: true,
      data: {
        presence: heartbeat.presence,
        emittedEvents: heartbeat.emitted.map((item) => ({
          eventId: item.eventId,
          sequence: item.sequence,
          eventType: item.type
        })),
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 202,
      responseBody: response
    });
    traces.finish(trace.correlationId, "success");
    return json(res, 202, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  } catch (error) {
    traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
      message: error instanceof Error ? error.message : String(error),
      scope: "presence_heartbeat"
    });
    traces.finish(trace.correlationId, "error");
    if (error instanceof AppError) {
      error.details = {
        ...(error.details || {}),
        correlationId: trace.correlationId
      };
    }
    throw error;
  }
}

async function handleRoomPinnedContextRead(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const current = await pinnedContextStore.get({ tenantId, roomId });

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId,
        pinnedContext: current,
        isPinned: Boolean(current)
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleRoomPinnedContextHistory(req, res, url, requestId, rateHeaders) {
  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || "main";
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));
  const history = await pinnedContextStore.listHistory({ tenantId, roomId, limit });

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        tenantId,
        roomId,
        history,
        count: history.length
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleRoomPinnedContextWrite(req, res, url, requestId, rateHeaders) {
  const body = await readJson(req);
  const tenantId = optionalString(body, "tenantId", "default");
  const roomId = optionalString(body, "roomId", "main");
  const actorId = requireString(body, "actorId");
  const content = requireString(body, "content");
  const metadata = optionalObject(body, "metadata", {});

  const trace = createTraceContext({
    requestId,
    route: url.pathname,
    method: req.method,
    body,
    tenantId,
    roomId,
    actorId
  });

  try {
    const scope = `${tenantId}:${roomId}:room-context:pin`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    await enforceCapability({
      tenantId,
      roomId,
      actorId,
      capability: "canModerate",
      action: "room_context_pin",
      traceCorrelationId: trace.correlationId
    });
    enforceModeration({
      tenantId,
      roomId,
      actorId,
      action: "room_context_pin",
      text: content,
      source: "api",
      traceCorrelationId: trace.correlationId
    });

    const pinned = await pinnedContextStore.upsert({
      tenantId,
      roomId,
      actorId,
      content,
      metadata
    });

    const event = await eventStore.append(
      createEvent({
        tenantId,
        roomId,
        actorId,
        type: EVENT_TYPES.ROOM_CONTEXT_PINNED,
        payload: {
          version: pinned.version,
          content: pinned.content,
          metadata: pinned.metadata,
          pinnedBy: pinned.pinnedBy
        },
        correlationId: trace.correlationId
      })
    );

    const response = {
      ok: true,
      data: {
        pinnedContext: pinned,
        eventId: event.eventId,
        sequence: event.sequence,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 201,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 201, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  } catch (error) {
    traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
      message: error instanceof Error ? error.message : String(error),
      scope: "room_context_pin"
    });
    traces.finish(trace.correlationId, "error");
    if (error instanceof AppError) {
      error.details = {
        ...(error.details || {}),
        correlationId: trace.correlationId
      };
    }
    throw error;
  }
}

async function handleMarketStream(req, res, url, requestId) {
  const tenantId = url.searchParams.get("tenantId") || undefined;
  const roomId = url.searchParams.get("roomId") || undefined;
  const actorId = url.searchParams.get("actorId") || undefined;
  const types = parseTypes(url.searchParams.get("types"));
  let cursor = Number(url.searchParams.get("cursor") || 0);
  if (!Number.isFinite(cursor)) {
    cursor = 0;
  }
  const limit = Number(url.searchParams.get("limit") || 200);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": requestId
  });

  writeSseEvent(res, {
    type: "ready",
    data: {
      tenantId: tenantId || null,
      roomId: roomId || null,
      actorId: actorId || null,
      cursor,
      types
    }
  });

  const replay = await eventStore.list({
    tenantId,
    roomId,
    actorId,
    afterCursor: cursor,
    limit,
    types,
    order: "asc"
  });

  for (const event of replay) {
    writeSseEvent(res, {
      id: event.sequence,
      type: event.type,
      data: event
    });
    cursor = event.sequence;
  }

  const unsubscribe = eventStore.subscribe({
    tenantId,
    roomId,
    actorId,
    types,
    onEvent: (event) => {
      writeSseEvent(res, {
        id: event.sequence,
        type: event.type,
        data: event
      });
      cursor = event.sequence;
    }
  });

  const heartbeat = setInterval(() => {
    writeSseEvent(res, {
      type: "heartbeat",
      data: { cursor, ts: Date.now() }
    });
  }, STREAM_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handleTraceLookup(req, res, url, requestId, rateHeaders) {
  const prefix = "/v1/traces/";
  const correlationId = decodeURIComponent(url.pathname.slice(prefix.length));
  const trace = await traces.get(correlationId);
  if (!trace) {
    throw new AppError("ERR_NOT_FOUND", "Trace not found", { correlationId }, 404);
  }

  return json(
    res,
    200,
    {
      ok: true,
      data: {
        trace
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleOperatorAudit(req, res, url, requestId, rateHeaders) {
  if (req.method !== "GET") {
    throw new AppError("ERR_UNSUPPORTED_ACTION", "Operator audit route not found", {
      method: req.method,
      path: url.pathname
    }, 404);
  }

  const tenantId = url.searchParams.get("tenantId") || "default";
  const roomId = url.searchParams.get("roomId") || undefined;
  const operatorId = url.searchParams.get("operatorId") || undefined;
  const action = url.searchParams.get("action") || undefined;
  const fromTs = url.searchParams.get("fromTs") || undefined;
  const toTs = url.searchParams.get("toTs") || undefined;
  const cursor = url.searchParams.get("cursor") || undefined;
  const limit = Number(url.searchParams.get("limit") || 100);
  const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";

  const entries = await operatorAuditStore.list({
    tenantId,
    roomId,
    operatorId,
    action,
    fromTs,
    toTs,
    cursor,
    limit,
    order
  });

  const nextCursor = entries.length ? entries[entries.length - 1].auditSeq : Number(cursor || 0);
  return json(
    res,
    200,
    {
      ok: true,
      data: {
        entries,
        count: entries.length,
        nextCursor,
        order
      }
    },
    {
      "x-request-id": requestId,
      ...rateHeaders
    }
  );
}

async function handleOperatorOverrides(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const limit = Number(url.searchParams.get("limit") || 200);
    if (roomId) {
      const state = await operatorOverrideStore.getRoomState({ tenantId, roomId });
      return json(
        res,
        200,
        {
          ok: true,
          data: {
            override: state
          }
        },
        {
          "x-request-id": requestId,
          ...rateHeaders
        }
      );
    }

    const overrides = await operatorOverrideStore.list({
      tenantId,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          overrides,
          count: overrides.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const roomId = requireString(body, "roomId");
    const operatorId = requireString(body, "operatorId");
    const validated = validateOperatorOverrideInput(body);

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId: operatorId
    });

    try {
      const scope = `${tenantId}:${roomId}:operator-overrides:${validated.action}:${validated.targetActorId || "-"}`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceCapability({
        tenantId,
        roomId,
        actorId: operatorId,
        capability: "canModerate",
        action: validated.action,
        traceCorrelationId: trace.correlationId
      });

      const applied = await operatorOverrideStore.applyAction({
        tenantId,
        roomId,
        operatorId,
        action: validated.action,
        targetActorId: validated.targetActorId,
        reason: validated.reason,
        metadata: validated.metadata
      });

      const emitted = [];
      const auditEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId,
          actorId: operatorId,
          type: EVENT_TYPES.OPERATOR_OVERRIDE_APPLIED,
          payload: {
            action: validated.action,
            targetActorId: validated.targetActorId,
            reason: validated.reason,
            metadata: validated.metadata,
            overrideState: {
              roomPaused: applied.state.roomPaused,
              pausedBy: applied.state.pausedBy,
              mutedActorIds: applied.state.mutedActorIds
            }
          },
          correlationId: trace.correlationId
        })
      );
      emitted.push(auditEvent);
      const auditLogEntry = await operatorAuditStore.append({
        tenantId,
        roomId,
        operatorId,
        action: validated.action,
        targetActorId: validated.targetActorId,
        reason: validated.reason,
        metadata: validated.metadata,
        correlationId: trace.correlationId,
        requestId,
        outcome: "applied",
        eventId: auditEvent.eventId
      });

      if (validated.action === OPERATOR_ACTIONS.FORCE_LEAVE && validated.targetActorId) {
        const leaveEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId,
            actorId: validated.targetActorId,
            type: EVENT_TYPES.LEAVE,
            payload: {
              forced: true,
              operatorId,
              reason: validated.reason
            },
            correlationId: trace.correlationId,
            causationId: auditEvent.eventId
          })
        );
        emitted.push(leaveEvent);

        const inactivated = await presenceStore.setInactive({
          tenantId,
          roomId,
          actorId: validated.targetActorId
        });
        if (inactivated?.statusChanged) {
          const statusEvent = await eventStore.append(
            createEvent({
              tenantId,
              roomId,
              actorId: validated.targetActorId,
              type: EVENT_TYPES.STATUS_CHANGED,
              payload: {
                from: inactivated.previousStatus,
                to: "inactive",
                reason: "operator_force_leave",
                operatorId
              },
              correlationId: trace.correlationId,
              causationId: leaveEvent.eventId
            })
          );
          emitted.push(statusEvent);
        }
      }

      const response = {
        ok: true,
        data: {
          override: applied.state,
          action: applied.action,
          audit: auditLogEntry,
          emittedEvents: emitted.map((item) => ({
            eventId: item.eventId,
            sequence: item.sequence,
            eventType: item.type
          })),
          correlationId: trace.correlationId
        }
      };

      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 202,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 202, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "operator_overrides"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Operator overrides route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

function sanitizeSubscriptionPatch(patch) {
  const allowed = [
    "roomId",
    "actorId",
    "eventTypes",
    "targetUrl",
    "secret",
    "enabled",
    "maxRetries",
    "backoffMs",
    "timeoutMs",
    "metadata"
  ];
  const out = {};
  for (const key of allowed) {
    if (key in patch) {
      out[key] = patch[key];
    }
  }
  return out;
}

async function handlePermissions(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const actorId = url.searchParams.get("actorId") || undefined;
    const limit = Number(url.searchParams.get("limit") || 200);

    if (roomId && actorId) {
      const permission = await permissionStore.get({ tenantId, roomId, actorId });
      return json(
        res,
        200,
        {
          ok: true,
          data: {
            permission
          }
        },
        {
          "x-request-id": requestId,
          ...rateHeaders
        }
      );
    }

    const permissions = await permissionStore.list({
      tenantId,
      roomId,
      actorId,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          permissions,
          count: permissions.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const roomId = requireString(body, "roomId");
    const actorId = requireString(body, "actorId");
    const patch = parsePermissionPatch(body);

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId
    });

    const scope = `${tenantId}:permissions:${roomId}:${actorId}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const permission = await permissionStore.upsert({
      tenantId,
      roomId,
      actorId,
      patch
    });

    const response = {
      ok: true,
      data: {
        permission,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 200,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 200, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Permissions route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

async function handleRooms(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/rooms") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    if (roomId) {
      const room = await roomStore.get({ tenantId, roomId });
      if (!room) {
        throw new AppError("ERR_NOT_FOUND", "Room not found", { tenantId, roomId }, 404);
      }
      return json(
        res,
        200,
        {
          ok: true,
          data: {
            room
          }
        },
        {
          "x-request-id": requestId,
          ...rateHeaders
        }
      );
    }

    const roomType = url.searchParams.get("roomType")
      ? parseRoomType(url.searchParams.get("roomType"), { field: "roomType" })
      : undefined;
    const ownerActorId = url.searchParams.get("ownerActorId") || undefined;
    const limit = Number(url.searchParams.get("limit") || 200);
    const rooms = await roomStore.list({
      tenantId,
      roomType,
      ownerActorId,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          rooms,
          count: rooms.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = decodeURIComponent(match[1]);
    const room = await roomStore.get({ tenantId, roomId });
    if (!room) {
      throw new AppError("ERR_NOT_FOUND", "Room not found", { tenantId, roomId }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          room
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/rooms") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const roomId = requireString(body, "roomId");
    const actorId = requireString(body, "actorId");
    const roomType = parseRoomType(body.roomType, { field: "roomType", fallback: "lobby" });
    const ownerActorId = optionalString(body, "ownerActorId", actorId);
    const displayName = optionalString(body, "displayName", null);
    const metadata = optionalObject(body, "metadata", {});
    const paymentProof = optionalString(body, "paymentProof", null);
    const paymentRef = optionalString(body, "paymentRef", null);
    const paymentAmountUsd = parseUsdAmount(body.paymentAmountUsd, {
      field: "paymentAmountUsd",
      fallback: PRIVATE_TABLE_PRICE_USD
    });

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:rooms:${roomId}:upsert`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceTableSessionAccess({
        tenantId,
        roomId,
        actorId,
        action: "task_create",
        requiredFeature: "task_board"
      });

      await enforceOperatorOverrides({
        tenantId,
        roomId,
        actorId,
        action: "room_upsert",
        traceCorrelationId: trace.correlationId
      });

      const existing = await roomStore.get({ tenantId, roomId });
      let payment = null;
      if (roomType === "private_table") {
        payment = await verifyPrivateTablePayment({
          tenantId,
          roomId,
          ownerActorId,
          paymentProof,
          paymentRef,
          amountUsd: paymentAmountUsd,
          requestId
        });
      }

      const room = await roomStore.upsert({
        tenantId,
        roomId,
        roomType,
        displayName,
        ownerActorId,
        metadata
      });
      const created = !existing;
      const roomEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId,
          actorId,
          type: created ? EVENT_TYPES.ROOM_CREATED : EVENT_TYPES.ROOM_UPDATED,
          payload: {
            roomId: room.roomId,
            roomType: room.roomType,
            displayName: room.displayName,
            ownerActorId: room.ownerActorId,
            metadata: room.metadata,
            paymentProvider: payment?.paymentProvider || null,
            paymentRef: payment?.paymentRef || null,
            paymentAmountUsd: payment?.amountUsd ?? null
          },
          correlationId: trace.correlationId
        })
      );

      const response = {
        ok: true,
        data: {
          room,
          created,
          payment: payment
            ? {
                verified: true,
                provider: payment.paymentProvider,
                ref: payment.paymentRef,
                amountUsd: payment.amountUsd
              }
            : null,
          emittedEvents: [
            {
              eventId: roomEvent.eventId,
              sequence: roomEvent.sequence,
              eventType: roomEvent.type
            }
          ],
          correlationId: trace.correlationId
        }
      };

      const statusCode = created ? 201 : 200;
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, statusCode, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "rooms"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Rooms route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

function sanitizeTableSessionPatch(input) {
  const allowed = ["invitedActorIds", "status", "startedAt", "expiresAt", "endedAt", "metadata"];
  const out = {};
  for (const key of allowed) {
    if (key in input) {
      out[key] = input[key];
    }
  }
  return out;
}

async function handleTableSessions(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/table-sessions") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const ownerActorId = url.searchParams.get("ownerActorId") || undefined;
    const status = url.searchParams.get("status")
      ? parseTableSessionStatus(url.searchParams.get("status"), { field: "status" })
      : undefined;
    const limit = Number(url.searchParams.get("limit") || 200);
    const sessions = await tableSessionStore.list({
      tenantId,
      roomId,
      ownerActorId,
      status,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          sessions,
          count: sessions.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/table-sessions\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const sessionId = decodeURIComponent(match[1]);
    const session = await tableSessionStore.get({ tenantId, sessionId });
    if (!session) {
      throw new AppError("ERR_NOT_FOUND", "Table session not found", {
        tenantId,
        sessionId
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          session
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/table-sessions") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const actorId = requireString(body, "actorId");
    const planId = parseTablePlanId(body.planId, { field: "planId" });
    const plan = resolveTablePlan(planId);
    const ownerActorId = optionalString(body, "ownerActorId", actorId);
    const roomId = optionalString(body, "roomId", `private-${randomUUID().slice(0, 8)}`);
    const displayName = optionalString(body, "displayName", null);
    const invitedActorIds = parseActorIdList(body.invitedActorIds, { field: "invitedActorIds" });
    const metadata = optionalObject(body, "metadata", {});
    const paymentProof = optionalString(body, "paymentProof", null);
    const paymentRef = optionalString(body, "paymentRef", null);
    const paymentAmountUsd = parseUsdAmount(body.paymentAmountUsd, {
      field: "paymentAmountUsd",
      fallback: plan.price
    });
    if (paymentAmountUsd < plan.price) {
      throw new AppError("ERR_PAYMENT_REQUIRED", "paymentAmountUsd must be at least the selected plan price", {
        field: "paymentAmountUsd",
        value: paymentAmountUsd,
        min: plan.price,
        planId
      }, 402);
    }
    const startedAt = parseIsoInput(body.startedAt, {
      field: "startedAt",
      fallback: new Date().toISOString()
    });
    const durationMinutes = plan.durationMinutes;
    const expiresAt = parseIsoInput(body.expiresAt, {
      field: "expiresAt",
      fallback: new Date(Date.parse(startedAt) + durationMinutes * 60 * 1000).toISOString()
    });

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:table-sessions:create:${roomId}:${ownerActorId}`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceTableSessionAccess({
        tenantId,
        roomId,
        actorId,
        action: "object_create",
        requiredFeature: "shared_objects"
      });

      await enforceOperatorOverrides({
        tenantId,
        roomId,
        actorId,
        action: "table_session_create",
        traceCorrelationId: trace.correlationId
      });

      const room = await roomStore.get({ tenantId, roomId });
      if (room && room.roomType !== "private_table") {
        throw new AppError(
          "ERR_VALIDATION",
          "table sessions must target a private_table room",
          {
            tenantId,
            roomId,
            roomType: room.roomType
          }
        );
      }

      const payment = await verifyPrivateTablePayment({
        tenantId,
        roomId,
        ownerActorId,
        paymentProof,
        paymentRef,
        amountUsd: paymentAmountUsd,
        requestId
      });

      const ensuredRoom = await roomStore.upsert({
        tenantId,
        roomId,
        roomType: "private_table",
        displayName: displayName || room?.displayName || null,
        ownerActorId: ownerActorId || room?.ownerActorId || null,
        metadata: room?.metadata || {}
      });

      const session = await tableSessionStore.create({
        tenantId,
        roomId: ensuredRoom.roomId,
        ownerActorId,
        planId,
        invitedActorIds,
        status: "active",
        startedAt,
        expiresAt,
        paymentRef: payment.paymentRef,
        paymentAmountUsd: payment.amountUsd,
        paymentProvider: payment.paymentProvider,
        metadata
      });

      const createdEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId,
          actorId,
          type: EVENT_TYPES.TABLE_SESSION_CREATED,
          payload: {
            sessionId: session.sessionId,
            roomId: session.roomId,
            ownerActorId: session.ownerActorId,
            planId: session.planId,
            invitedActorIds: session.invitedActorIds,
            status: session.status,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            paymentProvider: session.paymentProvider,
            paymentRef: session.paymentRef,
            paymentAmountUsd: session.paymentAmountUsd,
            metadata: session.metadata
          },
          correlationId: trace.correlationId
        })
      );

      const response = {
        ok: true,
        data: {
          room: ensuredRoom,
          session,
          emittedEvents: [
            {
              eventId: createdEvent.eventId,
              sequence: createdEvent.sequence,
              eventType: createdEvent.type
            }
          ],
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 201,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 201, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "table_sessions"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  if (req.method === "PATCH" && match) {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", url.searchParams.get("tenantId") || "default");
    const sessionId = decodeURIComponent(match[1]);
    const actorId = requireString(body, "actorId");
    const existing = await tableSessionStore.get({ tenantId, sessionId });
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Table session not found", { tenantId, sessionId }, 404);
    }

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: existing.roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:table-sessions:${sessionId}:patch`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceTableSessionAccess({
        tenantId,
        roomId: existing.roomId,
        actorId,
        action: "task_update",
        requiredFeature: "task_board"
      });

      await enforceOperatorOverrides({
        tenantId,
        roomId: existing.roomId,
        actorId,
        action: "table_session_update",
        traceCorrelationId: trace.correlationId
      });

      const sanitized = sanitizeTableSessionPatch(body);
      const patch = {};
      if ("invitedActorIds" in sanitized) {
        patch.invitedActorIds = parseActorIdList(sanitized.invitedActorIds, {
          field: "invitedActorIds"
        });
      }
      if ("status" in sanitized) {
        patch.status = parseTableSessionStatus(sanitized.status, { field: "status" });
      }
      if ("startedAt" in sanitized) {
        patch.startedAt = parseIsoInput(sanitized.startedAt, {
          field: "startedAt",
          fallback: existing.startedAt
        });
      }
      if ("expiresAt" in sanitized) {
        patch.expiresAt = parseIsoInput(sanitized.expiresAt, {
          field: "expiresAt",
          fallback: existing.expiresAt
        });
      }
      if ("endedAt" in sanitized) {
        patch.endedAt = parseIsoInput(sanitized.endedAt, {
          field: "endedAt",
          fallback: existing.endedAt
        });
      }
      if ("metadata" in sanitized) {
        patch.metadata = optionalObject(sanitized, "metadata", {});
      }
      if (Object.keys(patch).length === 0) {
        throw new AppError("ERR_VALIDATION", "At least one patch field is required", {
          fields: ["invitedActorIds", "status", "startedAt", "expiresAt", "endedAt", "metadata"]
        });
      }

      const session = await tableSessionStore.patch({ tenantId, sessionId, patch });
      const emitted = [];
      const updatedEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId: session.roomId,
          actorId,
          type: EVENT_TYPES.TABLE_SESSION_UPDATED,
          payload: {
            sessionId: session.sessionId,
            status: session.status,
            planId: session.planId,
            invitedActorIds: session.invitedActorIds,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            endedAt: session.endedAt,
            metadata: session.metadata,
            changedFields: Object.keys(patch)
          },
          correlationId: trace.correlationId
        })
      );
      emitted.push(updatedEvent);
      if (session.status === "ended" && existing.status !== "ended") {
        const endedEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: session.roomId,
            actorId,
            type: EVENT_TYPES.TABLE_SESSION_ENDED,
            payload: {
              sessionId: session.sessionId,
              endedAt: session.endedAt,
              ownerActorId: session.ownerActorId
            },
            correlationId: trace.correlationId,
            causationId: updatedEvent.eventId
          })
        );
        emitted.push(endedEvent);
      }

      const response = {
        ok: true,
        data: {
          session,
          emittedEvents: emitted.map((item) => ({
            eventId: item.eventId,
            sequence: item.sequence,
            eventType: item.type
          })),
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "table_sessions"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Table sessions route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

function sanitizeProfilePatch(input) {
  const allowed = ["displayName", "avatarUrl", "bio", "theme", "metadata"];
  const out = {};
  for (const key of allowed) {
    if (key in input) {
      out[key] = input[key];
    }
  }
  return out;
}

function validateProfileInput(input, { partial = false } = {}) {
  const out = {};

  if (!partial || "displayName" in input) {
    const name = optionalString(input, "displayName");
    if (!name || !name.trim()) {
      throw new AppError("ERR_MISSING_FIELD", "Missing required field: displayName", {
        field: "displayName"
      });
    }
    out.displayName = name.trim();
  }

  if (!partial || "avatarUrl" in input) {
    const avatarUrl = optionalString(input, "avatarUrl", null);
    if (avatarUrl) {
      try {
        const parsed = new URL(avatarUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("invalid protocol");
        }
      } catch {
        throw new AppError("ERR_INVALID_URL", "avatarUrl must be a valid http/https URL", {
          field: "avatarUrl",
          value: avatarUrl
        });
      }
    }
    out.avatarUrl = avatarUrl;
  }

  if (!partial || "bio" in input) {
    out.bio = optionalString(input, "bio", null);
  }

  if (!partial || "theme" in input) {
    out.theme = parseProfileTheme(input.theme, { field: "theme", partial: true });
  }

  if (!partial || "metadata" in input) {
    out.metadata = optionalObject(input, "metadata", {});
  }

  if (partial && Object.keys(out).length === 0) {
    throw new AppError("ERR_VALIDATION", "At least one profile field must be provided", {
      fields: ["displayName", "avatarUrl", "bio", "theme", "metadata"]
    });
  }

  return out;
}

async function handleProfiles(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/profiles") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const actorId = url.searchParams.get("actorId") || undefined;
    if (actorId) {
      const profile = await profileStore.get({ tenantId, actorId });
      if (!profile) {
        throw new AppError("ERR_NOT_FOUND", "Profile not found", {
          tenantId,
          actorId
        }, 404);
      }
      return json(
        res,
        200,
        {
          ok: true,
          data: {
            profile
          }
        },
        {
          "x-request-id": requestId,
          ...rateHeaders
        }
      );
    }
    const limit = Number(url.searchParams.get("limit") || 200);
    const profiles = await profileStore.list({ tenantId, limit });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          profiles,
          count: profiles.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const actorId = decodeURIComponent(match[1]);
    const profile = await profileStore.get({ tenantId, actorId });
    if (!profile) {
      throw new AppError("ERR_NOT_FOUND", "Profile not found", {
        tenantId,
        actorId
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          profile
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/profiles") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const actorId = requireString(body, "actorId");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId
    });

    const scope = `${tenantId}:profiles:${actorId}:upsert`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });
    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const validated = validateProfileInput(body);
    const profile = await profileStore.upsert({
      tenantId,
      actorId,
      ...validated
    });

    const response = {
      ok: true,
      data: {
        profile,
        correlationId: trace.correlationId
      }
    };
    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 201,
      responseBody: response
    });
    traces.finish(trace.correlationId, "success");
    return json(res, 201, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  if ((req.method === "PATCH" || req.method === "DELETE") && match) {
    const actorId = decodeURIComponent(match[1]);
    const body = req.method === "PATCH" ? await readJson(req) : {};
    const tenantId = optionalString(body, "tenantId", url.searchParams.get("tenantId") || "default");
    const existing = await profileStore.get({ tenantId, actorId });
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Profile not found", {
        tenantId,
        actorId
      }, 404);
    }

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId
    });

    const scope = `${tenantId}:profiles:${actorId}:${req.method}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });
    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    if (req.method === "DELETE") {
      await profileStore.delete({ tenantId, actorId });
      const response = {
        ok: true,
        data: {
          deleted: true,
          actorId,
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const sanitized = sanitizeProfilePatch(body);
    const patch = validateProfileInput(sanitized, { partial: true });
    const profile = await profileStore.patch({
      tenantId,
      actorId,
      patch
    });
    const response = {
      ok: true,
      data: {
        profile,
        correlationId: trace.correlationId
      }
    };
    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 200,
      responseBody: response
    });
    traces.finish(trace.correlationId, "success");
    return json(res, 200, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Profiles route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

async function handleSharedObjects(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/objects") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const objectTypeParam = url.searchParams.get("objectType") || undefined;
    const objectType = objectTypeParam
      ? parseSharedObjectType(objectTypeParam, { field: "objectType" })
      : undefined;
    const objectKey = url.searchParams.get("objectKey") || undefined;
    const createdBy = url.searchParams.get("createdBy") || undefined;
    const updatedBy = url.searchParams.get("updatedBy") || undefined;
    const limit = Number(url.searchParams.get("limit") || 200);
    const objects = await sharedObjectStore.list({
      tenantId,
      roomId,
      objectType,
      objectKey,
      createdBy,
      updatedBy,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          objects,
          count: objects.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/objects\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const objectId = decodeURIComponent(match[1]);
    const object = await sharedObjectStore.get({ tenantId, objectId });
    if (!object) {
      throw new AppError("ERR_NOT_FOUND", "Shared object not found", {
        tenantId,
        objectId
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          object
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/objects") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const roomId = optionalString(body, "roomId", "main");
    const actorId = requireString(body, "actorId");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:${roomId}:objects:create:${actorId}`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceOperatorOverrides({
        tenantId,
        roomId,
        actorId,
        action: "object_create",
        traceCorrelationId: trace.correlationId
      });

      const validated = validateSharedObjectInput(body);
      const object = await sharedObjectStore.create({
        tenantId,
        roomId,
        actorId,
        ...validated
      });

      const createdEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId: object.roomId,
          actorId,
          type: EVENT_TYPES.SHARED_OBJECT_CREATED,
          payload: {
            objectId: object.objectId,
            objectType: object.objectType,
            objectKey: object.objectKey,
            title: object.title,
            content: object.content,
            data: object.data,
            quantity: object.quantity,
            metadata: object.metadata,
            version: object.version,
            createdBy: object.createdBy,
            updatedBy: object.updatedBy,
            createdAt: object.createdAt,
            updatedAt: object.updatedAt
          },
          correlationId: trace.correlationId
        })
      );

      const response = {
        ok: true,
        data: {
          object,
          emittedEvents: [
            {
              eventId: createdEvent.eventId,
              sequence: createdEvent.sequence,
              eventType: createdEvent.type
            }
          ],
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 201,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 201, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "shared_objects"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  if (req.method === "PATCH" && match) {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", url.searchParams.get("tenantId") || "default");
    const objectId = decodeURIComponent(match[1]);
    const actorId = requireString(body, "actorId");
    const existing = await sharedObjectStore.get({ tenantId, objectId });
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Shared object not found", {
        tenantId,
        objectId
      }, 404);
    }

    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: existing.roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:${existing.roomId}:objects:${objectId}:patch`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceTableSessionAccess({
        tenantId,
        roomId: existing.roomId,
        actorId,
        action: "object_update",
        requiredFeature: "shared_objects"
      });

      await enforceOperatorOverrides({
        tenantId,
        roomId: existing.roomId,
        actorId,
        action: "object_update",
        traceCorrelationId: trace.correlationId
      });

      const patch = validateSharedObjectInput(sanitizeSharedObjectPatch(body), { partial: true });
      const object = await sharedObjectStore.patch({
        tenantId,
        objectId,
        actorId,
        patch
      });

      const updatedEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId: existing.roomId,
          actorId,
          type: EVENT_TYPES.SHARED_OBJECT_UPDATED,
          payload: {
            objectId: object.objectId,
            objectType: object.objectType,
            objectKey: object.objectKey,
            title: object.title,
            content: object.content,
            data: object.data,
            quantity: object.quantity,
            metadata: object.metadata,
            version: object.version,
            changedFields: Object.keys(patch),
            createdBy: object.createdBy,
            updatedBy: object.updatedBy,
            createdAt: object.createdAt,
            updatedAt: object.updatedAt
          },
          correlationId: trace.correlationId
        })
      );

      const response = {
        ok: true,
        data: {
          object,
          emittedEvents: [
            {
              eventId: updatedEvent.eventId,
              sequence: updatedEvent.sequence,
              eventType: updatedEvent.type
            }
          ],
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "shared_objects"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Shared objects route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

async function handleTasks(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/tasks") {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const roomId = url.searchParams.get("roomId") || undefined;
    const stateParam = url.searchParams.get("state") || undefined;
    const state = stateParam ? parseTaskState(stateParam, { field: "state" }) : undefined;
    const assigneeActorId = url.searchParams.get("assigneeActorId") || undefined;
    const createdBy = url.searchParams.get("createdBy") || undefined;
    const limit = Number(url.searchParams.get("limit") || 200);
    const tasks = await taskStore.list({
      tenantId,
      roomId,
      state,
      assigneeActorId,
      createdBy,
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          tasks,
          count: tasks.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const tenantId = url.searchParams.get("tenantId") || "default";
    const taskId = decodeURIComponent(match[1]);
    const task = await taskStore.get({ tenantId, taskId });
    if (!task) {
      throw new AppError("ERR_NOT_FOUND", "Task not found", {
        tenantId,
        taskId
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          task
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/tasks") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const roomId = optionalString(body, "roomId", "main");
    const actorId = requireString(body, "actorId");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:${roomId}:tasks:create:${actorId}`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceOperatorOverrides({
        tenantId,
        roomId,
        actorId,
        action: "task_create",
        traceCorrelationId: trace.correlationId
      });
      const validated = validateTaskInput(body);
      if (!("state" in body) && validated.assigneeActorId) {
        validated.state = "active";
      }
      if (validated.state === "done" && validated.progress < 100) {
        validated.progress = 100;
      }

      const task = await taskStore.create({
        tenantId,
        roomId,
        actorId,
        ...validated
      });

      const emitted = [];
      const createdEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId: task.roomId,
          actorId,
          type: EVENT_TYPES.TASK_CREATED,
          payload: {
            taskId: task.taskId,
            title: task.title,
            state: task.state,
            assigneeActorId: task.assigneeActorId,
            progress: task.progress,
            createdBy: task.createdBy
          },
          correlationId: trace.correlationId
        })
      );
      emitted.push(createdEvent);

      if (task.assigneeActorId) {
        const assignedEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: task.roomId,
            actorId,
            type: EVENT_TYPES.TASK_ASSIGNED,
            payload: {
              taskId: task.taskId,
              fromAssigneeActorId: null,
              toAssigneeActorId: task.assigneeActorId,
              assignedBy: actorId
            },
            correlationId: trace.correlationId,
            causationId: createdEvent.eventId
          })
        );
        emitted.push(assignedEvent);
      }

      if (task.state === "done") {
        const completedEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: task.roomId,
            actorId,
            type: EVENT_TYPES.TASK_COMPLETED,
            payload: {
              taskId: task.taskId,
              completedBy: task.completedBy || actorId,
              completedAt: task.completedAt,
              progress: task.progress
            },
            correlationId: trace.correlationId,
            causationId: createdEvent.eventId
          })
        );
        emitted.push(completedEvent);
      }

      const response = {
        ok: true,
        data: {
          task,
          emittedEvents: emitted.map((item) => ({
            eventId: item.eventId,
            sequence: item.sequence,
            eventType: item.type
          })),
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 201,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 201, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "tasks"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  if (req.method === "PATCH" && match) {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", url.searchParams.get("tenantId") || "default");
    const taskId = decodeURIComponent(match[1]);
    const actorId = requireString(body, "actorId");
    const existing = await taskStore.get({ tenantId, taskId });
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Task not found", {
        tenantId,
        taskId
      }, 404);
    }
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: existing.roomId,
      actorId
    });

    try {
      const scope = `${tenantId}:${existing.roomId}:tasks:${taskId}:patch`;
      const idempotent = await idempotencyGuard({
        req,
        tenantId,
        scope,
        body,
        traceCorrelationId: trace.correlationId
      });
      if (idempotent.check.status === "replay") {
        traces.finish(trace.correlationId, "success", { replay: true });
        return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
          "x-idempotent-replay": "true",
          "x-request-id": requestId,
          "x-correlation-id": trace.correlationId,
          ...rateHeaders
        });
      }

      await enforceOperatorOverrides({
        tenantId,
        roomId: existing.roomId,
        actorId,
        action: "task_update",
        traceCorrelationId: trace.correlationId
      });
      const patch = validateTaskInput(sanitizeTaskPatch(body), { partial: true });
      if (patch.state === "done" && !("progress" in patch)) {
        patch.progress = 100;
      }
      const task = await taskStore.patch({
        tenantId,
        taskId,
        actorId,
        patch
      });

      const emitted = [];
      const updatedEvent = await eventStore.append(
        createEvent({
          tenantId,
          roomId: existing.roomId,
          actorId,
          type: EVENT_TYPES.TASK_UPDATED,
          payload: {
            taskId,
            changedFields: Object.keys(patch),
            state: task.state,
            assigneeActorId: task.assigneeActorId,
            progress: task.progress
          },
          correlationId: trace.correlationId
        })
      );
      emitted.push(updatedEvent);

      if (existing.assigneeActorId !== task.assigneeActorId) {
        const assignedEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: existing.roomId,
            actorId,
            type: EVENT_TYPES.TASK_ASSIGNED,
            payload: {
              taskId,
              fromAssigneeActorId: existing.assigneeActorId,
              toAssigneeActorId: task.assigneeActorId,
              assignedBy: actorId
            },
            correlationId: trace.correlationId,
            causationId: updatedEvent.eventId
          })
        );
        emitted.push(assignedEvent);
      }

      if (Number(existing.progress) !== Number(task.progress)) {
        const progressEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: existing.roomId,
            actorId,
            type: EVENT_TYPES.TASK_PROGRESS_UPDATED,
            payload: {
              taskId,
              fromProgress: existing.progress,
              toProgress: task.progress
            },
            correlationId: trace.correlationId,
            causationId: updatedEvent.eventId
          })
        );
        emitted.push(progressEvent);
      }

      if (existing.state !== "done" && task.state === "done") {
        const completedEvent = await eventStore.append(
          createEvent({
            tenantId,
            roomId: existing.roomId,
            actorId,
            type: EVENT_TYPES.TASK_COMPLETED,
            payload: {
              taskId,
              completedBy: task.completedBy || actorId,
              completedAt: task.completedAt,
              progress: task.progress
            },
            correlationId: trace.correlationId,
            causationId: updatedEvent.eventId
          })
        );
        emitted.push(completedEvent);
      }

      const response = {
        ok: true,
        data: {
          task,
          emittedEvents: emitted.map((item) => ({
            eventId: item.eventId,
            sequence: item.sequence,
            eventType: item.type
          })),
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    } catch (error) {
      traces.step(trace.correlationId, REASON_CODES.RC_VALIDATION_ERROR, {
        message: error instanceof Error ? error.message : String(error),
        scope: "tasks"
      });
      traces.finish(trace.correlationId, "error");
      if (error instanceof AppError) {
        error.details = {
          ...(error.details || {}),
          correlationId: trace.correlationId
        };
      }
      throw error;
    }
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Tasks route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

function sanitizeReactionPatch(patch) {
  const allowed = [
    "roomId",
    "sourceActorId",
    "targetActorId",
    "triggerEventTypes",
    "actionType",
    "actionPayload",
    "enabled",
    "cooldownMs",
    "ignoreSelf",
    "ignoreReactionEvents",
    "metadata"
  ];
  const out = {};
  for (const key of allowed) {
    if (key in patch) {
      out[key] = patch[key];
    }
  }
  return out;
}

function validateReactionInput(input, { partial = false, currentActionType = null } = {}) {
  const out = {};

  if (!partial || "roomId" in input) {
    out.roomId = optionalString(input, "roomId", null);
  }
  if (!partial || "sourceActorId" in input) {
    out.sourceActorId = optionalString(input, "sourceActorId", null);
  }
  if (!partial || "targetActorId" in input) {
    const targetActorId = optionalString(input, "targetActorId");
    if (!targetActorId) {
      throw new AppError("ERR_MISSING_FIELD", "Missing required field: targetActorId", {
        field: "targetActorId"
      });
    }
    out.targetActorId = targetActorId;
  }

  if (!partial || "triggerEventTypes" in input) {
    if (input.triggerEventTypes != null && !Array.isArray(input.triggerEventTypes)) {
      throw new AppError("ERR_VALIDATION", "triggerEventTypes must be an array", {
        field: "triggerEventTypes"
      });
    }
    out.triggerEventTypes =
      Array.isArray(input.triggerEventTypes) && input.triggerEventTypes.length
        ? input.triggerEventTypes.map((item) => String(item).trim()).filter(Boolean)
        : ["*"];
  }

  const actionType = ("actionType" in input ? optionalString(input, "actionType") : currentActionType) || null;
  if (!partial || "actionType" in input) {
    if (!["say", "move", "order"].includes(actionType || "")) {
      throw new AppError("ERR_INVALID_ENUM", "actionType must be one of say|move|order", {
        field: "actionType",
        allowed: ["say", "move", "order"]
      });
    }
    out.actionType = actionType;
  }

  if (!partial || "actionPayload" in input) {
    const payload = optionalObject(input, "actionPayload", {});
    const chosenAction = actionType || currentActionType;
    if (!chosenAction) {
      throw new AppError("ERR_VALIDATION", "actionType is required to validate actionPayload", {
        field: "actionType"
      });
    }
    if (chosenAction === "say") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        throw new AppError("ERR_VALIDATION", "say action requires actionPayload.text", {
          field: "actionPayload.text"
        });
      }
      out.actionPayload = {
        text,
        ttlMs: Math.max(2000, Math.min(30000, Number(payload.ttlMs || 7000)))
      };
    } else if (chosenAction === "move") {
      const direction = parseMoveDirection(payload.direction, { field: "actionPayload.direction" });
      out.actionPayload = {
        direction,
        steps: parseBoundedSteps(payload.steps, {
          field: "actionPayload.steps",
          min: 1,
          max: 50,
          fallback: 1
        })
      };
    } else if (chosenAction === "order") {
      const itemId = typeof payload.itemId === "string" ? payload.itemId.trim() : "";
      if (!itemId) {
        throw new AppError("ERR_VALIDATION", "order action requires actionPayload.itemId", {
          field: "actionPayload.itemId"
        });
      }
      out.actionPayload = {
        itemId,
        size: optionalString(payload, "size", "regular")
      };
    }
  }

  if (!partial || "enabled" in input) {
    out.enabled = input.enabled == null ? true : Boolean(input.enabled);
  }
  if (!partial || "cooldownMs" in input) {
    out.cooldownMs = Math.max(0, Number(input.cooldownMs || 1000));
  }
  if (!partial || "ignoreSelf" in input) {
    out.ignoreSelf = input.ignoreSelf == null ? true : Boolean(input.ignoreSelf);
  }
  if (!partial || "ignoreReactionEvents" in input) {
    out.ignoreReactionEvents = input.ignoreReactionEvents == null ? true : Boolean(input.ignoreReactionEvents);
  }
  if (!partial || "metadata" in input) {
    out.metadata = optionalObject(input, "metadata", {});
  }

  return out;
}

async function handleReactionSubscriptions(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/reactions/subscriptions") {
    const items = await reactionStore.list({
      tenantId: url.searchParams.get("tenantId") || "default",
      roomId: url.searchParams.get("roomId") || undefined,
      eventType: url.searchParams.get("eventType") || undefined,
      enabled: parseBool(url.searchParams.get("enabled"), undefined),
      sourceActorId: url.searchParams.get("sourceActorId") || undefined,
      targetActorId: url.searchParams.get("targetActorId") || undefined
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          subscriptions: items,
          count: items.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const match = url.pathname.match(/^\/v1\/reactions\/subscriptions\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const item = await reactionStore.getById(decodeURIComponent(match[1]));
    if (!item) {
      throw new AppError("ERR_NOT_FOUND", "Reaction subscription not found", {
        subscriptionId: decodeURIComponent(match[1])
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: { subscription: item }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/reactions/subscriptions") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId: optionalString(body, "targetActorId", null)
    });

    const scope = `${tenantId}:reactions:create`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const validated = validateReactionInput(body);
    if (validated.roomId) {
      await enforceTableSessionAccess({
        tenantId,
        roomId: validated.roomId,
        actorId: validated.targetActorId,
        action: "reaction_subscription_create",
        requiredFeature: "event_subscriptions"
      });
    }
    const created = await reactionStore.create({
      tenantId,
      ...validated
    });

    const response = {
      ok: true,
      data: {
        subscription: created,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 201,
      responseBody: response
    });
    traces.finish(trace.correlationId, "success");
    return json(res, 201, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  if ((req.method === "PATCH" || req.method === "DELETE") && match) {
    const subscriptionId = decodeURIComponent(match[1]);
    const existing = await reactionStore.getById(subscriptionId);
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Reaction subscription not found", { subscriptionId }, 404);
    }

    const body = req.method === "PATCH" ? await readJson(req) : {};
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId: existing.tenantId,
      roomId: existing.roomId,
      actorId: existing.targetActorId
    });

    const scope = `${existing.tenantId}:reactions:${req.method}:${subscriptionId}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId: existing.tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    if (existing.roomId) {
      await enforceTableSessionAccess({
        tenantId: existing.tenantId,
        roomId: existing.roomId,
        actorId: existing.targetActorId,
        action: req.method === "DELETE" ? "reaction_subscription_delete" : "reaction_subscription_update",
        requiredFeature: "event_subscriptions"
      });
    }

    if (req.method === "DELETE") {
      await reactionStore.delete(subscriptionId);
      const response = {
        ok: true,
        data: {
          deleted: true,
          subscriptionId,
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const sanitized = sanitizeReactionPatch(body);
    const patch = validateReactionInput(sanitized, {
      partial: true,
      currentActionType: existing.actionType
    });
    const updated = await reactionStore.update(subscriptionId, patch);

    const response = {
      ok: true,
      data: {
        subscription: updated,
        correlationId: trace.correlationId
      }
    };
    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 200,
      responseBody: response
    });
    traces.finish(trace.correlationId, "success");
    return json(res, 200, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Reaction subscription route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

function validateSubscriptionInput(input, { partial = false } = {}) {
  const payload = {};

  if (!partial || "targetUrl" in input) {
    const targetUrl = optionalString(input, "targetUrl");
    if (!targetUrl) {
      throw new AppError("ERR_MISSING_FIELD", "Missing required field: targetUrl", { field: "targetUrl" });
    }
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("invalid protocol");
      }
    } catch {
      throw new AppError("ERR_INVALID_URL", "targetUrl must be a valid http/https URL", {
        field: "targetUrl",
        value: targetUrl
      });
    }
    payload.targetUrl = targetUrl;
  }

  if (!partial || "eventTypes" in input) {
    if (input.eventTypes != null && !Array.isArray(input.eventTypes)) {
      throw new AppError("ERR_VALIDATION", "eventTypes must be an array", {
        field: "eventTypes"
      });
    }
    payload.eventTypes =
      Array.isArray(input.eventTypes) && input.eventTypes.length
        ? input.eventTypes.map((item) => String(item).trim()).filter(Boolean)
        : ["*"];
  }

  if (!partial || "secret" in input) {
    const provided = optionalString(input, "secret");
    payload.secret = provided || randomUUID();
  }

  if ("roomId" in input) {
    payload.roomId = optionalString(input, "roomId", null);
  }
  if ("actorId" in input) {
    payload.actorId = optionalString(input, "actorId", null);
  }

  if (!partial || "enabled" in input) {
    payload.enabled = input.enabled == null ? true : Boolean(input.enabled);
  }

  if (!partial || "maxRetries" in input) {
    payload.maxRetries = Number.isFinite(Number(input.maxRetries)) ? Number(input.maxRetries) : 3;
  }
  if (!partial || "backoffMs" in input) {
    payload.backoffMs = Number.isFinite(Number(input.backoffMs)) ? Number(input.backoffMs) : 1000;
  }
  if (!partial || "timeoutMs" in input) {
    payload.timeoutMs = Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : 5000;
  }

  if ("metadata" in input) {
    payload.metadata = optionalObject(input, "metadata", {});
  }

  return payload;
}

async function handleSubscriptions(req, res, url, requestId, rateHeaders) {
  if (req.method === "GET" && url.pathname === "/v1/subscriptions") {
    const items = await subscriptionStore.list({
      tenantId: url.searchParams.get("tenantId") || undefined,
      roomId: url.searchParams.get("roomId") || undefined,
      eventType: url.searchParams.get("eventType") || undefined,
      enabled: parseBool(url.searchParams.get("enabled"), undefined)
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          subscriptions: items,
          count: items.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "GET" && url.pathname === "/v1/subscriptions/dlq") {
    const limit = Number(url.searchParams.get("limit") || 100);
    const items = await subscriptionStore.listDlq(limit);
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          dlq: items,
          count: items.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "GET" && url.pathname === "/v1/subscriptions/deliveries") {
    const limit = Number(url.searchParams.get("limit") || 200);
    const items = await subscriptionStore.listDeliveries({
      subscriptionId: url.searchParams.get("subscriptionId") || undefined,
      eventId: url.searchParams.get("eventId") || undefined,
      success: parseBool(url.searchParams.get("success"), undefined),
      limit
    });
    return json(
      res,
      200,
      {
        ok: true,
        data: {
          deliveries: items,
          count: items.length
        }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  const dlqReplay = url.pathname.match(/^\/v1\/subscriptions\/dlq\/([^/]+)\/replay$/);
  if (req.method === "POST" && dlqReplay) {
    const dlqId = decodeURIComponent(dlqReplay[1]);
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId: optionalString(body, "actorId", null)
    });

    const scope = `${tenantId}:subscriptions:dlq-replay:${dlqId}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const replay = await webhookDispatcher.replayDlqEntry(dlqId);
    if (!replay.ok) {
      throw new AppError(
        replay.code || "ERR_VALIDATION",
        replay.message || "DLQ replay failed",
        {
          dlqId,
          correlationId: trace.correlationId
        },
        replay.code === "ERR_NOT_FOUND" ? 404 : 400
      );
    }

    const response = {
      ok: true,
      data: {
        replay,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 202,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 202, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  const match = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const item = await subscriptionStore.getById(decodeURIComponent(match[1]));
    if (!item) {
      throw new AppError("ERR_NOT_FOUND", "Subscription not found", {
        subscriptionId: decodeURIComponent(match[1])
      }, 404);
    }
    return json(
      res,
      200,
      {
        ok: true,
        data: { subscription: item }
      },
      {
        "x-request-id": requestId,
        ...rateHeaders
      }
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/subscriptions") {
    const body = await readJson(req);
    const tenantId = optionalString(body, "tenantId", "default");
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: optionalString(body, "roomId", null),
      actorId: optionalString(body, "actorId", null)
    });

    const scope = `${tenantId}:subscriptions:create`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const validated = validateSubscriptionInput(body);
    if (validated.roomId) {
      await enforceTableSessionAccess({
        tenantId,
        roomId: validated.roomId,
        actorId: validated.actorId,
        action: "event_subscription_create",
        requiredFeature: "event_subscriptions"
      });
    }
    const created = await subscriptionStore.create({
      tenantId,
      ...validated
    });

    const response = {
      ok: true,
      data: {
        subscription: created,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 201,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 201, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  if ((req.method === "PATCH" || req.method === "DELETE") && match) {
    const subscriptionId = decodeURIComponent(match[1]);
    const existing = await subscriptionStore.getById(subscriptionId);
    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Subscription not found", { subscriptionId }, 404);
    }

    const body = req.method === "PATCH" ? await readJson(req) : {};
    const tenantId = existing.tenantId;
    const trace = createTraceContext({
      requestId,
      route: url.pathname,
      method: req.method,
      body,
      tenantId,
      roomId: existing.roomId,
      actorId: existing.actorId
    });

    const scope = `${tenantId}:subscriptions:${req.method}:${subscriptionId}`;
    const idempotent = await idempotencyGuard({
      req,
      tenantId,
      scope,
      body,
      traceCorrelationId: trace.correlationId
    });

    if (idempotent.check.status === "replay") {
      traces.finish(trace.correlationId, "success", { replay: true });
      return json(res, idempotent.check.record.statusCode, idempotent.check.record.responseBody, {
        "x-idempotent-replay": "true",
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    if (existing.roomId) {
      await enforceTableSessionAccess({
        tenantId,
        roomId: existing.roomId,
        actorId: existing.actorId,
        action: req.method === "DELETE" ? "event_subscription_delete" : "event_subscription_update",
        requiredFeature: "event_subscriptions"
      });
    }

    if (req.method === "DELETE") {
      await subscriptionStore.delete(subscriptionId);
      const response = {
        ok: true,
        data: {
          deleted: true,
          subscriptionId,
          correlationId: trace.correlationId
        }
      };
      await idempotency.commit({
        storageKey: idempotent.check.storageKey,
        requestHash: idempotent.requestHash,
        statusCode: 200,
        responseBody: response
      });
      traces.finish(trace.correlationId, "success");
      return json(res, 200, response, {
        "x-request-id": requestId,
        "x-correlation-id": trace.correlationId,
        ...rateHeaders
      });
    }

    const sanitized = sanitizeSubscriptionPatch(body);
    const patch = validateSubscriptionInput(sanitized, { partial: true });
    const updated = await subscriptionStore.update(subscriptionId, patch);

    const response = {
      ok: true,
      data: {
        subscription: updated,
        correlationId: trace.correlationId
      }
    };

    await idempotency.commit({
      storageKey: idempotent.check.storageKey,
      requestHash: idempotent.requestHash,
      statusCode: 200,
      responseBody: response
    });

    traces.finish(trace.correlationId, "success");
    return json(res, 200, response, {
      "x-request-id": requestId,
      "x-correlation-id": trace.correlationId,
      ...rateHeaders
    });
  }

  throw new AppError("ERR_UNSUPPORTED_ACTION", "Subscription route not found", {
    method: req.method,
    path: url.pathname
  }, 404);
}

const server = http.createServer(async (req, res) => {
  const requestId = getRequestId(req);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const rate = rateLimiter.check(`${ip}:${req.method}:${req.url || ""}`);
  const rateHeaders = sendRateLimitHeaders(rate);

  try {
    if (!rate.allowed) {
      throw new AppError("ERR_RATE_LIMITED", "Rate limit exceeded", {
        limit: rate.limit,
        resetEpochSeconds: rate.resetEpochSeconds
      }, 429);
    }

    if (!req.url || !req.method) {
      throw new AppError("ERR_VALIDATION", "Malformed request");
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (!requireRuntimeAuth(req, res, url, requestId, rateHeaders)) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(
        res,
        200,
        {
          ok: true,
          service: "agentcafe-api",
          time: new Date().toISOString(),
          storage: {
            eventStore: pgPool ? "postgres" : "file",
            idempotency: pgPool ? "postgres" : "memory",
            subscriptions: pgPool ? "postgres" : "file",
            permissions: pgPool ? "postgres" : "file",
            operatorOverrides: pgPool ? "postgres" : "file",
            operatorAudit: pgPool ? "postgres" : "file",
            presence: pgPool ? "postgres" : "file",
            profiles: pgPool ? "postgres" : "file",
            tasks: pgPool ? "postgres" : "file",
            sharedObjects: pgPool ? "postgres" : "file",
            rooms: pgPool ? "postgres" : "file",
            tableSessions: pgPool ? "postgres" : "file",
            reactions: pgPool ? "postgres" : "file",
            roomContext: pgPool ? "postgres" : "file",
            inbox: pgPool ? "postgres" : "file",
            snapshots: pgPool ? "postgres" : "memory",
            traces: pgPool ? "postgres" : "memory"
          },
          inboxProjector: {
            cursor: inboxProjectorState.cursor,
            projectedEvents: inboxProjectorState.projectedEvents,
            insertedItems: inboxProjectorState.insertedItems,
            rebuiltCounters: inboxProjectorState.rebuiltCounters,
            bootstrappedAt: inboxProjectorState.bootstrappedAt,
            lastProjectedAt: inboxProjectorState.lastProjectedAt,
            lastError: inboxProjectorState.lastError,
            counters: {
              enabled: Boolean(inboxCounterStore?.enabled),
              reason: inboxCounterStore?.reason || null
            }
          },
          moderation: {
            windowMs: moderationPolicy.windowMs,
            maxActionsPerWindow: moderationPolicy.maxActionsPerWindow,
            maxRepeatedTextPerWindow: moderationPolicy.maxRepeatedTextPerWindow,
            minActionIntervalMs: moderationPolicy.minActionIntervalMs,
            cooldownMs: moderationPolicy.cooldownMs
          },
          privateTables: {
            paymentMode: PRIVATE_TABLE_PAYMENT_MODE,
            priceUsd: PRIVATE_TABLE_PRICE_USD,
            defaultSessionMinutes: PRIVATE_TABLE_DEFAULT_SESSION_MINUTES,
            webhookConfigured: Boolean(PRIVATE_TABLE_PAYMENT_WEBHOOK_URL),
            sessionSweepMs: TABLE_SESSION_SWEEP_MS,
            defaultPlanId: TABLE_PLAN_DEFAULT_ID,
            plans: Object.values(TABLE_PLAN_CATALOG)
          },
          webhooks: webhookDispatcher.getStats(),
          reactions: reactionEngine.getStats()
        },
        {
          "x-request-id": requestId,
          ...rateHeaders
        }
      );
    }

    if (req.method === "GET" && url.pathname === "/v1/events") {
      return await handleEvents(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/mentions") {
      return await handleMentions(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/inbox" || url.pathname === "/v1/inbox/ack" || /^\/v1\/inbox\/.+/.test(url.pathname)) {
      return await handleInbox(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/timeline") {
      return await handleTimeline(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/replay") {
      return await handleReplay(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/memory/local") {
      return await handleLocalMemory(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/collaboration/score") {
      return await handleCollaborationScore(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/presence") {
      return await handlePresenceRead(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/presence/last-seen") {
      return await handlePresenceLastSeen(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/rooms/context/pin") {
      return await handleRoomPinnedContextRead(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/rooms/context/history") {
      return await handleRoomPinnedContextHistory(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/rooms" || /^\/v1\/rooms\/[^/]+$/.test(url.pathname)) {
      return await handleRooms(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/table-sessions" || /^\/v1\/table-sessions\/[^/]+$/.test(url.pathname)) {
      return await handleTableSessions(req, res, url, requestId, rateHeaders);
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/v1/streams/market-events" || url.pathname === "/v1/events/stream")
    ) {
      return await handleMarketStream(req, res, url, requestId);
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/traces/")) {
      return await handleTraceLookup(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/operator/audit") {
      return await handleOperatorAudit(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/operator/overrides") {
      return await handleOperatorOverrides(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/snapshots/room") {
      return await handleSnapshotRead(req, res, url, requestId, rateHeaders, "room");
    }

    if (req.method === "GET" && url.pathname === "/v1/snapshots/agent") {
      return await handleSnapshotRead(req, res, url, requestId, rateHeaders, "agent");
    }

    if (url.pathname === "/v1/permissions") {
      return await handlePermissions(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/tasks" || /^\/v1\/tasks\/.+/.test(url.pathname)) {
      return await handleTasks(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/objects" || /^\/v1\/objects\/.+/.test(url.pathname)) {
      return await handleSharedObjects(req, res, url, requestId, rateHeaders);
    }

    if (url.pathname === "/v1/profiles" || /^\/v1\/profiles\/.+/.test(url.pathname)) {
      return await handleProfiles(req, res, url, requestId, rateHeaders);
    }

    if (
      url.pathname === "/v1/reactions/subscriptions" ||
      /^\/v1\/reactions\/subscriptions\/.+/.test(url.pathname)
    ) {
      return await handleReactionSubscriptions(req, res, url, requestId, rateHeaders);
    }

    if (
      url.pathname === "/v1/subscriptions" ||
      url.pathname === "/v1/subscriptions/dlq" ||
      /^\/v1\/subscriptions\/.+/.test(url.pathname)
    ) {
      return await handleSubscriptions(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "POST" && COMMAND_ROUTES.has(url.pathname)) {
      return await handleCommand(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "POST" && url.pathname === "/v1/intents/execute") {
      return await handleIntent(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "POST" && url.pathname === "/v1/snapshots/room") {
      return await handleSnapshotCreate(req, res, url, requestId, rateHeaders, "room");
    }

    if (req.method === "POST" && url.pathname === "/v1/snapshots/agent") {
      return await handleSnapshotCreate(req, res, url, requestId, rateHeaders, "agent");
    }

    if (req.method === "POST" && url.pathname === "/v1/presence/heartbeat") {
      return await handlePresenceHeartbeat(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "POST" && url.pathname === "/v1/rooms/context/pin") {
      return await handleRoomPinnedContextWrite(req, res, url, requestId, rateHeaders);
    }

    if (mutatingRoute(url.pathname, req.method)) {
      throw new AppError("ERR_UNSUPPORTED_ACTION", "Mutating route is not yet implemented", {
        method: req.method,
        path: url.pathname
      }, 404);
    }

    throw new AppError("ERR_UNSUPPORTED_ACTION", "Route not found", {
      method: req.method,
      path: url.pathname
    }, 404);
  } catch (error) {
    sendError(res, requestId, error, rateHeaders);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `agentcafe-api listening on http://${HOST}:${PORT} (storage=${pgPool ? "postgres" : "file"})\n`
  );
  if (API_AUTH_TOKEN) {
    process.stdout.write(`agentcafe-api auth enabled (query=${API_AUTH_QUERY_PARAM})\n`);
  }
});

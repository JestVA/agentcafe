import http from "node:http";
import { randomUUID } from "node:crypto";
import { AppError, errorBody, getRequestId, normalizeError } from "../shared/errors.mjs";
import { buildConversationObject } from "../shared/conversation.mjs";
import { createEvent, EVENT_TYPES } from "../shared/events.mjs";
import { json, readJson, sendRateLimitHeaders } from "../shared/http.mjs";
import { optionalObject, optionalString, requireString } from "../shared/validate.mjs";
import { createPostgresPool } from "../db/postgres.mjs";
import { ProjectionState } from "../projector/projection-state.mjs";
import { PgEventStore } from "./event-store-pg.mjs";
import { InMemoryEventStore } from "./event-store.mjs";
import { hashRequest, InMemoryIdempotencyStore } from "./idempotency-store.mjs";
import { IntentPlanner } from "./intent-planner.mjs";
import { projectLastSeen } from "./last-seen-projection.mjs";
import { ModerationPolicy } from "./moderation-policy.mjs";
import { PgPermissionStore } from "./permission-store-pg.mjs";
import { FilePermissionStore } from "./permission-store.mjs";
import { PgPresenceStore } from "./presence-store-pg.mjs";
import { FilePresenceStore } from "./presence-store.mjs";
import { PgProfileStore } from "./profile-store-pg.mjs";
import { FileProfileStore } from "./profile-store.mjs";
import { PgPinnedContextStore } from "./pinned-context-store-pg.mjs";
import { FilePinnedContextStore } from "./pinned-context-store.mjs";
import { ReactionEngine } from "./reaction-engine.mjs";
import { PgReactionStore } from "./reaction-store-pg.mjs";
import { FileReactionStore } from "./reaction-store.mjs";
import { FixedWindowRateLimiter } from "./rate-limit.mjs";
import { InMemorySnapshotStore } from "./snapshot-store.mjs";
import { PgSubscriptionStore } from "./subscription-store-pg.mjs";
import { FileSubscriptionStore } from "./subscription-store.mjs";
import { InMemoryTraceStore, REASON_CODES } from "./trace-store.mjs";
import { WebhookDispatcher } from "./webhook-dispatcher.mjs";

const HOST = process.env.API_HOST || "0.0.0.0";
const PORT = Number(process.env.API_PORT || process.env.PORT || 3850);
const STREAM_HEARTBEAT_MS = Number(process.env.API_STREAM_HEARTBEAT_MS || 15000);
const EVENT_STORE_FILE = process.env.EVENT_STORE_FILE || "./runtime/data/events.json";
const SUBSCRIPTIONS_FILE = process.env.SUBSCRIPTIONS_FILE || "./runtime/data/subscriptions.json";
const ROOM_CONTEXT_FILE = process.env.ROOM_CONTEXT_FILE || "./runtime/data/room-context.json";
const PERMISSIONS_FILE = process.env.PERMISSIONS_FILE || "./runtime/data/permissions.json";
const PRESENCE_FILE = process.env.PRESENCE_FILE || "./runtime/data/presence.json";
const PROFILES_FILE = process.env.PROFILES_FILE || "./runtime/data/profiles.json";
const REACTIONS_FILE = process.env.REACTIONS_FILE || "./runtime/data/reactions.json";
const PRESENCE_DEFAULT_TTL_MS = Math.max(1000, Number(process.env.PRESENCE_DEFAULT_TTL_MS || 60000));
const PRESENCE_SWEEP_MS = Math.max(500, Number(process.env.PRESENCE_SWEEP_MS || 2000));

const pgPool = await createPostgresPool();
const eventStore = pgPool
  ? new PgEventStore({ pool: pgPool })
  : new InMemoryEventStore({ filePath: EVENT_STORE_FILE });
const idempotency = new InMemoryIdempotencyStore();
const rateLimiter = new FixedWindowRateLimiter();
const moderationPolicy = new ModerationPolicy();
const snapshots = new InMemorySnapshotStore();
const planner = new IntentPlanner();
const traces = new InMemoryTraceStore();
const subscriptionStore = pgPool
  ? new PgSubscriptionStore({ pool: pgPool })
  : new FileSubscriptionStore({ filePath: SUBSCRIPTIONS_FILE });
const permissionStore = pgPool
  ? new PgPermissionStore({ pool: pgPool })
  : new FilePermissionStore({ filePath: PERMISSIONS_FILE });
const presenceStore = pgPool
  ? new PgPresenceStore({ pool: pgPool })
  : new FilePresenceStore({ filePath: PRESENCE_FILE });
const profileStore = pgPool
  ? new PgProfileStore({ pool: pgPool })
  : new FileProfileStore({ filePath: PROFILES_FILE });
const reactionStore = pgPool
  ? new PgReactionStore({ pool: pgPool })
  : new FileReactionStore({ filePath: REACTIONS_FILE });
const pinnedContextStore = pgPool
  ? new PgPinnedContextStore({ pool: pgPool })
  : new FilePinnedContextStore({ filePath: ROOM_CONTEXT_FILE });
await eventStore.init?.();
await subscriptionStore.init();
await permissionStore.init();
await presenceStore.init();
await profileStore.init();
await reactionStore.init();
await pinnedContextStore.init();
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
  moderationPolicy,
  maxConcurrency: Number(process.env.REACTION_MAX_CONCURRENCY || 4)
});
reactionEngine.start();

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
  EVENT_TYPES.ROOM_CONTEXT_PINNED
];

const CAPABILITY_KEYS = new Set(["canMove", "canSpeak", "canOrder", "canEnterLeave", "canModerate"]);
const PRESENCE_STATUS_VALUES = new Set(["thinking", "idle", "busy", "inactive"]);
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
    throw new AppError("ERR_VALIDATION", "status must be one of thinking|idle|busy|inactive", {
      field: "status"
    });
  }
  return status;
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
      throw new AppError("ERR_VALIDATION", `${field}.${key} must be a hex color`, {
        field: `${field}.${key}`
      });
    }
    out[key] = color.toLowerCase();
  }

  if (!Object.keys(out).length) {
    return null;
  }
  return out;
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
    pathname === "/v1/profiles" ||
    pathname === "/v1/reactions/subscriptions" ||
    pathname === "/v1/subscriptions"
  ) {
    return true;
  }
  if (
    pathname.startsWith("/v1/subscriptions/") ||
    pathname.startsWith("/v1/reactions/subscriptions/") ||
    pathname.startsWith("/v1/profiles/")
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

function sendError(res, requestId, error, rateHeaders = {}) {
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
      direction: requireString(body, "direction"),
      steps: Number(body.steps || 1),
      intent: optionalString(body, "intent")
    };
  }

  if (type === EVENT_TYPES.CONVERSATION_MESSAGE) {
    requireString(body, "text");
    const conversation = buildConversationObject(body);
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

function idempotencyGuard({ req, tenantId, scope, body, traceCorrelationId }) {
  const idempotencyKey = requireIdempotencyKey(req);
  const requestHash = hashRequest({ path: scope, method: req.method, body });
  const check = idempotency.check({ tenantId, scope, idempotencyKey, requestHash });

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
    const idempotent = idempotencyGuard({
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
      capability: capabilityForEventType(route.type),
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
        actorId,
        roomId,
        tenantId
      }
    };

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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
      capability: "canMove",
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
        finalSequence: completedEvent.sequence
      }
    };

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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
        ? snapshots.createRoomSnapshot({ tenantId, roomId, state, ttlSeconds })
        : snapshots.createAgentSnapshot({ tenantId, roomId, actorId, state, ttlSeconds });

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

    idempotency.commit({
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
      ? snapshots.findRoom({ tenantId, roomId, version })
      : snapshots.findAgent({ tenantId, roomId, actorId, version });

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
    const idempotent = idempotencyGuard({
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
        correlationId: trace.correlationId
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
            reason: "heartbeat_update",
            lastHeartbeatAt: heartbeat.state.lastHeartbeatAt
          },
          correlationId: trace.correlationId,
          causationId: heartbeatEvent.eventId
        })
      );
      emitted.push(statusEvent);
    }

    const response = {
      ok: true,
      data: {
        presence: heartbeat.state,
        emittedEvents: emitted.map((item) => ({
          eventId: item.eventId,
          sequence: item.sequence,
          eventType: item.type
        })),
        correlationId: trace.correlationId
      }
    };

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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

    idempotency.commit({
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

function handleTraceLookup(req, res, url, requestId, rateHeaders) {
  const prefix = "/v1/traces/";
  const correlationId = decodeURIComponent(url.pathname.slice(prefix.length));
  const trace = traces.get(correlationId);
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
    const idempotent = idempotencyGuard({
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

    idempotency.commit({
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
        throw new AppError("ERR_VALIDATION", "avatarUrl must be a valid http/https URL", {
          field: "avatarUrl"
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
    const idempotent = idempotencyGuard({
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
    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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
      idempotency.commit({
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
    idempotency.commit({
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
      throw new AppError("ERR_VALIDATION", "actionType must be one of say|move|order", {
        field: "actionType"
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
      const direction = String(payload.direction || "").toUpperCase();
      if (!["N", "S", "E", "W"].includes(direction)) {
        throw new AppError("ERR_VALIDATION", "move action requires direction in N|S|E|W", {
          field: "actionPayload.direction"
        });
      }
      out.actionPayload = {
        direction,
        steps: Math.max(1, Number(payload.steps || 1))
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
    const idempotent = idempotencyGuard({
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

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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
      idempotency.commit({
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
    idempotency.commit({
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
      throw new AppError("ERR_VALIDATION", "targetUrl must be a valid http/https URL", {
        field: "targetUrl",
        code: "ERR_INVALID_TARGET_URL"
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
    const idempotent = idempotencyGuard({
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

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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

    idempotency.commit({
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
    const idempotent = idempotencyGuard({
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
      await subscriptionStore.delete(subscriptionId);
      const response = {
        ok: true,
        data: {
          deleted: true,
          subscriptionId,
          correlationId: trace.correlationId
        }
      };
      idempotency.commit({
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

    idempotency.commit({
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
            subscriptions: pgPool ? "postgres" : "file",
            permissions: pgPool ? "postgres" : "file",
            presence: pgPool ? "postgres" : "file",
            profiles: pgPool ? "postgres" : "file",
            reactions: pgPool ? "postgres" : "file",
            roomContext: pgPool ? "postgres" : "file"
          },
          moderation: {
            windowMs: moderationPolicy.windowMs,
            maxActionsPerWindow: moderationPolicy.maxActionsPerWindow,
            maxRepeatedTextPerWindow: moderationPolicy.maxRepeatedTextPerWindow,
            minActionIntervalMs: moderationPolicy.minActionIntervalMs,
            cooldownMs: moderationPolicy.cooldownMs
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

    if (req.method === "GET" && url.pathname === "/v1/timeline") {
      return await handleTimeline(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/replay") {
      return await handleReplay(req, res, url, requestId, rateHeaders);
    }

    if (req.method === "GET" && url.pathname === "/v1/memory/local") {
      return await handleLocalMemory(req, res, url, requestId, rateHeaders);
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

    if (
      req.method === "GET" &&
      (url.pathname === "/v1/streams/market-events" || url.pathname === "/v1/events/stream")
    ) {
      return await handleMarketStream(req, res, url, requestId);
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/traces/")) {
      return handleTraceLookup(req, res, url, requestId, rateHeaders);
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
});

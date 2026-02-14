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
import { PgPermissionStore } from "./permission-store-pg.mjs";
import { FilePermissionStore } from "./permission-store.mjs";
import { PgPinnedContextStore } from "./pinned-context-store-pg.mjs";
import { FilePinnedContextStore } from "./pinned-context-store.mjs";
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

const pgPool = await createPostgresPool();
const eventStore = pgPool
  ? new PgEventStore({ pool: pgPool })
  : new InMemoryEventStore({ filePath: EVENT_STORE_FILE });
const idempotency = new InMemoryIdempotencyStore();
const rateLimiter = new FixedWindowRateLimiter();
const snapshots = new InMemorySnapshotStore();
const planner = new IntentPlanner();
const traces = new InMemoryTraceStore();
const subscriptionStore = pgPool
  ? new PgSubscriptionStore({ pool: pgPool })
  : new FileSubscriptionStore({ filePath: SUBSCRIPTIONS_FILE });
const permissionStore = pgPool
  ? new PgPermissionStore({ pool: pgPool })
  : new FilePermissionStore({ filePath: PERMISSIONS_FILE });
const pinnedContextStore = pgPool
  ? new PgPinnedContextStore({ pool: pgPool })
  : new FilePinnedContextStore({ filePath: ROOM_CONTEXT_FILE });
await eventStore.init?.();
await subscriptionStore.init();
await permissionStore.init();
await pinnedContextStore.init();
const webhookDispatcher = new WebhookDispatcher({
  eventStore,
  subscriptionStore,
  maxConcurrency: Number(process.env.WEBHOOK_MAX_CONCURRENCY || 4)
});
webhookDispatcher.start();

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
    pathname === "/v1/rooms/context/pin" ||
    pathname === "/v1/permissions" ||
    pathname === "/v1/subscriptions"
  ) {
    return true;
  }
  if (pathname.startsWith("/v1/subscriptions/")) {
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
        snapshot
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
            roomContext: pgPool ? "postgres" : "file"
          },
          webhooks: webhookDispatcher.getStats()
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

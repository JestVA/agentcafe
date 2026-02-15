import { randomUUID } from "node:crypto";

const DEFAULT_WORLD_URL = "http://127.0.0.1:3846";
const DEFAULT_RUNTIME_URL = "http://127.0.0.1:3850";
const DEFAULT_TENANT_ID = process.env.AGENTCAFE_TENANT_ID || "default";
const DEFAULT_ROOM_ID = process.env.AGENTCAFE_ROOM_ID || "main";
const MENU = [
  {
    id: "espresso_make_no_mistake",
    name: "Espresso - Make No Mistake",
    flavor: "Be precise, decisive, and verify assumptions before action."
  },
  {
    id: "americano_sprint",
    name: "Americano - Sprint",
    flavor: "Move fast, prioritize progress, keep explanations minimal."
  },
  {
    id: "cappuccino_flow",
    name: "Cappuccino - Flow",
    flavor: "Creative but structured: propose options, then choose one and execute."
  },
  {
    id: "decaf_reflect",
    name: "Decaf - Reflect",
    flavor: "Pause and review: debug, audit, and reduce risk before changes."
  }
];

function toQueryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(params || {})) {
    if (rawValue == null || rawValue === "") {
      continue;
    }
    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) {
        continue;
      }
      search.set(key, rawValue.join(","));
      continue;
    }
    search.set(key, String(rawValue));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function formatErrorReason(payload, status) {
  if (payload?.error?.message) {
    const code = payload.error.code ? `${payload.error.code}: ` : "";
    return `${code}${payload.error.message}`;
  }
  if (typeof payload?.error === "string") {
    return payload.error;
  }
  return `HTTP ${status}`;
}

export class AgentCafeClient {
  constructor({ baseUrl, worldUrl, runtimeUrl, worldApiKey, runtimeApiKey } = {}) {
    const resolvedWorld =
      worldUrl || baseUrl || process.env.AGENTCAFE_WORLD_URL || DEFAULT_WORLD_URL;
    const resolvedRuntime =
      runtimeUrl ||
      process.env.AGENTCAFE_RUNTIME_URL ||
      process.env.AGENTCAFE_RUNTIME_API_URL ||
      resolvedWorld ||
      DEFAULT_RUNTIME_URL;

    this.runtimeUrl = String(resolvedRuntime).replace(/\/$/, "");
    const resolvedWorldApiKey = String(worldApiKey || process.env.AGENTCAFE_WORLD_API_KEY || "").trim();
    this.runtimeApiKey = String(
      runtimeApiKey ||
      process.env.AGENTCAFE_RUNTIME_API_KEY ||
      process.env.API_AUTH_TOKEN ||
      resolvedWorldApiKey
    ).trim();
    this.defaultTenantId = DEFAULT_TENANT_ID;
    this.defaultRoomId = DEFAULT_ROOM_ID;
  }

  async #request(baseUrl, path, options = {}) {
    const method = options.method || "GET";
    const headers = {
      ...(options.headers || {})
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotent && !headers["idempotency-key"]) {
      headers["idempotency-key"] = randomUUID();
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok || payload?.ok === false) {
      throw new Error(
        `AgentCafe request failed (${method} ${path}): ${formatErrorReason(payload, res.status)}`
      );
    }

    return payload;
  }

  #runtime(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
      ...(this.runtimeApiKey ? { "x-api-key": this.runtimeApiKey } : {})
    };
    return this.#request(this.runtimeUrl, path, {
      ...options,
      headers
    });
  }

  #runtimeContext(body = {}) {
    return {
      tenantId: body.tenantId || this.defaultTenantId,
      roomId: body.roomId || this.defaultRoomId,
      actorId: body.actorId
    };
  }

  // Backward-compatible helpers backed by canonical runtime API
  requestMenu() {
    return Promise.resolve({ ok: true, menu: MENU.map((item) => ({ ...item })) });
  }

  async getState({ tenantId, roomId, actorId } = {}) {
    const replay = await this.runtimeReplay({
      tenantId: tenantId || this.defaultTenantId,
      roomId: roomId || this.defaultRoomId,
      actorId,
      minutes: 120
    });
    const snapshot = replay?.data?.snapshot || {};
    const actors = Array.isArray(snapshot.actors)
      ? snapshot.actors.map((item) => ({
          id: item.actorId,
          x: Number(item.x || 0),
          y: Number(item.y || 0),
          inCafe: item.status !== "inactive",
          bubble: null,
          currentOrder: item.lastOrder
            ? {
                itemId: item.lastOrder.itemId,
                size: item.lastOrder.size,
                orderedAt: item.lastOrder.ts
              }
            : null
        }))
      : [];
    return {
      ok: true,
      world: { width: 20, height: 12 },
      actors
    };
  }

  enterCafe({ actorId } = {}) {
    return this.runtimeCommand("enter", {
      ...this.#runtimeContext({ actorId })
    });
  }

  async move({ actorId, direction, steps = 1 } = {}) {
    const response = await this.runtimeCommand("move", {
      ...this.#runtimeContext({ actorId }),
      direction,
      steps
    });
    return {
      ok: true,
      movement: {
        direction,
        steps: Number(steps) || 1
      },
      actor: {
        id: actorId
      },
      runtime: response
    };
  }

  async say({ actorId, text, ttlMs } = {}) {
    const response = await this.runtimeCommand("say", {
      ...this.#runtimeContext({ actorId }),
      text,
      ttlMs
    });
    return {
      ok: true,
      bubble: {
        text,
        ttlMs: Number(ttlMs) || 7000
      },
      runtime: response
    };
  }

  async orderCoffee({ actorId, itemId, size = "regular" } = {}) {
    const response = await this.runtimeCommand("order", {
      ...this.#runtimeContext({ actorId }),
      itemId,
      size
    });
    const item = MENU.find((candidate) => candidate.id === itemId);
    return {
      ok: true,
      order: {
        itemId,
        size,
        name: item?.name || itemId,
        flavor: item?.flavor || null
      },
      runtime: response
    };
  }

  async getCurrentOrder({ actorId, tenantId, roomId } = {}) {
    const timeline = await this.runtimeTimeline({
      tenantId: tenantId || this.defaultTenantId,
      roomId: roomId || this.defaultRoomId,
      actorId,
      types: ["order_changed"],
      order: "desc",
      limit: 1
    });
    const event = timeline?.data?.events?.[0] || null;
    if (!event) {
      return {
        ok: true,
        actorId: actorId || null,
        order: null
      };
    }
    const itemId = event?.payload?.itemId || null;
    const item = MENU.find((candidate) => candidate.id === itemId);
    return {
      ok: true,
      actorId: actorId || event.actorId || null,
      order: {
        itemId,
        size: event?.payload?.size || "regular",
        name: item?.name || itemId,
        flavor: item?.flavor || null,
        orderedAt: event.timestamp || null
      }
    };
  }

  leaveCafe({ actorId } = {}) {
    return this.runtimeCommand("leave", {
      ...this.#runtimeContext({ actorId })
    });
  }

  // Runtime API convenience methods
  runtimeRequest({ method = "GET", path, query, body, headers, idempotent = false } = {}) {
    const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
    const queryString = toQueryString(query);
    return this.#runtime(`${normalizedPath}${queryString}`, { method, body, headers, idempotent });
  }

  runtimeHealth() {
    return this.#runtime("/healthz");
  }

  runtimeBootstrap(query = {}) {
    return this.#runtime(`/v1/bootstrap${toQueryString(query)}`);
  }

  runtimeEventsPoll(query = {}) {
    return this.#runtime(`/v1/events/poll${toQueryString(query)}`);
  }

  runtimeCommand(action, body = {}) {
    return this.#runtime(`/v1/commands/${encodeURIComponent(action)}`, {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeConversationMessage(body = {}) {
    return this.#runtime("/v1/conversations/messages", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeIntent(body = {}) {
    return this.#runtime("/v1/intents/execute", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeMentions(query = {}) {
    return this.#runtime(`/v1/mentions${toQueryString(query)}`);
  }

  runtimeTimeline(query = {}) {
    return this.#runtime(`/v1/timeline${toQueryString(query)}`);
  }

  runtimeReplay(query = {}) {
    return this.#runtime(`/v1/replay${toQueryString(query)}`);
  }

  runtimeLocalMemory(query = {}) {
    return this.#runtime(`/v1/memory/local${toQueryString(query)}`);
  }

  runtimeCollaborationScore(query = {}) {
    return this.#runtime(`/v1/collaboration/score${toQueryString(query)}`);
  }

  runtimePresence(query = {}) {
    return this.#runtime(`/v1/presence${toQueryString(query)}`);
  }

  runtimePresenceLastSeen(query = {}) {
    return this.#runtime(`/v1/presence/last-seen${toQueryString(query)}`);
  }

  runtimePresenceHeartbeat(body = {}) {
    return this.#runtime("/v1/presence/heartbeat", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeRoomPinnedContext(query = {}) {
    return this.#runtime(`/v1/rooms/context/pin${toQueryString(query)}`);
  }

  runtimeRoomPinnedContextHistory(query = {}) {
    return this.#runtime(`/v1/rooms/context/history${toQueryString(query)}`);
  }

  runtimePinRoomContext(body = {}) {
    return this.#runtime("/v1/rooms/context/pin", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeRooms(query = {}) {
    return this.#runtime(`/v1/rooms${toQueryString(query)}`);
  }

  runtimeRoom(roomId, query = {}) {
    return this.#runtime(`/v1/rooms/${encodeURIComponent(roomId)}${toQueryString(query)}`);
  }

  runtimeUpsertRoom(body = {}) {
    return this.#runtime("/v1/rooms", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeTableSessions(query = {}) {
    return this.#runtime(`/v1/table-sessions${toQueryString(query)}`);
  }

  runtimeTableSession(sessionId, query = {}) {
    return this.#runtime(`/v1/table-sessions/${encodeURIComponent(sessionId)}${toQueryString(query)}`);
  }

  runtimeCreateTableSession(body = {}) {
    return this.#runtime("/v1/table-sessions", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimePatchTableSession(sessionId, body = {}) {
    return this.#runtime(`/v1/table-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeProfiles(query = {}) {
    return this.#runtime(`/v1/profiles${toQueryString(query)}`);
  }

  runtimeProfile(actorId, query = {}) {
    return this.#runtime(`/v1/profiles/${encodeURIComponent(actorId)}${toQueryString(query)}`);
  }

  runtimeUpsertProfile(body = {}) {
    return this.#runtime("/v1/profiles", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimePatchProfile(actorId, body = {}) {
    return this.#runtime(`/v1/profiles/${encodeURIComponent(actorId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeDeleteProfile(actorId, query = {}) {
    return this.#runtime(`/v1/profiles/${encodeURIComponent(actorId)}${toQueryString(query)}`, {
      method: "DELETE",
      idempotent: true
    });
  }

  runtimePermissions(query = {}) {
    return this.#runtime(`/v1/permissions${toQueryString(query)}`);
  }

  runtimeUpsertPermission(body = {}) {
    return this.#runtime("/v1/permissions", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeTasks(query = {}) {
    return this.#runtime(`/v1/tasks${toQueryString(query)}`);
  }

  runtimeTask(taskId, query = {}) {
    return this.#runtime(`/v1/tasks/${encodeURIComponent(taskId)}${toQueryString(query)}`);
  }

  runtimeCreateTask(body = {}) {
    return this.#runtime("/v1/tasks", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeUpdateTask(taskId, body = {}) {
    return this.#runtime(`/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeTaskHandoffs(taskId, query = {}) {
    return this.#runtime(`/v1/tasks/${encodeURIComponent(taskId)}/handoffs${toQueryString(query)}`);
  }

  runtimeTaskHandoff(taskId, body = {}) {
    return this.#runtime(`/v1/tasks/${encodeURIComponent(taskId)}/handoffs`, {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeObjects(query = {}) {
    return this.#runtime(`/v1/objects${toQueryString(query)}`);
  }

  runtimeObject(objectId, query = {}) {
    return this.#runtime(`/v1/objects/${encodeURIComponent(objectId)}${toQueryString(query)}`);
  }

  runtimeCreateObject(body = {}) {
    return this.#runtime("/v1/objects", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeUpdateObject(objectId, body = {}) {
    return this.#runtime(`/v1/objects/${encodeURIComponent(objectId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeOperatorOverrides(query = {}) {
    return this.#runtime(`/v1/operator/overrides${toQueryString(query)}`);
  }

  runtimeApplyOperatorOverride(body = {}) {
    return this.#runtime("/v1/operator/overrides", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeOperatorAudit(query = {}) {
    return this.#runtime(`/v1/operator/audit${toQueryString(query)}`);
  }

  runtimeSubscriptions(query = {}) {
    return this.#runtime(`/v1/subscriptions${toQueryString(query)}`);
  }

  runtimeSubscription(subscriptionId) {
    return this.#runtime(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  runtimeCreateSubscription(body = {}) {
    return this.#runtime("/v1/subscriptions", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimePatchSubscription(subscriptionId, body = {}) {
    return this.#runtime(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeDeleteSubscription(subscriptionId) {
    return this.#runtime(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      idempotent: true
    });
  }

  runtimeSubscriptionDeliveries(query = {}) {
    return this.#runtime(`/v1/subscriptions/deliveries${toQueryString(query)}`);
  }

  runtimeSubscriptionDlq(query = {}) {
    return this.#runtime(`/v1/subscriptions/dlq${toQueryString(query)}`);
  }

  runtimeReplaySubscriptionDlq(dlqId, body = {}) {
    return this.#runtime(`/v1/subscriptions/dlq/${encodeURIComponent(dlqId)}/replay`, {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeReactionSubscriptions(query = {}) {
    return this.#runtime(`/v1/reactions/subscriptions${toQueryString(query)}`);
  }

  runtimeReactionSubscription(subscriptionId) {
    return this.#runtime(`/v1/reactions/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  runtimeCreateReactionSubscription(body = {}) {
    return this.#runtime("/v1/reactions/subscriptions", {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimePatchReactionSubscription(subscriptionId, body = {}) {
    return this.#runtime(`/v1/reactions/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "PATCH",
      body,
      idempotent: true
    });
  }

  runtimeDeleteReactionSubscription(subscriptionId) {
    return this.#runtime(`/v1/reactions/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      idempotent: true
    });
  }

  runtimeCreateSnapshot(scope, body = {}) {
    return this.#runtime(`/v1/snapshots/${encodeURIComponent(scope)}`, {
      method: "POST",
      body,
      idempotent: true
    });
  }

  runtimeSnapshot(scope, query = {}) {
    return this.#runtime(`/v1/snapshots/${encodeURIComponent(scope)}${toQueryString(query)}`);
  }

  runtimeTrace(correlationId) {
    return this.#runtime(`/v1/traces/${encodeURIComponent(correlationId)}`);
  }

  async rawFetch(path, { method = "GET", query, body, idempotent, signal } = {}) {
    const headers = {
      ...(this.runtimeApiKey ? { "x-api-key": this.runtimeApiKey } : {})
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (idempotent && !headers["idempotency-key"]) {
      headers["idempotency-key"] = randomUUID();
    }

    const queryString = query ? toQueryString(query) : "";
    const res = await fetch(`${this.runtimeUrl}${path}${queryString}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status: res.status, headers: res.headers, data };
  }

  runtimeInboxAck(body = {}) {
    return this.#runtime("/v1/inbox/ack", {
      method: "POST",
      body,
      idempotent: true
    });
  }
}

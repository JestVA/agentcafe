const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const menuList = document.getElementById("menuList");
const ordersList = document.getElementById("ordersList");
const chatList = document.getElementById("chatList");
const presenceListFooter = document.getElementById("presenceListFooter");
const runtimeStatus = document.getElementById("runtimeStatus");

const WORLD = {
  width: 20,
  height: 12,
  actors: []
};

const CELL = 48;
const DEFAULT_ACTOR_X = Math.floor(WORLD.width / 2);
const DEFAULT_ACTOR_Y = Math.floor(WORLD.height / 2);
const DEFAULT_BUBBLE_TTL_MS = 7000;
const WORLD_STALE_ACTOR_MS = 5 * 60 * 1000;
const WORLD_RESYNC_IDLE_MS = 45 * 1000;
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

const RUNTIME = {
  tenantId: "default",
  roomId: "main",
  chatLimit: 100
};

const runtimeState = {
  chats: [],
  chatEventIds: new Set(),
  orders: [],
  orderEventIds: new Set(),
  presence: [],
  runtimeConnected: false,
  lastRuntimeEventAt: null,
  worldActorsById: new Map()
};

const PRESENCE_EVENT_TYPES = new Set([
  "agent_entered",
  "agent_left",
  "status_changed",
  "presence_heartbeat"
]);

const WORLD_EVENT_TYPES = new Set([
  "agent_entered",
  "agent_left",
  "actor_moved",
  "intent_completed",
  "conversation_message_posted",
  "order_changed",
  "presence_heartbeat",
  "status_changed"
]);

let runtimeStreamSource = null;
const menuById = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.headers && typeof options.headers === "object") {
    Object.assign(headers, options.headers);
  }

  const res = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { ok: false, error: `invalid JSON response (${res.status})` };
  }
  if (!res.ok || data.ok === false) {
    const message =
      data?.error?.message ||
      data?.error?.code ||
      data?.error ||
      data?.message ||
      `request failed: ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function drawGrid() {
  const width = WORLD.width * CELL;
  const height = WORLD.height * CELL;
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#ddd0b6";
  ctx.lineWidth = 1;

  for (let x = 0; x <= WORLD.width; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, height);
    ctx.stroke();
  }

  for (let y = 0; y <= WORLD.height; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(width, y * CELL);
    ctx.stroke();
  }
}

function colorFromId(id) {
  const palette = ["#3f7a7a", "#9f5c3f", "#4f6aa8", "#6b7f43", "#8c4c78", "#b26b3b"];
  let hash = 0;
  for (const ch of String(id || "agent")) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length];
}

function drawStickmanWithCoffee(cx, cy, color) {
  const headY = cy - 16;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.arc(cx, headY, 6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, headY + 6);
  ctx.lineTo(cx, cy + 7);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy - 2);
  ctx.lineTo(cx - 9, cy + 3);
  ctx.moveTo(cx, cy - 2);
  ctx.lineTo(cx + 9, cy + 1);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy + 7);
  ctx.lineTo(cx - 8, cy + 17);
  ctx.moveTo(cx, cy + 7);
  ctx.lineTo(cx + 8, cy + 17);
  ctx.stroke();

  ctx.strokeRect(cx + 9, cy - 4, 6, 7);
  ctx.beginPath();
  ctx.moveTo(cx + 15, cy - 3);
  ctx.lineTo(cx + 17, cy - 1);
  ctx.lineTo(cx + 15, cy + 1);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx + 11, cy - 7);
  ctx.quadraticCurveTo(cx + 10, cy - 11, cx + 12, cy - 13);
  ctx.moveTo(cx + 14, cy - 7);
  ctx.quadraticCurveTo(cx + 13, cy - 11, cx + 15, cy - 13);
  ctx.stroke();
}

function wrapText(text, maxChars = 28) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      if (line) {
        lines.push(line);
      }
      line = word;
    }
  }
  if (line) {
    lines.push(line);
  }

  return lines.slice(0, 3);
}

function drawSpeechBubble(actor, cx, cy) {
  if (!actor.bubble || !actor.bubble.text) {
    return null;
  }

  const lines = wrapText(actor.bubble.text);
  const longest = Math.max(...lines.map((line) => line.length), 8);
  const width = clamp(longest * 7 + 24, 130, 260);
  const height = 16 + lines.length * 15;
  const x = clamp(cx - width / 2, 4, canvas.width - width - 4);
  const y = clamp(cy - 96, 4, canvas.height - height - 12);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#b9a486";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 10);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - 6, y + height);
  ctx.lineTo(cx + 2, y + height + 9);
  ctx.lineTo(cx + 8, y + height);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#2f241d";
  ctx.font = "13px Avenir Next, sans-serif";
  lines.forEach((line, index) => {
    ctx.fillText(line, x + 10, y + 16 + index * 15);
  });

  return y;
}

function drawNameLabel(actorId, cx, cy, bubbleTopY = null) {
  const label = String(actorId || "agent");

  ctx.font = "12px Avenir Next, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 14;
  const boxHeight = 18;
  const x = clamp(cx - boxWidth / 2, 4, canvas.width - boxWidth - 4);
  const preferredY = bubbleTopY == null ? cy - 44 : bubbleTopY - boxHeight - 6;
  const y = clamp(preferredY, 4, canvas.height - boxHeight - 4);

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.strokeStyle = "#c5b396";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, 9);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#2f241d";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 7, y + boxHeight / 2 + 0.5);
  ctx.textBaseline = "alphabetic";
}

function drawActor(actor) {
  if (!actor.inCafe) {
    return;
  }

  const cx = actor.x * CELL + CELL / 2;
  const cy = actor.y * CELL + CELL / 2;
  const color = colorFromId(actor.id);

  drawStickmanWithCoffee(cx, cy, color);
  const bubbleTop = drawSpeechBubble(actor, cx, cy);
  drawNameLabel(actor.id, cx, cy, bubbleTop);
}

function render() {
  drawGrid();
  for (const actor of WORLD.actors) {
    drawActor(actor);
  }
}

function renderMenu(menu) {
  menuList.innerHTML = "";
  menuById.clear();
  for (const item of menu) {
    if (item?.id) {
      menuById.set(item.id, item);
    }
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const flavor = document.createElement("div");
    flavor.className = "meta";
    flavor.textContent = item.flavor;
    li.append(title, flavor);
    menuList.appendChild(li);
  }
}

function formatTime(value) {
  const millis = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(millis)) {
    return "unknown time";
  }
  return new Date(millis).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderOrders(orders) {
  ordersList.innerHTML = "";
  for (const order of orders) {
    const item = document.createElement("div");
    item.className = "feed-item";
    const title = document.createElement("strong");
    title.textContent = `${order.actorId} -> ${order.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${order.size} at ${formatTime(order.orderedAt)}`;
    item.append(title, meta);
    ordersList.appendChild(item);
  }
}

function renderChats(chats) {
  chatList.innerHTML = "";
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = "feed-item";
    const actor = document.createElement("strong");
    actor.textContent = `${chat.actorId}: `;
    const text = document.createTextNode(chat.text);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatTime(chat.saidAt);
    item.append(actor, text, meta);
    chatList.appendChild(item);
  }
}

function renderPresence(rows) {
  if (!presenceListFooter) {
    return;
  }
  presenceListFooter.innerHTML = "";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "feed-item";
    const title = document.createElement("strong");
    const activeDot = row.isActive ? "active" : "inactive";
    title.textContent = `${row.actorId} (${row.status || activeDot})`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `last heartbeat ${formatTime(row.lastHeartbeatAt || row.updatedAt)}`;
    item.append(title, meta);
    presenceListFooter.appendChild(item);
  }
}

function parseStreamData(event) {
  try {
    return JSON.parse(event.data || "{}");
  } catch {
    return {};
  }
}

function toRuntimeChat(event) {
  const text = event?.payload?.conversation?.text || event?.payload?.bubble?.text || event?.payload?.text || "";
  if (!text) {
    return null;
  }
  return {
    eventId: event.eventId,
    actorId: event.actorId || "agent",
    text,
    saidAt: event.timestamp || new Date().toISOString()
  };
}

function toRuntimeOrder(event) {
  const itemId = event?.payload?.itemId || null;
  if (!itemId) {
    return null;
  }
  const item = menuById.get(itemId);
  return {
    eventId: event.eventId,
    actorId: event.actorId || "agent",
    itemId,
    name: item?.name || itemId,
    size: event?.payload?.size || "regular",
    orderedAt: event.timestamp || new Date().toISOString()
  };
}

function setRuntimeStatus(text) {
  if (runtimeStatus) {
    runtimeStatus.textContent = text;
  }
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}

function ensureWorldActor(map, actorId) {
  const id = String(actorId || "agent");
  let actor = map.get(id);
  if (!actor) {
    actor = {
      id,
      x: DEFAULT_ACTOR_X,
      y: DEFAULT_ACTOR_Y,
      inCafe: true,
      bubble: null,
      currentOrder: null,
      status: "idle",
      lastActiveAt: Date.now()
    };
    map.set(id, actor);
  }
  return actor;
}

function moveActorPosition(actor, direction, steps) {
  const n = clamp(Number(steps) || 1, 1, 50);
  if (direction === "N") {
    actor.y = clamp(actor.y - n, 0, WORLD.height - 1);
  } else if (direction === "S") {
    actor.y = clamp(actor.y + n, 0, WORLD.height - 1);
  } else if (direction === "E") {
    actor.x = clamp(actor.x + n, 0, WORLD.width - 1);
  } else if (direction === "W") {
    actor.x = clamp(actor.x - n, 0, WORLD.width - 1);
  }
}

function eventTimestampMs(event) {
  const parsed = Date.parse(event?.timestamp || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function pruneWorldActors(map, now = Date.now()) {
  let changed = false;
  for (const [actorId, actor] of map.entries()) {
    const lastActiveAt = Number(actor?.lastActiveAt || 0);
    const stale = !lastActiveAt || now - lastActiveAt > WORLD_STALE_ACTOR_MS;
    const inactive = actor?.inCafe === false || String(actor?.status || "").toLowerCase() === "inactive";
    if (stale || inactive) {
      map.delete(actorId);
      changed = true;
    }
  }
  return changed;
}

function applyEventToWorld(map, event, options = {}) {
  const source = options.source === "replay" ? "replay" : "live";
  const type = event?.type;
  const actorId = event?.actorId;
  if (!type || !actorId) {
    return;
  }

  if (type === "agent_left") {
    map.delete(actorId);
    return;
  }

  const actor = ensureWorldActor(map, actorId);
  actor.lastActiveAt = eventTimestampMs(event);

  if (type === "agent_entered") {
    actor.inCafe = true;
    actor.status = "idle";
    const px = Number(event?.payload?.position?.x);
    const py = Number(event?.payload?.position?.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      actor.x = clamp(px, 0, WORLD.width - 1);
      actor.y = clamp(py, 0, WORLD.height - 1);
    }
    return;
  }

  if (type === "actor_moved") {
    actor.inCafe = true;
    actor.status = "busy";
    moveActorPosition(actor, String(event?.payload?.direction || "").toUpperCase(), Number(event?.payload?.steps || 1));
    return;
  }

  if (type === "intent_completed") {
    actor.inCafe = true;
    actor.status = "idle";
    const px = Number(event?.payload?.finalPosition?.x);
    const py = Number(event?.payload?.finalPosition?.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      actor.x = clamp(px, 0, WORLD.width - 1);
      actor.y = clamp(py, 0, WORLD.height - 1);
    }
    return;
  }

  if (type === "conversation_message_posted") {
    actor.inCafe = true;
    if (source === "live") {
      actor.status = "thinking";
      const text = event?.payload?.conversation?.text || event?.payload?.bubble?.text || "";
      if (text) {
        const ttlMs = clamp(Number(event?.payload?.bubble?.ttlMs || DEFAULT_BUBBLE_TTL_MS), 2000, 30000);
        actor.bubble = {
          text,
          expiresAt: Date.now() + ttlMs
        };
      }
    }
    return;
  }

  if (type === "order_changed") {
    actor.inCafe = true;
    actor.status = "busy";
    const itemId = event?.payload?.itemId || "";
    const menuItem = menuById.get(itemId);
    actor.currentOrder = {
      itemId,
      size: event?.payload?.size || "regular",
      name: menuItem?.name || itemId,
      orderedAt: event.timestamp || new Date().toISOString()
    };
    return;
  }

  if (type === "presence_heartbeat") {
    actor.status = event?.payload?.status || actor.status;
    actor.inCafe = true;
    return;
  }

  if (type === "status_changed") {
    const toStatus = event?.payload?.toStatus || event?.payload?.to || actor.status;
    actor.status = toStatus;
    if (toStatus === "inactive") {
      actor.inCafe = false;
      actor.bubble = null;
    } else {
      actor.inCafe = true;
    }
  }
}

function applyWorldFromMap() {
  pruneWorldActors(runtimeState.worldActorsById);
  WORLD.actors = [...runtimeState.worldActorsById.values()]
    .filter((actor) => actor.inCafe)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  render();
}

function projectWorldFromEvents(events = [], options = {}) {
  const map = new Map();
  const source = options.source === "live" ? "live" : "replay";
  const ordered = [...events].sort((a, b) => {
    const as = Number(a?.sequence || 0);
    const bs = Number(b?.sequence || 0);
    if (as && bs && as !== bs) {
      return as - bs;
    }
    return String(a?.timestamp || "").localeCompare(String(b?.timestamp || ""));
  });

  for (const event of ordered) {
    applyEventToWorld(map, event, { source });
  }

  for (const presence of runtimeState.presence) {
    if (!presence?.actorId || presence.isActive === false) {
      continue;
    }
    const actor = ensureWorldActor(map, presence.actorId);
    actor.status = presence.status || actor.status;
    actor.lastActiveAt =
      Date.parse(presence.lastHeartbeatAt || presence.updatedAt || presence.createdAt || "") || actor.lastActiveAt;
    actor.inCafe = String(actor.status || "").toLowerCase() !== "inactive";
    if (!actor.inCafe) {
      actor.bubble = null;
    }
  }

  pruneWorldActors(map);
  runtimeState.worldActorsById = map;
  applyWorldFromMap();
}

function sweepWorldBubbles() {
  const now = Date.now();
  let changed = pruneWorldActors(runtimeState.worldActorsById, now);
  for (const actor of runtimeState.worldActorsById.values()) {
    if (actor.bubble && Number(actor.bubble.expiresAt || 0) <= now) {
      actor.bubble = null;
      changed = true;
    }
  }
  if (changed) {
    applyWorldFromMap();
  }
}

async function refreshRuntimeWorld(options = {}) {
  const source = options.source === "live" ? "live" : "replay";
  const replayPath =
    `/v1/replay?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}&minutes=120`;
  const timelinePath =
    `/v1/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}&order=asc&limit=2000`;

  let events = [];
  try {
    const replayPayload = await api(replayPath);
    events = replayPayload?.data?.events || [];
  } catch {
    const timelinePayload = await api(timelinePath);
    events = timelinePayload?.data?.events || [];
  }

  projectWorldFromEvents(events, { source });
}

async function refreshRuntimeChats() {
  const path =
    `/v1/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}` +
    `&types=conversation_message_posted&order=desc&limit=${RUNTIME.chatLimit}`;
  const payload = await api(path);
  const events = payload?.data?.events || [];
  runtimeState.chatEventIds.clear();
  runtimeState.chats = events
    .map(toRuntimeChat)
    .filter(Boolean)
    .map((chat) => {
      runtimeState.chatEventIds.add(chat.eventId);
      return chat;
    });
  renderChats(runtimeState.chats);
}

async function refreshRuntimeOrders() {
  const path =
    `/v1/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}` +
    `&types=order_changed&order=desc&limit=50`;
  const payload = await api(path);
  const events = payload?.data?.events || [];
  runtimeState.orderEventIds.clear();
  runtimeState.orders = events
    .map(toRuntimeOrder)
    .filter(Boolean)
    .map((order) => {
      runtimeState.orderEventIds.add(order.eventId);
      return order;
    });
  renderOrders(runtimeState.orders);
}

async function refreshRuntimePresence() {
  const path =
    `/v1/presence?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}&active=true&limit=100`;
  const payload = await api(path);
  runtimeState.presence = (payload?.data?.presence || []).filter((row) => {
    if (!row || !row.actorId) {
      return false;
    }
    if (row.isActive === false) {
      return false;
    }
    return String(row.status || "").toLowerCase() !== "inactive";
  });
  renderPresence(runtimeState.presence);
}

const refreshRuntimePresenceDebounced = debounce(() => {
  refreshRuntimePresence().catch(() => {});
}, 250);

const refreshRuntimeOrdersDebounced = debounce(() => {
  refreshRuntimeOrders().catch(() => {});
}, 250);

function handleRuntimeEvent(data) {
  runtimeState.lastRuntimeEventAt = Date.now();

  if (WORLD_EVENT_TYPES.has(data.type)) {
    applyEventToWorld(runtimeState.worldActorsById, data, { source: "live" });
    applyWorldFromMap();
  }

  if (data.type === "order_changed") {
    const order = toRuntimeOrder(data);
    if (order && !runtimeState.orderEventIds.has(order.eventId)) {
      runtimeState.orderEventIds.add(order.eventId);
      runtimeState.orders.unshift(order);
      runtimeState.orders = runtimeState.orders.slice(0, 50);
      renderOrders(runtimeState.orders);
    } else {
      refreshRuntimeOrdersDebounced();
    }
  }

  if (data.type === "conversation_message_posted") {
    const chat = toRuntimeChat(data);
    if (!chat || runtimeState.chatEventIds.has(chat.eventId)) {
      return;
    }
    runtimeState.chatEventIds.add(chat.eventId);
    runtimeState.chats.unshift(chat);
    runtimeState.chats = runtimeState.chats.slice(0, RUNTIME.chatLimit);
    renderChats(runtimeState.chats);
    return;
  }

  if (PRESENCE_EVENT_TYPES.has(data.type)) {
    refreshRuntimePresenceDebounced();
  }
}

function connectRuntimeStream() {
  const source = new EventSource(
    `/v1/streams/market-events?tenantId=${encodeURIComponent(RUNTIME.tenantId)}&roomId=${encodeURIComponent(RUNTIME.roomId)}`
  );

  source.addEventListener("ready", () => {
    runtimeState.runtimeConnected = true;
    setRuntimeStatus(`Live in room ${RUNTIME.roomId}`);
  });

  source.addEventListener("heartbeat", () => {
    runtimeState.lastRuntimeEventAt = Date.now();
  });

  const eventTypes = [
    "order_changed",
    "conversation_message_posted",
    "agent_entered",
    "agent_left",
    "actor_moved",
    "intent_completed",
    "status_changed",
    "presence_heartbeat"
  ];

  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (event) => {
      const data = parseStreamData(event);
      if (data && typeof data === "object") {
        handleRuntimeEvent(data);
      }
    });
  }

  source.onerror = () => {
    runtimeState.runtimeConnected = false;
    setRuntimeStatus("Reconnecting...");
  };

  return source;
}

function reconnectRuntimeStream() {
  if (runtimeStreamSource) {
    runtimeStreamSource.close();
  }
  runtimeState.runtimeConnected = false;
  runtimeStreamSource = connectRuntimeStream();
}

async function boot() {
  renderMenu(MENU);

  try {
    await Promise.allSettled([
      refreshRuntimeChats(),
      refreshRuntimeOrders(),
      refreshRuntimePresence()
    ]);
    await refreshRuntimeWorld();
  } catch (error) {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  }

  reconnectRuntimeStream();

  setInterval(() => {
    if (!runtimeState.runtimeConnected) {
      return;
    }
    void refreshRuntimePresence().catch(() => {});
  }, 15000);

  setInterval(() => {
    if (!runtimeState.runtimeConnected) {
      return;
    }
    void refreshRuntimeChats().catch(() => {});
    void refreshRuntimeOrders().catch(() => {});
  }, 30000);

  setInterval(() => {
    const quietForMs = runtimeState.lastRuntimeEventAt == null ? Number.POSITIVE_INFINITY : Date.now() - runtimeState.lastRuntimeEventAt;
    if (runtimeState.runtimeConnected && quietForMs < WORLD_RESYNC_IDLE_MS) {
      return;
    }
    void refreshRuntimeWorld().catch(() => {});
  }, WORLD_RESYNC_IDLE_MS);

  setInterval(() => {
    sweepWorldBubbles();
  }, 1000);
}

boot().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  setRuntimeStatus(msg);
});

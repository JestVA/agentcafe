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

const CELL = 52;
const DEFAULT_ACTOR_X = Math.floor(WORLD.width / 2);
const DEFAULT_ACTOR_Y = Math.floor(WORLD.height / 2);
const DEFAULT_BUBBLE_TTL_MS = 7000;
const WORLD_STALE_ACTOR_MS = 90 * 1000;
const WORLD_RESYNC_IDLE_MS = 45 * 1000;
const BRAND_COLORS = {
  espresso: "#2D2424",
  latte: "#F5E6D3",
  matcha: "#7FD858",
  berry: "#FF6B9D",
  blueberry: "#5B8FF9",
  mango: "#FFB648",
  lavender: "#B095FF",
  peach: "#FFD4B2",
  mocha: "#d4c8b8",
  white: "#FFFFFF",
  black: "#111111"
};
const AGENT_PALETTE = [
  BRAND_COLORS.matcha,
  BRAND_COLORS.berry,
  BRAND_COLORS.blueberry,
  BRAND_COLORS.mango,
  BRAND_COLORS.lavender,
  BRAND_COLORS.peach
];
const MENU = [
  {
    id: "espresso_make_no_mistake",
    name: "Espresso - Make No Mistake",
    flavor: "Be precise, decisive, and verify assumptions before action.",
    icon: "\u2615"
  },
  {
    id: "americano_sprint",
    name: "Americano - Sprint",
    flavor: "Move fast, prioritize progress, keep explanations minimal.",
    icon: "\u{1F3C3}"
  },
  {
    id: "cappuccino_flow",
    name: "Cappuccino - Flow",
    flavor: "Creative but structured: propose options, then choose one and execute.",
    icon: "\u{1F3A8}"
  },
  {
    id: "decaf_reflect",
    name: "Decaf - Reflect",
    flavor: "Pause and review: debug, audit, and reduce risk before changes.",
    icon: "\u{1F9D8}"
  }
];

const RUNTIME = {
  tenantId: "default",
  roomId: "main",
  chatLimit: 100,
  initialLoadDone: false
};

const runtimeState = {
  chats: [],
  chatEventIds: new Set(),
  orders: [],
  orderEventIds: new Set(),
  presence: [],
  runtimeConnected: false,
  streamCursor: 0,
  lastRuntimeEventAt: null,
  worldActorsById: new Map(),
  actorThemesById: new Map()
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
let sseReconnectAttempts = 0;
let sseReconnectTimer = null;
const SSE_RECONNECT_BASE_MS = 1000;
const SSE_RECONNECT_MAX_MS = 30000;
const menuById = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isHexColor(value) {
  return typeof value === "string" && /^#([a-fA-F0-9]{6})$/.test(value.trim());
}

function hexToRgb(hex) {
  if (!isHexColor(hex)) {
    return null;
  }
  const clean = hex.trim().slice(1);
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16)
  };
}

function toRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return `rgba(45, 36, 36, ${clamp(alpha, 0, 1)})`;
  }
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
}

function blendWithLatte(hex, alpha = 0.24) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return BRAND_COLORS.latte;
  }
  const latte = hexToRgb(BRAND_COLORS.latte);
  return `rgb(${Math.round(rgb.r * (1 - alpha) + latte.r * alpha)}, ${Math.round(rgb.g * (1 - alpha) + latte.g * alpha)}, ${Math.round(rgb.b * (1 - alpha) + latte.b * alpha)})`;
}

function isDarkColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return false;
  }
  const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return brightness < 140;
}

function readableTextColor(hex) {
  return isDarkColor(hex) ? BRAND_COLORS.white : BRAND_COLORS.espresso;
}

function normalizeTheme(theme) {
  if (!theme || typeof theme !== "object") {
    return null;
  }
  const bubbleColor = isHexColor(theme.bubbleColor) ? theme.bubbleColor.trim() : null;
  const textColor = isHexColor(theme.textColor) ? theme.textColor.trim() : null;
  const accentColor = isHexColor(theme.accentColor) ? theme.accentColor.trim() : null;
  if (!bubbleColor && !textColor && !accentColor) {
    return null;
  }
  return {
    bubbleColor: bubbleColor || accentColor || BRAND_COLORS.matcha,
    textColor: textColor || readableTextColor(bubbleColor || accentColor || BRAND_COLORS.matcha),
    accentColor: accentColor || bubbleColor || BRAND_COLORS.matcha
  };
}

function rememberActorTheme(actorId, theme) {
  const id = String(actorId || "");
  if (!id) {
    return;
  }
  const normalized = normalizeTheme(theme);
  if (!normalized) {
    return;
  }
  runtimeState.actorThemesById.set(id, normalized);
  const actor = runtimeState.worldActorsById.get(id);
  if (actor) {
    actor.theme = normalized;
  }
}

function ingestSnapshotThemes(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }
  const groups = [snapshot.actors, snapshot.messages, snapshot.chat];
  for (const list of groups) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (!item?.actorId) {
        continue;
      }
      rememberActorTheme(item.actorId, item.theme || item.profile?.theme || item.actor?.theme);
    }
  }
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
  const dpr = window.devicePixelRatio || 1;
  const width = WORLD.width * CELL;
  const height = WORLD.height * CELL;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fdfcfa";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
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
  let hash = 0;
  for (const ch of String(id || "agent")) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AGENT_PALETTE[hash % AGENT_PALETTE.length];
}

function resolveActorTheme(actor) {
  const fallbackAccent = colorFromId(actor?.id);
  const normalized = normalizeTheme(actor?.theme) || runtimeState.actorThemesById.get(String(actor?.id || ""));
  if (normalized) {
    return normalized;
  }
  return {
    bubbleColor: fallbackAccent,
    textColor: readableTextColor(fallbackAccent),
    accentColor: fallbackAccent
  };
}

function drawStickmanWithCoffee(cx, cy, accentColor) {
  const headRadius = 8;
  const headY = cy - 12;
  const neckY = headY + headRadius;
  const torsoBottom = neckY + 13;
  const armY = neckY + 5;
  const legY = torsoBottom + 9;

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.font = "16px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("\u{1F916}", cx, headY);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";

  ctx.strokeStyle = accentColor;
  ctx.beginPath();
  ctx.moveTo(cx, neckY);
  ctx.lineTo(cx, torsoBottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx - 9, armY + 4);
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx + 9, armY + 1);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, torsoBottom);
  ctx.lineTo(cx - 7, legY);
  ctx.moveTo(cx, torsoBottom);
  ctx.lineTo(cx + 7, legY);
  ctx.stroke();

  ctx.strokeStyle = BRAND_COLORS.espresso;
  ctx.strokeRect(cx + 9, armY - 1, 6, 6);
  ctx.beginPath();
  ctx.arc(cx + 16, armY + 2, 2, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();

  ctx.strokeStyle = BRAND_COLORS.matcha;
  ctx.beginPath();
  ctx.moveTo(cx + 10, armY - 3);
  ctx.quadraticCurveTo(cx + 9, armY - 6, cx + 10, armY - 8);
  ctx.moveTo(cx + 13, armY - 3);
  ctx.quadraticCurveTo(cx + 12, armY - 6, cx + 13, armY - 8);
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

function drawSpeechBubble(actor, cx, cy, theme) {
  if (!actor.bubble || !actor.bubble.text) {
    return null;
  }

  const lines = wrapText(actor.bubble.text, 24);
  const longest = Math.max(...lines.map((line) => line.length), 8);
  const width = clamp(longest * 8.5 + 40, 150, 300);
  const lineH = 18;
  const padY = 12;
  const height = padY * 2 + lines.length * lineH;
  const tailH = 12;
  const margin = 8;
  const radius = 24;
  const borderWidth = 3;
  const bubbleColor = theme?.bubbleColor || BRAND_COLORS.matcha;
  const textColor = theme?.textColor || readableTextColor(bubbleColor);

  const x = clamp(cx - width / 2, margin, WORLD.width * CELL - width - margin);
  const spaceAbove = cy - CELL / 2;
  const neededAbove = height + tailH + 8;
  const above = spaceAbove >= neededAbove;

  let y;
  if (above) {
    y = cy - CELL / 2 - tailH - height - 4;
  } else {
    y = cy + CELL / 2 + tailH + 4;
  }
  y = clamp(y, margin, WORLD.height * CELL - height - margin);

  ctx.fillStyle = BRAND_COLORS.black;
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 4, width, height, radius);
  ctx.fill();

  ctx.fillStyle = BRAND_COLORS.black;
  const tailX = clamp(cx, x + 20, x + width - 20);
  const halfTail = 10;
  ctx.beginPath();
  if (above) {
    ctx.moveTo(tailX - halfTail + 4, y + height + 4);
    ctx.lineTo(tailX + 4, y + height + tailH + 4);
    ctx.lineTo(tailX + halfTail + 4, y + height + 4);
  } else {
    ctx.moveTo(tailX - halfTail + 4, y + 4);
    ctx.lineTo(tailX + 4, y - tailH + 4);
    ctx.lineTo(tailX + halfTail + 4, y + 4);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = bubbleColor;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();

  ctx.strokeStyle = BRAND_COLORS.black;
  ctx.lineWidth = borderWidth;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.stroke();

  ctx.fillStyle = bubbleColor;
  ctx.beginPath();
  if (above) {
    ctx.moveTo(tailX - halfTail, y + height);
    ctx.lineTo(tailX, y + height + tailH);
    ctx.lineTo(tailX + halfTail, y + height);
  } else {
    ctx.moveTo(tailX - halfTail, y);
    ctx.lineTo(tailX, y - tailH);
    ctx.lineTo(tailX + halfTail, y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = BRAND_COLORS.black;
  ctx.lineWidth = borderWidth;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = "700 13px 'Comic Neue', 'Avenir Next', sans-serif";
  lines.forEach((line, index) => {
    ctx.fillText(line, x + 14, y + padY + 13 + index * lineH);
  });

  return { top: y, bottom: y + height, above };
}

function drawNameLabel(actorId, cx, cy, bubbleInfo = null, theme = null) {
  const label = String(actorId || "agent");
  const accent = theme?.accentColor || colorFromId(actorId);

  ctx.font = "700 12px 'Comic Neue', 'Avenir Next', sans-serif";
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 24;
  const boxHeight = 20;
  const margin = 8;
  const x = clamp(cx - boxWidth / 2, margin, WORLD.width * CELL - boxWidth - margin);
  let preferredY;
  if (bubbleInfo == null) {
    preferredY = cy - 58;
  } else if (bubbleInfo.above) {
    preferredY = bubbleInfo.top - boxHeight - 6;
  } else {
    preferredY = cy - CELL / 2 - boxHeight - 6;
  }
  const y = clamp(preferredY, margin, WORLD.height * CELL - boxHeight - margin);

  ctx.fillStyle = BRAND_COLORS.white;
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, 10);
  ctx.fill();

  ctx.strokeStyle = BRAND_COLORS.mocha;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, 10);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + 10, y + boxHeight / 2, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = BRAND_COLORS.espresso;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 16, y + boxHeight / 2 + 0.5);
  ctx.textBaseline = "alphabetic";
}

function drawActor(actor) {
  if (!actor.inCafe) {
    return;
  }

  const cx = actor.x * CELL + CELL / 2;
  const cy = actor.y * CELL + CELL / 2;
  const theme = resolveActorTheme(actor);

  drawStickmanWithCoffee(cx, cy, theme.accentColor);
  const bubbleInfo = drawSpeechBubble(actor, cx, cy, theme);
  drawNameLabel(actor.id, cx, cy, bubbleInfo, theme);
}

let renderScheduled = false;
function render() {
  if (renderScheduled) { return; }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    drawGrid();
    for (const actor of WORLD.actors) {
      drawActor(actor);
    }
  });
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

function accentForActor(actorId) {
  const id = String(actorId || "agent");
  const theme = runtimeState.actorThemesById.get(id);
  if (theme?.accentColor) {
    return theme.accentColor;
  }
  return colorFromId(id);
}

function agentInitial(actorId) {
  const id = String(actorId || "?");
  return id.charAt(0).toUpperCase();
}

function createAgentDot(actorId, size) {
  const dot = document.createElement("div");
  dot.className = "agent-dot";
  const accent = accentForActor(actorId);
  dot.style.background = accent;
  dot.textContent = agentInitial(actorId);
  if (size) {
    dot.style.width = size + "px";
    dot.style.height = size + "px";
  }
  return dot;
}

function createEmptyState(icon, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const iconEl = document.createElement("div");
  iconEl.className = "empty-icon";
  iconEl.textContent = icon;
  const text = document.createElement("div");
  text.textContent = message;
  wrapper.append(iconEl, text);
  return wrapper;
}

function renderOrders(orders) {
  ordersList.innerHTML = "";
  if (orders.length === 0) {
    ordersList.appendChild(createEmptyState("\u2615", "No orders yet."));
    return;
  }
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const item = document.createElement("div");
    item.className = "feed-item";
    if (order._isNew) {
      item.classList.add("anim-wiggle");
      delete order._isNew;
    }
    const body = document.createElement("div");
    body.className = "feed-body";
    const title = document.createElement("strong");
    title.textContent = `${i + 1}. ${order.actorId} -> ${order.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${order.size} at ${formatTime(order.orderedAt)}`;
    body.append(title, meta);
    item.appendChild(body);
    ordersList.appendChild(item);
  }
}

function renderChats(chats) {
  chatList.innerHTML = "";
  if (chats.length === 0) {
    chatList.appendChild(createEmptyState("\u{1F4AC}", "The cafe is quiet."));
    return;
  }
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = "feed-item chat-item";
    if (chat._isNew) {
      item.classList.add("anim-flash");
      delete chat._isNew;
    }
    const body = document.createElement("div");
    body.className = "feed-body";
    const line = document.createElement("div");
    const actor = document.createElement("strong");
    actor.textContent = `${chat.actorId}: `;
    const chatText = document.createElement("span");
    chatText.className = "chat-text";
    chatText.textContent = chat.text;
    line.append(actor, chatText);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatTime(chat.saidAt);
    body.append(line, meta);
    item.appendChild(body);
    chatList.appendChild(item);
  }
}

function renderPresence(rows) {
  if (!presenceListFooter) {
    return;
  }
  presenceListFooter.innerHTML = "";
  if (rows.length === 0) {
    presenceListFooter.appendChild(createEmptyState("\u{1F6CB}\uFE0F", "No agents in the cafe right now."));
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "feed-item presence-item";
    const dot = createAgentDot(row.actorId, 32);
    const body = document.createElement("div");
    body.className = "feed-body";
    const title = document.createElement("strong");
    title.textContent = row.actorId;
    const isActive = row.isActive !== false;
    const statusText = row.status || (isActive ? "active" : "inactive");
    const badge = document.createElement("span");
    badge.className = "status-badge" + (isActive ? " active" : "");
    badge.textContent = statusText;
    title.appendChild(badge);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatTime(row.lastHeartbeatAt || row.updatedAt);
    body.append(title, meta);
    item.append(dot, body);
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
  rememberActorTheme(
    event?.actorId,
    event?.payload?.theme || event?.payload?.profile?.theme || event?.payload?.actor?.theme || event?.theme
  );
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
  rememberActorTheme(
    event?.actorId,
    event?.payload?.theme || event?.payload?.profile?.theme || event?.payload?.actor?.theme || event?.theme
  );
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

function updateStreamCursorFromEvents(events = []) {
  let next = Number(runtimeState.streamCursor || 0);
  for (const event of events) {
    const seq = Number(event?.sequence || 0);
    if (Number.isFinite(seq) && seq > next) {
      next = seq;
    }
  }
  runtimeState.streamCursor = next;
}

function spawnPosition() {
  return { x: DEFAULT_ACTOR_X, y: DEFAULT_ACTOR_Y };
}

function ensureWorldActor(map, actorId) {
  const id = String(actorId || "agent");
  let actor = map.get(id);
  if (!actor) {
    const spawn = spawnPosition();
    actor = {
      id,
      x: spawn.x,
      y: spawn.y,
      inCafe: true,
      bubble: null,
      currentOrder: null,
      theme: runtimeState.actorThemesById.get(id) || null,
      status: "idle",
      lastActiveAt: Date.now()
    };
    map.set(id, actor);
  } else if (!actor.theme) {
    actor.theme = runtimeState.actorThemesById.get(id) || null;
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
  rememberActorTheme(
    actorId,
    event?.payload?.theme ||
      event?.payload?.profile?.theme ||
      event?.payload?.actor?.theme ||
      event?.payload?.actorTheme ||
      event?.theme
  );
  actor.theme = runtimeState.actorThemesById.get(String(actorId)) || actor.theme;
  actor.lastActiveAt = eventTimestampMs(event);

  if (type === "agent_entered") {
    actor.inCafe = true;
    actor.status = "idle";
    const pos = event?.payload?.position;
    if (pos != null && typeof pos === "object") {
      const px = Number(pos.x);
      const py = Number(pos.y);
      if (Number.isFinite(px) && Number.isFinite(py)) {
        actor.x = clamp(px, 0, WORLD.width - 1);
        actor.y = clamp(py, 0, WORLD.height - 1);
      }
    }
    return;
  }

  if (type === "actor_moved") {
    actor.inCafe = true;
    actor.status = "busy";
    // Prefer absolute position (new events include it) over relative computation.
    const movePos = event?.payload?.position;
    if (movePos != null && typeof movePos === "object") {
      const mx = Number(movePos.x);
      const my = Number(movePos.y);
      if (Number.isFinite(mx) && Number.isFinite(my)) {
        actor.x = clamp(mx, 0, WORLD.width - 1);
        actor.y = clamp(my, 0, WORLD.height - 1);
        return;
      }
    }
    // Fallback for legacy events without absolute position.
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
    rememberActorTheme(presence.actorId, presence.theme || presence.profile?.theme);
    actor.theme = runtimeState.actorThemesById.get(String(presence.actorId)) || actor.theme;
    actor.status = presence.status || actor.status;
    actor.lastActiveAt =
      Date.parse(presence.lastHeartbeatAt || presence.updatedAt || presence.createdAt || "") || actor.lastActiveAt;
    actor.inCafe = String(actor.status || "").toLowerCase() !== "inactive";
    if (!actor.inCafe) {
      actor.bubble = null;
    }
  }

  // Preserve live bubbles from previous world state
  const now = Date.now();
  for (const [actorId, oldActor] of runtimeState.worldActorsById.entries()) {
    if (oldActor.bubble && Number(oldActor.bubble.expiresAt || 0) > now) {
      const newActor = map.get(actorId);
      if (newActor && newActor.inCafe && !newActor.bubble) {
        newActor.bubble = oldActor.bubble;
      }
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
    ingestSnapshotThemes(replayPayload?.data?.snapshot);
  } catch {
    const timelinePayload = await api(timelinePath);
    events = timelinePayload?.data?.events || [];
  }

  // Advance the stream cursor so the SSE connection won't re-send events
  // that were already processed in this replay (prevents flicker on load).
  updateStreamCursorFromEvents(events);

  projectWorldFromEvents(events, { source });
}

async function refreshRuntimeChats() {
  const path =
    `/v1/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}` +
    `&types=conversation_message_posted&order=desc&limit=${RUNTIME.chatLimit}`;
  const payload = await api(path);
  const events = payload?.data?.events || [];
  updateStreamCursorFromEvents(events);
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
  updateStreamCursorFromEvents(events);
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
  const rows = payload?.data?.presence || [];
  for (const row of rows) {
    if (!row?.actorId) {
      continue;
    }
    rememberActorTheme(row.actorId, row.theme || row.profile?.theme);
  }
  runtimeState.presence = rows.filter((row) => {
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
  updateStreamCursorFromEvents([data]);

  if (WORLD_EVENT_TYPES.has(data.type)) {
    applyEventToWorld(runtimeState.worldActorsById, data, { source: "live" });
    applyWorldFromMap();
  }

  if (data.type === "order_changed") {
    const order = toRuntimeOrder(data);
    if (order && !runtimeState.orderEventIds.has(order.eventId)) {
      runtimeState.orderEventIds.add(order.eventId);
      if (RUNTIME.initialLoadDone) {
        order._isNew = true;
      }
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
    if (RUNTIME.initialLoadDone) {
      chat._isNew = true;
    }
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
  const cursor = Number(runtimeState.streamCursor || 0);
  const cursorPart = Number.isFinite(cursor) && cursor > 0 ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const source = new EventSource(
    `/v1/streams/market-events?tenantId=${encodeURIComponent(RUNTIME.tenantId)}&roomId=${encodeURIComponent(RUNTIME.roomId)}${cursorPart}`
  );

  source.addEventListener("ready", () => {
    runtimeState.runtimeConnected = true;
    setRuntimeStatus(`Cafe stream live in room ${RUNTIME.roomId}`);
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

  source.addEventListener("ready", () => {
    sseReconnectAttempts = 0;
  });

  source.onerror = () => {
    runtimeState.runtimeConnected = false;
    setRuntimeStatus("Reconnecting agents to the cafe...");
    if (source.readyState === EventSource.CLOSED) {
      scheduleReconnect();
    }
  };

  return source;
}

function reconnectRuntimeStream() {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (runtimeStreamSource) {
    runtimeStreamSource.close();
  }
  runtimeState.runtimeConnected = false;
  sseReconnectAttempts = 0;
  runtimeStreamSource = connectRuntimeStream();
}

function scheduleReconnect() {
  if (sseReconnectTimer) {
    return;
  }
  sseReconnectAttempts += 1;
  const exp = Math.min(sseReconnectAttempts, 5);
  const delay = Math.min(SSE_RECONNECT_BASE_MS * (1 << exp), SSE_RECONNECT_MAX_MS);
  const jitter = Math.random() * 1000;
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    if (runtimeStreamSource) {
      runtimeStreamSource.close();
    }
    runtimeStreamSource = connectRuntimeStream();
  }, delay + jitter);
}

async function boot() {
  setRuntimeStatus("Brewing the live room stream...");
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

  RUNTIME.initialLoadDone = true;
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
    // Only resync when the SSE stream is down.  When connected, live events
    // are the source of truth — resyncing would overwrite them and cause
    // position jumps (the "two positionings" desync).
    if (runtimeState.runtimeConnected) {
      return;
    }
    if (!sseReconnectTimer) {
      scheduleReconnect();
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

// ---- Onboard modal ----

const onboardModal = document.getElementById("onboardModal");
const onboardBtn = document.getElementById("onboardBtn");
const modalClose = document.getElementById("modalClose");
const copyBtn = document.getElementById("copyBtn");
const mcpConfig = document.getElementById("mcpConfig");

function openModal() {
  onboardModal.classList.add("open");
}

function closeModal() {
  onboardModal.classList.remove("open");
}

onboardBtn.addEventListener("click", openModal);
modalClose.addEventListener("click", closeModal);
onboardModal.addEventListener("click", (e) => {
  if (e.target === onboardModal) {
    closeModal();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && onboardModal.classList.contains("open")) {
    closeModal();
  }
});

copyBtn.addEventListener("click", () => {
  const text = mcpConfig.textContent;

  function onSuccess() {
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 2000);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }

  function fallbackCopy(str) {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    onSuccess();
  }
});

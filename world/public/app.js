const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const menuList = document.getElementById("menuList");
const ordersList = document.getElementById("ordersList");
const chatList = document.getElementById("chatList");
const inboxList = document.getElementById("inboxList");
const presenceList = document.getElementById("presenceList");
const taskList = document.getElementById("taskList");
const streamStatus = document.getElementById("streamStatus");
const runtimeStatus = document.getElementById("runtimeStatus");
const roomModeText = document.getElementById("roomModeText");
const focusRoomInput = document.getElementById("focusRoomInput");
const focusRoomBtn = document.getElementById("focusRoomBtn");
const tableRoomInput = document.getElementById("tableRoomInput");
const tableOwnerInput = document.getElementById("tableOwnerInput");
const tableInvitesInput = document.getElementById("tableInvitesInput");
const tableDurationInput = document.getElementById("tableDurationInput");
const paymentProofInput = document.getElementById("paymentProofInput");
const openTableBtn = document.getElementById("openTableBtn");
const exportTranscriptBtn = document.getElementById("exportTranscriptBtn");
const sessionFeedback = document.getElementById("sessionFeedback");
const roomList = document.getElementById("roomList");
const sessionList = document.getElementById("sessionList");

const WORLD = {
  width: 20,
  height: 12,
  actors: []
};

const CELL = 40;
const RUNTIME = {
  tenantId: "default",
  roomId: "main",
  chatLimit: 100,
  inboxLimit: 100,
  presenceLimit: 100,
  taskLimit: 100,
  roomLimit: 50,
  sessionLimit: 50,
  timelineExportLimit: 1000,
  privateTablePriceUsd: 4
};

const runtimeState = {
  chats: [],
  chatEventIds: new Set(),
  inbox: [],
  presence: [],
  rooms: [],
  sessions: [],
  tasks: [],
  worldConnected: false,
  runtimeConnected: false,
  lastRuntimeEventAt: null
};

const TASK_EVENT_TYPES = new Set([
  "task_created",
  "task_updated",
  "task_assigned",
  "task_progress_updated",
  "task_completed"
]);

const PRESENCE_EVENT_TYPES = new Set([
  "agent_entered",
  "agent_left",
  "status_changed",
  "presence_heartbeat"
]);

const ROOM_EVENT_TYPES = new Set([
  "room_created",
  "room_updated",
  "table_session_created",
  "table_session_updated",
  "table_session_ended"
]);

let runtimeStreamSource = null;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeIdempotencyKey(prefix = "agentcafe-ui") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
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
  for (const item of menu) {
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
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${order.actorId} -> ${order.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${order.size} at ${formatTime(order.orderedAt)}`;
    li.append(title, meta);
    ordersList.appendChild(li);
  }
}

function renderChats(chats) {
  chatList.innerHTML = "";
  for (const chat of chats) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${chat.actorId}: ${chat.text}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${formatTime(chat.saidAt)}${chat.threadId ? ` | thread ${chat.threadId}` : ""}`;
    li.append(title, meta);
    chatList.appendChild(li);
  }
}

function inboxSummary(item) {
  if (item.topic === "mention") {
    return `mentioned in thread ${item.threadId || "n/a"}`;
  }
  if (item.topic === "task") {
    return `task assigned: ${item.payload?.taskId || "unknown"}`;
  }
  if (item.topic === "operator") {
    return `operator: ${item.payload?.action || "update"}`;
  }
  return item.sourceEventType || "event";
}

function renderInbox(items) {
  inboxList.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${item.actorId} <- ${item.topic}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${inboxSummary(item)} at ${formatTime(item.createdAt)}`;
    li.append(title, meta);
    inboxList.appendChild(li);
  }
}

function renderPresence(rows) {
  presenceList.innerHTML = "";
  for (const item of rows) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const activeDot = item.isActive ? "active" : "inactive";
    title.textContent = `${item.actorId} (${item.status || activeDot})`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `last heartbeat ${formatTime(item.lastHeartbeatAt || item.updatedAt)}`;
    li.append(title, meta);
    presenceList.appendChild(li);
  }
}

function renderTasks(rows) {
  taskList.innerHTML = "";
  for (const task of rows) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${task.title} [${task.state}] ${task.progress}%`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `assignee ${task.assigneeActorId || "unassigned"} | updated ${formatTime(task.updatedAt)}`;
    li.append(title, meta);
    taskList.appendChild(li);
  }
}

function updateRoomModeText() {
  if (!roomModeText) {
    return;
  }
  const focusedRoom =
    runtimeState.rooms.find((room) => room.roomId === RUNTIME.roomId) || {
      roomId: RUNTIME.roomId,
      roomType: RUNTIME.roomId === "main" ? "lobby" : "unknown",
      ownerActorId: null
    };
  const activeSessions = runtimeState.sessions.filter(
    (session) => session.roomId === RUNTIME.roomId && session.status === "active"
  ).length;
  const ownerLabel = focusedRoom.ownerActorId ? ` | owner ${focusedRoom.ownerActorId}` : "";
  roomModeText.textContent =
    `Room mode: ${focusedRoom.roomType} (${focusedRoom.roomId})` +
    `${ownerLabel} | active sessions ${activeSessions}`;
}

function renderRooms(rooms) {
  roomList.innerHTML = "";
  for (const room of rooms) {
    const li = document.createElement("li");
    if (room.roomId === RUNTIME.roomId) {
      li.classList.add("is-focused");
    }
    const title = document.createElement("strong");
    title.textContent = `${room.roomId} [${room.roomType}]`;
    const owner = room.ownerActorId || "none";
    const updatedAt = room.updatedAt || room.createdAt;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `owner ${owner} | updated ${formatTime(updatedAt)}`;
    li.append(title, meta);
    roomList.appendChild(li);
  }
}

function renderSessions(sessions) {
  sessionList.innerHTML = "";
  for (const session of sessions) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const shortId = String(session.sessionId || "").slice(0, 8);
    title.textContent = `${shortId} ${session.status} (${session.roomId})`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      `owner ${session.ownerActorId || "unknown"} | expires ${formatTime(session.expiresAt)} | ` +
      `$${Number(session.paymentAmountUsd || 0).toFixed(2)}`;
    li.append(title, meta);
    sessionList.appendChild(li);
  }
}

function applyWorldState(data) {
  WORLD.width = data.world.width;
  WORLD.height = data.world.height;
  WORLD.actors = Array.isArray(data.actors) ? data.actors : [];
  render();
}

function parseStreamData(event) {
  try {
    return JSON.parse(event.data || "{}");
  } catch {
    return {};
  }
}

function toRuntimeChat(event) {
  const text =
    event?.payload?.conversation?.text ||
    event?.payload?.bubble?.text ||
    event?.payload?.text ||
    "";
  if (!text) {
    return null;
  }
  return {
    eventId: event.eventId,
    actorId: event.actorId || "agent",
    text,
    saidAt: event.timestamp || new Date().toISOString(),
    threadId:
      event?.payload?.conversation?.threadId ||
      event?.payload?.conversation?.messageId ||
      event?.payload?.threadId ||
      null
  };
}

function setStreamStatus(text) {
  if (streamStatus) {
    streamStatus.textContent = text;
  }
}

function setRuntimeStatus(text) {
  if (runtimeStatus) {
    runtimeStatus.textContent = text;
  }
}

function setSessionFeedback(text, { error = false } = {}) {
  if (!sessionFeedback) {
    return;
  }
  sessionFeedback.textContent = text;
  sessionFeedback.classList.toggle("is-error", error);
}

function parseCsvList(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
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

async function refreshRuntimeChats() {
  const path =
    `/api/runtime/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
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

async function refreshRuntimeInbox() {
  const path =
    `/api/runtime/inbox?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}` +
    `&unreadOnly=true&order=desc&limit=${RUNTIME.inboxLimit}`;
  const payload = await api(path);
  runtimeState.inbox = payload?.data?.items || [];
  renderInbox(runtimeState.inbox);
}

async function refreshRuntimePresence() {
  const path =
    `/api/runtime/presence?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}&limit=${RUNTIME.presenceLimit}`;
  const payload = await api(path);
  runtimeState.presence = payload?.data?.presence || [];
  renderPresence(runtimeState.presence);
}

async function refreshRuntimeTasks() {
  const path =
    `/api/runtime/tasks?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&roomId=${encodeURIComponent(RUNTIME.roomId)}&limit=${RUNTIME.taskLimit}`;
  const payload = await api(path);
  runtimeState.tasks = payload?.data?.tasks || [];
  renderTasks(runtimeState.tasks);
}

async function refreshRuntimeRooms() {
  const path =
    `/api/runtime/rooms?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&limit=${RUNTIME.roomLimit}`;
  const payload = await api(path);
  runtimeState.rooms = payload?.data?.rooms || [];
  renderRooms(runtimeState.rooms);
  updateRoomModeText();
}

async function refreshRuntimeSessions() {
  const path =
    `/api/runtime/table-sessions?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
    `&limit=${RUNTIME.sessionLimit}`;
  const payload = await api(path);
  runtimeState.sessions = payload?.data?.sessions || [];
  renderSessions(runtimeState.sessions);
  updateRoomModeText();
}

async function refreshRuntimePanels() {
  const results = await Promise.allSettled([
    refreshRuntimeChats(),
    refreshRuntimeInbox(),
    refreshRuntimePresence(),
    refreshRuntimeTasks(),
    refreshRuntimeRooms(),
    refreshRuntimeSessions()
  ]);
  const rejected = results.find((item) => item.status === "rejected");
  if (rejected && rejected.reason) {
    throw rejected.reason;
  }
}

const refreshRuntimeInboxDebounced = debounce(() => {
  refreshRuntimeInbox().catch((error) => {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  });
}, 250);

const refreshRuntimeTasksDebounced = debounce(() => {
  refreshRuntimeTasks().catch((error) => {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  });
}, 250);

const refreshRuntimePresenceDebounced = debounce(() => {
  refreshRuntimePresence().catch((error) => {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  });
}, 250);

const refreshRuntimeRoomsDebounced = debounce(() => {
  refreshRuntimeRooms().catch((error) => {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  });
}, 250);

const refreshRuntimeSessionsDebounced = debounce(() => {
  refreshRuntimeSessions().catch((error) => {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  });
}, 250);

function handleRuntimeEvent(data) {
  runtimeState.lastRuntimeEventAt = Date.now();

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

  if (
    data.type === "mention_created" ||
    data.type === "task_assigned" ||
    data.type === "operator_override_applied"
  ) {
    refreshRuntimeInboxDebounced();
  }

  if (TASK_EVENT_TYPES.has(data.type)) {
    refreshRuntimeTasksDebounced();
  }

  if (PRESENCE_EVENT_TYPES.has(data.type)) {
    refreshRuntimePresenceDebounced();
  }

  if (ROOM_EVENT_TYPES.has(data.type)) {
    refreshRuntimeRoomsDebounced();
    refreshRuntimeSessionsDebounced();
  }
}

function connectWorldStream() {
  const source = new EventSource("/api/stream");

  source.addEventListener("ready", (event) => {
    const data = parseStreamData(event);
    if (data.snapshot) {
      applyWorldState(data.snapshot);
      if (Array.isArray(data.snapshot.orders)) {
        renderOrders(data.snapshot.orders);
      }
    }
    runtimeState.worldConnected = true;
    setStreamStatus("All agents are rendered live.");
  });

  source.addEventListener("state", (event) => {
    const data = parseStreamData(event);
    if (data.world && Array.isArray(data.actors)) {
      applyWorldState(data);
    }
    if (Array.isArray(data.orders)) {
      renderOrders(data.orders);
    }
  });

  source.addEventListener("heartbeat", () => {
    setStreamStatus("All agents are rendered live.");
  });

  source.onerror = () => {
    runtimeState.worldConnected = false;
    setStreamStatus("World stream reconnecting...");
  };

  return source;
}

function connectRuntimeStream() {
  const source = new EventSource(
    `/api/runtime/stream?tenantId=${encodeURIComponent(RUNTIME.tenantId)}&roomId=${encodeURIComponent(RUNTIME.roomId)}`
  );

  source.addEventListener("ready", () => {
    runtimeState.runtimeConnected = true;
    setRuntimeStatus(`Runtime stream live in room ${RUNTIME.roomId}. All agents are rendered live.`);
  });

  source.addEventListener("heartbeat", () => {
    runtimeState.lastRuntimeEventAt = Date.now();
    setRuntimeStatus(`Runtime stream live in room ${RUNTIME.roomId}. All agents are rendered live.`);
  });

  const eventTypes = [
    "conversation_message_posted",
    "mention_created",
    "task_created",
    "task_updated",
    "task_assigned",
    "task_progress_updated",
    "task_completed",
    "operator_override_applied",
    "agent_entered",
    "agent_left",
    "status_changed",
    "presence_heartbeat",
    "room_created",
    "room_updated",
    "table_session_created",
    "table_session_updated",
    "table_session_ended"
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
    setRuntimeStatus("Runtime stream reconnecting...");
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

async function focusRoom(roomIdInput) {
  const nextRoomId = String(roomIdInput || "").trim() || "main";
  if (focusRoomInput) {
    focusRoomInput.value = nextRoomId;
  }
  if (RUNTIME.roomId === nextRoomId && runtimeState.runtimeConnected) {
    return;
  }
  RUNTIME.roomId = nextRoomId;
  runtimeState.chatEventIds.clear();
  setRuntimeStatus(`Switching runtime room to ${RUNTIME.roomId}...`);
  updateRoomModeText();
  await refreshRuntimePanels();
  reconnectRuntimeStream();
  setSessionFeedback(`Focused room ${RUNTIME.roomId}.`);
}

async function openPrivateTable() {
  const roomId = String(tableRoomInput?.value || "").trim();
  const ownerActorId = String(tableOwnerInput?.value || "").trim();
  if (!roomId) {
    throw new Error("Private table id is required");
  }
  if (!ownerActorId) {
    throw new Error("Owner actor is required");
  }
  const invitedActorIds = parseCsvList(tableInvitesInput?.value || "").filter(
    (actorId) => actorId !== ownerActorId
  );
  const durationMinutes = clamp(Number(tableDurationInput?.value || 90), 5, 1440);
  const paymentProof = String(paymentProofInput?.value || "").trim() || "coffee_paid";

  await api("/api/runtime/rooms", {
    method: "POST",
    idempotencyKey: makeIdempotencyKey("room-upsert"),
    body: {
      tenantId: RUNTIME.tenantId,
      roomId,
      actorId: ownerActorId,
      roomType: "private_table",
      ownerActorId,
      paymentProof,
      paymentAmountUsd: RUNTIME.privateTablePriceUsd
    }
  });

  const payload = await api("/api/runtime/table-sessions", {
    method: "POST",
    idempotencyKey: makeIdempotencyKey("table-session"),
    body: {
      tenantId: RUNTIME.tenantId,
      actorId: ownerActorId,
      ownerActorId,
      roomId,
      invitedActorIds,
      durationMinutes,
      paymentProof,
      paymentAmountUsd: RUNTIME.privateTablePriceUsd
    }
  });

  await refreshRuntimeRooms();
  await refreshRuntimeSessions();
  await focusRoom(roomId);

  const sessionId = payload?.data?.session?.sessionId || "unknown";
  setSessionFeedback(`Private table opened (${roomId}), session ${sessionId}.`);
}

async function exportTranscript() {
  const payload = await api(
    `/api/runtime/timeline?tenantId=${encodeURIComponent(RUNTIME.tenantId)}` +
      `&roomId=${encodeURIComponent(RUNTIME.roomId)}` +
      `&order=desc&limit=${RUNTIME.timelineExportLimit}`
  );
  const events = payload?.data?.events || [];
  const blob = new Blob(
    [
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          tenantId: RUNTIME.tenantId,
          roomId: RUNTIME.roomId,
          count: events.length,
          events
        },
        null,
        2
      )
    ],
    { type: "application/json" }
  );
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `agentcafe-transcript-${RUNTIME.roomId}-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  setSessionFeedback(`Transcript exported (${events.length} events).`);
}

function bindSessionControls() {
  focusRoomBtn?.addEventListener("click", () => {
    void focusRoom(focusRoomInput?.value || "main").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionFeedback(message, { error: true });
      setRuntimeStatus(message);
    });
  });

  focusRoomInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    void focusRoom(focusRoomInput.value).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionFeedback(message, { error: true });
      setRuntimeStatus(message);
    });
  });

  openTableBtn?.addEventListener("click", () => {
    setSessionFeedback("Opening private table...");
    void openPrivateTable().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionFeedback(message, { error: true });
      setRuntimeStatus(message);
    });
  });

  exportTranscriptBtn?.addEventListener("click", () => {
    setSessionFeedback("Exporting transcript...");
    void exportTranscript().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSessionFeedback(message, { error: true });
      setRuntimeStatus(message);
    });
  });
}

async function boot() {
  bindSessionControls();
  if (focusRoomInput) {
    focusRoomInput.value = RUNTIME.roomId;
  }
  if (tableRoomInput && !tableRoomInput.value.trim()) {
    tableRoomInput.value = `private-${Date.now().toString(36).slice(-6)}`;
  }

  const [menuData, stateData, ordersData] = await Promise.all([
    api("/api/menu"),
    api("/api/state"),
    api("/api/orders?limit=50")
  ]);

  renderMenu(menuData.menu || []);
  applyWorldState(stateData);
  renderOrders(ordersData.orders || []);

  try {
    await refreshRuntimePanels();
  } catch (error) {
    setRuntimeStatus(error instanceof Error ? error.message : String(error));
  }

  connectWorldStream();
  reconnectRuntimeStream();

  setInterval(() => {
    if (!runtimeState.runtimeConnected) {
      return;
    }
    void refreshRuntimeInbox().catch(() => {});
    void refreshRuntimeTasks().catch(() => {});
    void refreshRuntimePresence().catch(() => {});
  }, 15000);

  setInterval(() => {
    if (!runtimeState.runtimeConnected) {
      return;
    }
    void refreshRuntimeChats().catch(() => {});
  }, 30000);

  setInterval(() => {
    void refreshRuntimeRooms().catch(() => {});
    void refreshRuntimeSessions().catch(() => {});
  }, 30000);
}

boot().catch((error) => {
  ordersList.innerHTML = "";
  chatList.innerHTML = "";
  inboxList.innerHTML = "";
  presenceList.innerHTML = "";
  taskList.innerHTML = "";
  roomList.innerHTML = "";
  sessionList.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = error instanceof Error ? error.message : String(error);
  ordersList.appendChild(li);
  setRuntimeStatus(li.textContent);
  setSessionFeedback(li.textContent, { error: true });
});

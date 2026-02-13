const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const menuList = document.getElementById("menuList");
const ordersList = document.getElementById("ordersList");
const chatList = document.getElementById("chatList");

const WORLD = {
  width: 20,
  height: 12,
  actors: []
};

const CELL = 40;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `request failed: ${res.status}`);
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

function formatTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "unknown time";
  }
  return new Date(value).toLocaleTimeString([], {
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
    meta.textContent = formatTime(chat.saidAt);
    li.append(title, meta);
    chatList.appendChild(li);
  }
}

async function refreshState() {
  const data = await api("/api/state");
  WORLD.width = data.world.width;
  WORLD.height = data.world.height;
  WORLD.actors = data.actors;
  render();
}

async function refreshOrders() {
  const data = await api("/api/orders?limit=50");
  renderOrders(data.orders || []);
}

async function refreshChats() {
  const data = await api("/api/chats?limit=100");
  renderChats(data.chats || []);
}

async function boot() {
  const menuData = await api("/api/menu");
  renderMenu(menuData.menu || []);
  await refreshState();
  await refreshOrders();
  await refreshChats();

  setInterval(async () => {
    try {
      await refreshState();
      await refreshOrders();
      await refreshChats();
    } catch {
      // Ignore transient polling errors.
    }
  }, 1000);
}

boot().catch((error) => {
  ordersList.innerHTML = "";
  chatList.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = error instanceof Error ? error.message : String(error);
  ordersList.appendChild(li);
});

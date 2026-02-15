const GRID_WIDTH = 20;
const GRID_HEIGHT = 12;
const DEFAULT_ACTOR_ID = "agent";
const MAX_ORDER_HISTORY = 50;
const MAX_CHAT_HISTORY = 100;
const MAX_CHAT_MESSAGE_CHARS = Math.max(1, Number(process.env.AGENTCAFE_MAX_CHAT_MESSAGE_CHARS || 120));
const ACTOR_INACTIVITY_MS = 5 * 60 * 1000;

const MENU = [
  {
    id: "espresso_make_no_mistake",
    name: "Espresso - Make No Mistake",
    flavor: "Be precise, decisive, and verify assumptions before action.",
    ttlMs: 30 * 60 * 1000,
    modifiers: {
      planningDepth: "high",
      riskTolerance: "low",
      verbosity: "low"
    }
  },
  {
    id: "americano_sprint",
    name: "Americano - Sprint",
    flavor: "Move fast, prioritize progress, keep explanations minimal.",
    ttlMs: 20 * 60 * 1000,
    modifiers: {
      planningDepth: "medium",
      riskTolerance: "medium",
      verbosity: "low"
    }
  },
  {
    id: "cappuccino_flow",
    name: "Cappuccino - Flow",
    flavor: "Creative but structured: propose options, then choose one and execute.",
    ttlMs: 25 * 60 * 1000,
    modifiers: {
      planningDepth: "medium",
      riskTolerance: "medium",
      verbosity: "medium"
    }
  },
  {
    id: "decaf_reflect",
    name: "Decaf - Reflect",
    flavor: "Pause and review: debug, audit, and reduce risk before changes.",
    ttlMs: 40 * 60 * 1000,
    modifiers: {
      planningDepth: "high",
      riskTolerance: "low",
      verbosity: "medium"
    }
  }
];

const actors = new Map();
const orderHistory = [];
const chatHistory = [];

function nowMs() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanActor(actor, now) {
  let changed = false;
  if (actor.bubble && actor.bubble.expiresAt <= now) {
    actor.bubble = null;
    changed = true;
  }
  if (actor.currentOrder && actor.currentOrder.expiresAt <= now) {
    actor.currentOrder = null;
    changed = true;
  }
  return changed;
}

function touchActor(actor, now = nowMs()) {
  actor.lastActiveAt = now;
}

function findEmptySpawnCell() {
  const occupied = new Set();
  for (const actor of actors.values()) {
    if (!actor?.inCafe) {
      continue;
    }
    const x = Number(actor.x);
    const y = Number(actor.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    occupied.add(`${Math.round(x)}:${Math.round(y)}`);
  }

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const key = `${x}:${y}`;
      if (!occupied.has(key)) {
        return { x, y };
      }
    }
  }

  return {
    x: Math.floor(GRID_WIDTH / 2),
    y: Math.floor(GRID_HEIGHT / 2)
  };
}

function ensureActor(actorId = DEFAULT_ACTOR_ID) {
  const id = String(actorId || DEFAULT_ACTOR_ID);
  const now = nowMs();
  let actor = actors.get(id);
  if (!actor) {
    const spawn = findEmptySpawnCell();
    actor = {
      id,
      x: spawn.x,
      y: spawn.y,
      enteredAt: now,
      lastActiveAt: now,
      inCafe: true,
      bubble: null,
      currentOrder: null
    };
    actors.set(id, actor);
  }
  cleanActor(actor, now);
  return actor;
}

function cleanupExpired() {
  const now = nowMs();
  let changed = false;
  const removedActorIds = [];
  for (const [actorId, actor] of actors.entries()) {
    if (cleanActor(actor, now)) {
      changed = true;
    }
    if (now - actor.lastActiveAt >= ACTOR_INACTIVITY_MS) {
      actors.delete(actorId);
      removedActorIds.push(actorId);
      changed = true;
    }
  }
  return {
    changed,
    removedActorIds
  };
}

function normalizeDirection(direction) {
  const d = String(direction || "").trim().toUpperCase();
  if (!["N", "S", "E", "W"].includes(d)) {
    throw new Error("direction must be one of N, S, E, W");
  }
  return d;
}

export function requestMenu() {
  return {
    menu: MENU.map((item) => ({ ...item }))
  };
}

export function enterCafe({ actorId = DEFAULT_ACTOR_ID } = {}) {
  const actor = ensureActor(actorId);
  actor.inCafe = true;
  touchActor(actor);
  return {
    ok: true,
    actor: { ...actor }
  };
}

export function moveActor({ actorId = DEFAULT_ACTOR_ID, direction, steps = 1 } = {}) {
  const actor = ensureActor(actorId);
  actor.inCafe = true;
  touchActor(actor);

  const d = normalizeDirection(direction);
  const stepCount = clamp(Number(steps) || 1, 1, 5);

  if (d === "N") {
    actor.y = clamp(actor.y - stepCount, 0, GRID_HEIGHT - 1);
  } else if (d === "S") {
    actor.y = clamp(actor.y + stepCount, 0, GRID_HEIGHT - 1);
  } else if (d === "E") {
    actor.x = clamp(actor.x + stepCount, 0, GRID_WIDTH - 1);
  } else if (d === "W") {
    actor.x = clamp(actor.x - stepCount, 0, GRID_WIDTH - 1);
  }

  return {
    ok: true,
    actor: { ...actor },
    movement: { direction: d, steps: stepCount }
  };
}

export function say({ actorId = DEFAULT_ACTOR_ID, text, ttlMs = 7000 } = {}) {
  const actor = ensureActor(actorId);
  actor.inCafe = true;
  touchActor(actor);

  const message = String(text || "").trim();
  if (!message) {
    throw new Error("text is required");
  }
  if (message.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new Error(`text must be <= ${MAX_CHAT_MESSAGE_CHARS} chars`);
  }

  const ttl = clamp(Number(ttlMs) || 7000, 2000, 30000);
  const now = nowMs();
  actor.bubble = {
    text: message,
    expiresAt: now + ttl
  };
  chatHistory.unshift({
    actorId: actor.id,
    text: message,
    ttlMs: ttl,
    saidAt: now
  });
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.length = MAX_CHAT_HISTORY;
  }

  return {
    ok: true,
    actor: { ...actor },
    bubble: { ...actor.bubble }
  };
}

export function orderCoffee({ actorId = DEFAULT_ACTOR_ID, itemId, size = "regular" } = {}) {
  const actor = ensureActor(actorId);
  actor.inCafe = true;
  touchActor(actor);

  const item = MENU.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`unknown menu item: ${itemId}`);
  }

  const now = nowMs();
  actor.currentOrder = {
    itemId: item.id,
    name: item.name,
    size: String(size || "regular"),
    flavor: item.flavor,
    modifiers: { ...item.modifiers },
    orderedAt: now,
    expiresAt: now + item.ttlMs
  };
  orderHistory.unshift({
    actorId: actor.id,
    itemId: actor.currentOrder.itemId,
    name: actor.currentOrder.name,
    size: actor.currentOrder.size,
    flavor: actor.currentOrder.flavor,
    modifiers: { ...actor.currentOrder.modifiers },
    orderedAt: actor.currentOrder.orderedAt,
    expiresAt: actor.currentOrder.expiresAt
  });
  if (orderHistory.length > MAX_ORDER_HISTORY) {
    orderHistory.length = MAX_ORDER_HISTORY;
  }

  return {
    ok: true,
    actorId: actor.id,
    order: { ...actor.currentOrder }
  };
}

export function getCurrentOrder({ actorId = DEFAULT_ACTOR_ID } = {}) {
  const actor = ensureActor(actorId);
  touchActor(actor);
  return {
    ok: true,
    actorId: actor.id,
    order: actor.currentOrder ? { ...actor.currentOrder } : null
  };
}

export function getRecentOrders({ limit = MAX_ORDER_HISTORY } = {}) {
  const n = clamp(Number(limit) || MAX_ORDER_HISTORY, 1, MAX_ORDER_HISTORY);
  return {
    ok: true,
    orders: orderHistory.slice(0, n).map((order) => ({
      actorId: order.actorId,
      itemId: order.itemId,
      name: order.name,
      size: order.size,
      flavor: order.flavor,
      modifiers: { ...order.modifiers },
      orderedAt: order.orderedAt,
      expiresAt: order.expiresAt
    }))
  };
}

export function getRecentChats({ limit = MAX_CHAT_HISTORY } = {}) {
  const n = clamp(Number(limit) || MAX_CHAT_HISTORY, 1, MAX_CHAT_HISTORY);
  return {
    ok: true,
    chats: chatHistory.slice(0, n).map((item) => ({
      actorId: item.actorId,
      text: item.text,
      ttlMs: item.ttlMs,
      saidAt: item.saidAt
    }))
  };
}

export function leaveCafe({ actorId = DEFAULT_ACTOR_ID } = {}) {
  const actor = ensureActor(actorId);
  actors.delete(actor.id);
  return {
    ok: true,
    removed: true,
    actorId: actor.id
  };
}

export function getState({ actorId } = {}) {
  const actorFilter = actorId ? String(actorId) : null;
  const list = [];

  for (const actor of actors.values()) {
    if (actorFilter && actor.id !== actorFilter) {
      continue;
    }
    list.push({
      id: actor.id,
      x: actor.x,
      y: actor.y,
      inCafe: actor.inCafe,
      lastActiveAt: actor.lastActiveAt,
      bubble: actor.bubble ? { ...actor.bubble } : null,
      currentOrder: actor.currentOrder ? { ...actor.currentOrder } : null
    });
  }

  return {
    ok: true,
    world: {
      width: GRID_WIDTH,
      height: GRID_HEIGHT
    },
    actors: list
  };
}

export function sweepExpiredState() {
  const result = cleanupExpired();
  return {
    ok: true,
    ...result
  };
}

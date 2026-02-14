import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEvent, EVENT_TYPES } from "../shared/events.mjs";
import { InMemoryEventStore } from "../api/event-store.mjs";
import { FilePermissionStore } from "../api/permission-store.mjs";
import { ModerationPolicy, MODERATION_REASON_CODES } from "../api/moderation-policy.mjs";
import { ReactionEngine } from "../api/reaction-engine.mjs";
import { FileReactionStore } from "../api/reaction-store.mjs";

async function waitFor(predicate, { timeoutMs = 1000, stepMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

test("ACF-403 reaction engine triggers internal agent reaction and respects permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-react-"));
  const reactionFile = path.join(dir, "reactions.json");
  const permFile = path.join(dir, "permissions.json");
  const eventStore = new InMemoryEventStore();
  const reactionStore = new FileReactionStore({ filePath: reactionFile });
  const permissionStore = new FilePermissionStore({ filePath: permFile });
  const engine = new ReactionEngine({
    eventStore,
    reactionStore,
    permissionStore,
    maxConcurrency: 2
  });

  try {
    await reactionStore.init();
    await permissionStore.init();
    engine.start();

    const sub = await reactionStore.create({
      tenantId: "default",
      roomId: "main",
      targetActorId: "Kai",
      triggerEventTypes: [EVENT_TYPES.ORDER],
      actionType: "say",
      actionPayload: { text: "Copy that." },
      cooldownMs: 0
    });

    const source1 = eventStore.append(
      createEvent({
        tenantId: "default",
        roomId: "main",
        actorId: "Nova",
        type: EVENT_TYPES.ORDER,
        payload: { itemId: "latte", size: "regular" }
      })
    );

    const firstReactionAppeared = await waitFor(() => {
      const all = eventStore.list({ tenantId: "default", roomId: "main", order: "asc", limit: 50 });
      return all.some(
        (item) =>
          item.actorId === "Kai" &&
          item.type === EVENT_TYPES.CONVERSATION_MESSAGE &&
          item.causationId === source1.eventId
      );
    });
    assert.equal(firstReactionAppeared, true);

    await permissionStore.upsert({
      tenantId: "default",
      roomId: "main",
      actorId: "Kai",
      patch: { canSpeak: false }
    });

    const source2 = eventStore.append(
      createEvent({
        tenantId: "default",
        roomId: "main",
        actorId: "Nova",
        type: EVENT_TYPES.ORDER,
        payload: { itemId: "espresso", size: "small" }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    const events = eventStore.list({ tenantId: "default", roomId: "main", order: "asc", limit: 100 });
    const reactions = events.filter((item) => item.actorId === "Kai" && item.type === EVENT_TYPES.CONVERSATION_MESSAGE);
    assert.equal(reactions.length, 1);
    assert.equal(
      events.some((item) => item.causationId === source2.eventId && item.actorId === "Kai"),
      false
    );

    const latestSub = await reactionStore.getById(sub.id);
    assert.equal(latestSub?.errorCount > 0, true);
    assert.ok(String(latestSub?.lastError || "").includes("forbidden:canSpeak"));
  } finally {
    engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACF-802 reaction engine respects moderation policy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-react-mod-"));
  const reactionFile = path.join(dir, "reactions.json");
  const permFile = path.join(dir, "permissions.json");
  const eventStore = new InMemoryEventStore();
  const reactionStore = new FileReactionStore({ filePath: reactionFile });
  const permissionStore = new FilePermissionStore({ filePath: permFile });
  const moderationPolicy = new ModerationPolicy({
    windowMs: 60000,
    maxActionsPerWindow: 1,
    maxRepeatedTextPerWindow: 10,
    minActionIntervalMs: 0,
    cooldownMs: 2000
  });
  const engine = new ReactionEngine({
    eventStore,
    reactionStore,
    permissionStore,
    moderationPolicy,
    maxConcurrency: 1
  });

  try {
    await reactionStore.init();
    await permissionStore.init();
    engine.start();

    const sub = await reactionStore.create({
      tenantId: "default",
      roomId: "main",
      targetActorId: "Kai",
      triggerEventTypes: [EVENT_TYPES.ORDER],
      actionType: "say",
      actionPayload: { text: "Roger." },
      cooldownMs: 0
    });

    const source1 = eventStore.append(
      createEvent({
        tenantId: "default",
        roomId: "main",
        actorId: "Nova",
        type: EVENT_TYPES.ORDER,
        payload: { itemId: "latte", size: "regular" }
      })
    );
    const source2 = eventStore.append(
      createEvent({
        tenantId: "default",
        roomId: "main",
        actorId: "Nova",
        type: EVENT_TYPES.ORDER,
        payload: { itemId: "americano", size: "small" }
      })
    );

    const done = await waitFor(async () => {
      const row = await reactionStore.getById(sub.id);
      return Boolean(row?.lastSourceEventId === source1.eventId && row?.errorCount > 0);
    });
    assert.equal(done, true);

    const events = eventStore.list({ tenantId: "default", roomId: "main", order: "asc", limit: 100 });
    const reactions = events.filter((item) => item.actorId === "Kai" && item.type === EVENT_TYPES.CONVERSATION_MESSAGE);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].causationId, source1.eventId);
    assert.equal(
      reactions.some((item) => item.causationId === source2.eventId),
      false
    );

    const latestSub = await reactionStore.getById(sub.id);
    assert.ok(String(latestSub?.lastError || "").startsWith("moderated:"));
    assert.ok(
      [MODERATION_REASON_CODES.MOD_RATE_LIMIT, MODERATION_REASON_CODES.MOD_COOLDOWN].some((code) =>
        String(latestSub?.lastError || "").includes(code)
      )
    );
  } finally {
    engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

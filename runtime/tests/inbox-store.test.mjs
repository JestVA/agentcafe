import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileInboxStore } from "../api/inbox-store.mjs";
import { projectInboxItemsFromEvent } from "../api/inbox-projection.mjs";

function event(overrides = {}) {
  return {
    sequence: 1,
    eventId: "11111111-1111-4111-8111-111111111111",
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    type: "mention_created",
    timestamp: "2026-02-14T00:00:00.000Z",
    payload: {
      mentionedActorId: "Kai",
      sourceMessageId: "22222222-2222-4222-8222-222222222222",
      threadId: "thread-1"
    },
    ...overrides
  };
}

test("ACF-906 inbox projection dedupes and supports ack flows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-inbox-"));
  const store = new FileInboxStore({ filePath: path.join(dir, "inbox.json") });
  await store.init();

  const first = await store.projectEvent(event());
  const duplicate = await store.projectEvent(event());

  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);

  let unread = await store.countUnread({ tenantId: "default", actorId: "Kai" });
  assert.equal(unread, 1);

  const listed = await store.list({ tenantId: "default", actorId: "Kai", unreadOnly: true });
  assert.equal(listed.length, 1);

  const acked = await store.ackOne({
    tenantId: "default",
    actorId: "Kai",
    inboxId: listed[0].inboxId,
    ackedBy: "Kai"
  });
  assert.equal(Boolean(acked), true);
  assert.equal(acked.changed, true);

  unread = await store.countUnread({ tenantId: "default", actorId: "Kai" });
  assert.equal(unread, 0);

  const replayAck = await store.ackOne({
    tenantId: "default",
    actorId: "Kai",
    inboxId: listed[0].inboxId,
    ackedBy: "Kai"
  });
  assert.equal(replayAck.changed, false);
});

test("ACF-906 bulk ack by cursor and ids", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-inbox-"));
  const store = new FileInboxStore({ filePath: path.join(dir, "inbox.json") });
  await store.init();

  await store.projectEvent(event({
    sequence: 10,
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    payload: { mentionedActorId: "Kai", threadId: "t-1", sourceMessageId: "s-1" }
  }));
  await store.projectEvent(event({
    sequence: 11,
    eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    payload: { mentionedActorId: "Kai", threadId: "t-1", sourceMessageId: "s-2" }
  }));

  const all = await store.list({ tenantId: "default", actorId: "Kai", order: "asc" });
  assert.equal(all.length, 2);

  const byCursor = await store.ackMany({
    tenantId: "default",
    actorId: "Kai",
    upToCursor: all[0].inboxSeq,
    ackedBy: "Kai"
  });
  assert.equal(byCursor.ackedCount, 1);

  const byIds = await store.ackMany({
    tenantId: "default",
    actorId: "Kai",
    ids: [all[1].inboxId],
    ackedBy: "Kai"
  });
  assert.equal(byIds.ackedCount, 1);

  const unread = await store.countUnread({ tenantId: "default", actorId: "Kai" });
  assert.equal(unread, 0);
});

test("ACF-907 projection targets mention, task assignment, and operator events", () => {
  const mention = projectInboxItemsFromEvent(event());
  assert.equal(mention.length, 1);
  assert.equal(mention[0].actorId, "Kai");
  assert.equal(mention[0].topic, "mention");

  const task = projectInboxItemsFromEvent({
    sequence: 2,
    eventId: "33333333-3333-4333-8333-333333333333",
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    type: "task_assigned",
    timestamp: "2026-02-14T00:00:01.000Z",
    payload: {
      taskId: "44444444-4444-4444-8444-444444444444",
      fromAssigneeActorId: null,
      toAssigneeActorId: "Mina",
      assignedBy: "Nova"
    }
  });
  assert.equal(task.length, 1);
  assert.equal(task[0].actorId, "Mina");
  assert.equal(task[0].topic, "task");

  const operator = projectInboxItemsFromEvent({
    sequence: 3,
    eventId: "55555555-5555-4555-8555-555555555555",
    tenantId: "default",
    roomId: "main",
    actorId: "operator",
    type: "operator_override_applied",
    timestamp: "2026-02-14T00:00:02.000Z",
    payload: {
      action: "mute_agent",
      targetActorId: "Mina",
      reason: "spam"
    }
  });
  assert.equal(operator.length, 1);
  assert.equal(operator[0].actorId, "Mina");
  assert.equal(operator[0].topic, "operator");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMentionReply,
  isMentionInboxItem,
  isTaskInboxItem,
  selectThreadMessages,
  shouldRouteMention
} from "../orchestrator/loop.mjs";

test("selectThreadMessages returns only messages from the target thread ordered ascending", () => {
  const events = [
    {
      sequence: 10,
      type: "conversation_message_posted",
      actorId: "Nova",
      payload: {
        conversation: {
          messageId: "m1",
          threadId: "t1",
          text: "hello"
        }
      }
    },
    {
      sequence: 12,
      type: "conversation_message_posted",
      actorId: "Ember",
      payload: {
        conversation: {
          messageId: "m2",
          threadId: "t2",
          text: "other"
        }
      }
    },
    {
      sequence: 11,
      type: "conversation_message_posted",
      actorId: "Bill",
      payload: {
        conversation: {
          messageId: "m3",
          threadId: "t1",
          text: "followup"
        }
      }
    }
  ];

  const selected = selectThreadMessages(events, { threadId: "t1", limit: 10 });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].sequence, 10);
  assert.equal(selected[1].sequence, 11);
});

test("buildMentionReply includes source actor and remains bounded by max chars", () => {
  const text = buildMentionReply({
    actorId: "Nova",
    sourceActorId: "Ember",
    threadMessages: [
      { actorId: "Bill", text: "Need help" },
      { actorId: "Ember", text: "Please react" }
    ],
    maxChars: 90
  });

  assert.match(text, /@Ember/);
  assert.match(text, /@Nova/);
  assert.ok(text.length <= 90);
});

test("isMentionInboxItem validates topic, target actor, and unread status", () => {
  const item = {
    topic: "mention",
    actorId: "Nova",
    ackedAt: null
  };

  assert.equal(isMentionInboxItem(item, "Nova"), true);
  assert.equal(isMentionInboxItem({ ...item, topic: "task" }, "Nova"), false);
  assert.equal(isMentionInboxItem({ ...item, ackedAt: "2026-02-14T00:00:00Z" }, "Nova"), false);
  assert.equal(isMentionInboxItem(item, "Ember"), false);
});

test("isTaskInboxItem validates task topic and actor target", () => {
  const item = {
    topic: "task",
    actorId: "Nova",
    ackedAt: null
  };

  assert.equal(isTaskInboxItem(item, "Nova"), true);
  assert.equal(isTaskInboxItem({ ...item, topic: "mention" }, "Nova"), false);
  assert.equal(isTaskInboxItem({ ...item, ackedAt: "2026-02-14T00:00:00Z" }, "Nova"), false);
  assert.equal(isTaskInboxItem(item, "Ember"), false);
});

test("shouldRouteMention enforces source and thread filters", () => {
  const base = {
    sourceActorId: "Nova",
    threadId: "room-main-123"
  };

  assert.deepEqual(
    shouldRouteMention({
      ...base,
      allowedSources: new Set(["Nova"]),
      deniedSources: new Set(),
      allowedThreadPrefixes: ["room-main-"]
    }),
    { allow: true, reason: null }
  );

  assert.equal(
    shouldRouteMention({
      ...base,
      allowedSources: new Set(["Echo"]),
      deniedSources: new Set(),
      allowedThreadPrefixes: []
    }).reason,
    "source_not_allowlisted"
  );

  assert.equal(
    shouldRouteMention({
      ...base,
      deniedSources: new Set(["Nova"])
    }).reason,
    "blocked_source"
  );

  assert.equal(
    shouldRouteMention({
      ...base,
      allowedThreadPrefixes: ["private-"]
    }).reason,
    "thread_not_allowlisted"
  );
});

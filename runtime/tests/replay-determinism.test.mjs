import assert from "node:assert/strict";
import test from "node:test";
import { ProjectionState } from "../projector/projection-state.mjs";

function event({
  sequence,
  eventId,
  tenantId = "default",
  roomId = "main",
  actorId,
  type,
  timestamp,
  payload = {}
}) {
  return {
    sequence,
    eventId,
    tenantId,
    roomId,
    actorId,
    type,
    timestamp,
    payload,
    correlationId: "11111111-1111-4111-8111-111111111111",
    causationId: null
  };
}

const FIXTURE_EVENTS = [
  event({
    sequence: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    actorId: "Nova",
    type: "agent_entered",
    timestamp: "2026-02-14T10:00:00.000Z"
  }),
  event({
    sequence: 2,
    eventId: "00000000-0000-4000-8000-000000000002",
    actorId: "Nova",
    type: "actor_moved",
    timestamp: "2026-02-14T10:00:05.000Z",
    payload: { direction: "E", steps: 2 }
  }),
  event({
    sequence: 3,
    eventId: "00000000-0000-4000-8000-000000000003",
    actorId: "Nova",
    type: "conversation_message_posted",
    timestamp: "2026-02-14T10:00:10.000Z",
    payload: {
      conversation: {
        messageId: "m-1",
        threadId: "t-1",
        parentMessageId: null,
        text: "Morning @Kai",
        mentions: ["Kai"]
      }
    }
  }),
  event({
    sequence: 4,
    eventId: "00000000-0000-4000-8000-000000000004",
    actorId: "Kai",
    type: "agent_entered",
    timestamp: "2026-02-14T10:00:15.000Z"
  }),
  event({
    sequence: 5,
    eventId: "00000000-0000-4000-8000-000000000005",
    actorId: "Kai",
    type: "conversation_message_posted",
    timestamp: "2026-02-14T10:00:20.000Z",
    payload: {
      conversation: {
        messageId: "m-2",
        threadId: "t-1",
        parentMessageId: "m-1",
        text: "Replying to @Nova",
        mentions: ["Nova"]
      }
    }
  }),
  event({
    sequence: 6,
    eventId: "00000000-0000-4000-8000-000000000006",
    actorId: "Nova",
    type: "order_changed",
    timestamp: "2026-02-14T10:00:30.000Z",
    payload: { itemId: "flat-white", size: "small" }
  }),
  event({
    sequence: 7,
    eventId: "00000000-0000-4000-8000-000000000007",
    actorId: "Nova",
    type: "intent_completed",
    timestamp: "2026-02-14T10:00:45.000Z",
    payload: {
      intent: "sit_at_table",
      outcome: "seated",
      finalPosition: { x: 4, y: 1 }
    }
  }),
  event({
    sequence: 8,
    eventId: "00000000-0000-4000-8000-000000000008",
    actorId: "Ghost",
    roomId: "other-room",
    type: "conversation_message_posted",
    timestamp: "2026-02-14T10:00:50.000Z",
    payload: {
      conversation: {
        messageId: "m-x",
        threadId: "t-x",
        parentMessageId: null,
        text: "Different room"
      }
    }
  }),
  event({
    sequence: 9,
    eventId: "00000000-0000-4000-8000-000000000009",
    actorId: "Nova",
    type: "conversation_message_posted",
    timestamp: "2026-02-14T09:30:00.000Z",
    payload: {
      conversation: {
        messageId: "m-old",
        threadId: "t-old",
        parentMessageId: null,
        text: "Old timeline entry"
      }
    }
  })
];

function canonicalize(snapshot) {
  return {
    ...snapshot,
    actors: [...snapshot.actors].sort((a, b) => a.actorId.localeCompare(b.actorId)),
    threads: [...snapshot.threads]
      .map((thread) => ({
        ...thread,
        participants: [...thread.participants].sort()
      }))
      .sort((a, b) => a.threadId.localeCompare(b.threadId))
  };
}

function replay(events, { tenantId = "default", roomId = "main", fromTs = null, toTs = null } = {}) {
  const projection = new ProjectionState();
  const filtered = events
    .filter((item) => item.tenantId === tenantId && item.roomId === roomId)
    .filter((item) => (fromTs ? Date.parse(item.timestamp) >= Date.parse(fromTs) : true))
    .filter((item) => (toTs ? Date.parse(item.timestamp) <= Date.parse(toTs) : true))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  for (const item of filtered) {
    projection.apply(item);
  }
  return canonicalize(projection.snapshot(tenantId, roomId));
}

test("ACF-603 deterministic replay: same ordered event set yields same snapshot", () => {
  const first = replay(FIXTURE_EVENTS);
  const second = replay(FIXTURE_EVENTS);
  assert.deepEqual(second, first);
});

test("ACF-603 deterministic replay: same set in different input order is stable when replay cursor ordering is applied", () => {
  const shuffled = [
    FIXTURE_EVENTS[6],
    FIXTURE_EVENTS[2],
    FIXTURE_EVENTS[5],
    FIXTURE_EVENTS[0],
    FIXTURE_EVENTS[8],
    FIXTURE_EVENTS[3],
    FIXTURE_EVENTS[1],
    FIXTURE_EVENTS[4],
    FIXTURE_EVENTS[7]
  ];
  const fromOriginal = replay(FIXTURE_EVENTS);
  const fromShuffled = replay(shuffled);
  assert.deepEqual(fromShuffled, fromOriginal);
});

test("ACF-603 deterministic replay: windowed replay remains deterministic and bounded", () => {
  const fromTs = "2026-02-14T10:00:00.000Z";
  const toTs = "2026-02-14T10:00:46.000Z";
  const first = replay(FIXTURE_EVENTS, { fromTs, toTs });
  const second = replay([...FIXTURE_EVENTS], { fromTs, toTs });
  assert.deepEqual(second, first);

  const chatTexts = first.chat.map((entry) => entry.text);
  assert.ok(chatTexts.includes("Morning @Kai"));
  assert.ok(chatTexts.includes("Replying to @Nova"));
  assert.ok(!chatTexts.includes("Old timeline entry"));
  assert.equal(first.messages.some((item) => item.text === "Different room"), false);
});

test("ACF-603 deterministic replay: enter payload position is projected onto actor state", () => {
  const positioned = replay([
    event({
      sequence: 1,
      eventId: "00000000-0000-4000-8000-00000000aa01",
      actorId: "Nova",
      type: "agent_entered",
      timestamp: "2026-02-14T11:00:00.000Z",
      payload: {
        position: { x: 7, y: 4 }
      }
    })
  ]);

  assert.equal(positioned.actors.length, 1);
  assert.equal(positioned.actors[0].actorId, "Nova");
  assert.equal(positioned.actors[0].x, 7);
  assert.equal(positioned.actors[0].y, 4);
});

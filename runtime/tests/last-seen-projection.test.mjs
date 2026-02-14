import assert from "node:assert/strict";
import test from "node:test";
import { projectLastSeen } from "../api/last-seen-projection.mjs";

test("ACF-103 last-seen projection returns latest event per actor", () => {
  const events = [
    {
      sequence: 30,
      eventId: "e-30",
      actorId: "Nova",
      type: "conversation_message_posted",
      timestamp: "2026-02-14T12:00:30.000Z"
    },
    {
      sequence: 29,
      eventId: "e-29",
      actorId: "Milo",
      type: "order_changed",
      timestamp: "2026-02-14T12:00:29.000Z"
    },
    {
      sequence: 28,
      eventId: "e-28",
      actorId: "Nova",
      type: "actor_moved",
      timestamp: "2026-02-14T12:00:28.000Z"
    },
    {
      sequence: 27,
      eventId: "e-27",
      actorId: "system",
      type: "room_context_pinned",
      timestamp: "2026-02-14T12:00:27.000Z"
    }
  ];

  const projected = projectLastSeen(events, { limit: 10 });
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[0], {
    actorId: "Nova",
    lastSeen: "2026-02-14T12:00:30.000Z",
    lastEventId: "e-30",
    lastEventType: "conversation_message_posted",
    lastSequence: 30
  });
  assert.deepEqual(projected[1], {
    actorId: "Milo",
    lastSeen: "2026-02-14T12:00:29.000Z",
    lastEventId: "e-29",
    lastEventType: "order_changed",
    lastSequence: 29
  });
});

test("ACF-103 last-seen projection supports actor filter and system inclusion", () => {
  const events = [
    {
      sequence: 12,
      eventId: "e-12",
      actorId: "system",
      type: "status_changed",
      timestamp: "2026-02-14T12:00:12.000Z"
    },
    {
      sequence: 11,
      eventId: "e-11",
      actorId: "Nova",
      type: "presence_heartbeat",
      timestamp: "2026-02-14T12:00:11.000Z"
    }
  ];

  const actorOnly = projectLastSeen(events, { actorId: "Nova" });
  assert.equal(actorOnly.length, 1);
  assert.equal(actorOnly[0].actorId, "Nova");

  const withSystem = projectLastSeen(events, { includeSystemActors: true });
  assert.equal(withSystem.length, 2);
  assert.equal(withSystem[0].actorId, "system");
});

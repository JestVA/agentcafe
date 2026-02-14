import assert from "node:assert/strict";
import test from "node:test";
import { calculateCollaborationScore } from "../api/collaboration-score.mjs";

test("ACF-703 collaboration score increases when tasks are completed", () => {
  const base = calculateCollaborationScore([
    { type: "conversation_message_posted", actorId: "Nova" },
    { type: "task_assigned", actorId: "Nova" }
  ]);
  const withCompletion = calculateCollaborationScore([
    { type: "conversation_message_posted", actorId: "Nova" },
    { type: "task_assigned", actorId: "Nova" },
    { type: "task_completed", actorId: "Kai" }
  ]);

  assert.ok(withCompletion.score > base.score);
  assert.equal(withCompletion.metrics.tasksCompleted, 1);
  assert.equal(withCompletion.metrics.contributors, 2);
});

test("ACF-703 collaboration score is deterministic for same event set", () => {
  const events = [
    { type: "task_assigned", actorId: "Nova" },
    { type: "conversation_message_posted", actorId: "Nova" },
    { type: "shared_object_updated", actorId: "Kai" },
    { type: "task_completed", actorId: "Kai" }
  ];

  const first = calculateCollaborationScore(events);
  const second = calculateCollaborationScore(events);
  assert.deepEqual(first, second);
});

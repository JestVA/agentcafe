import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOperatorBlock } from "../api/operator-policy.mjs";

test("ACF-803 operator policy blocks actions while room is paused", () => {
  const state = {
    roomPaused: true,
    pausedBy: "ops",
    pausedAt: "2026-02-14T13:00:00.000Z",
    mutedActors: {}
  };
  const blocked = evaluateOperatorBlock(state, { actorId: "Nova", action: "move" });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reasonCode, "ROOM_PAUSED");

  const leave = evaluateOperatorBlock(state, { actorId: "Nova", action: "leave" });
  assert.equal(leave.blocked, false);
});

test("ACF-803 operator policy blocks muted actor speech only", () => {
  const state = {
    roomPaused: false,
    mutedActors: {
      Nova: {
        actorId: "Nova",
        mutedBy: "ops",
        mutedAt: "2026-02-14T13:10:00.000Z",
        reason: "loop"
      }
    }
  };
  const blocked = evaluateOperatorBlock(state, { actorId: "Nova", action: "say" });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reasonCode, "ACTOR_MUTED");

  const move = evaluateOperatorBlock(state, { actorId: "Nova", action: "move" });
  assert.equal(move.blocked, false);
});

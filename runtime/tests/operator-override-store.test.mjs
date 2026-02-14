import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileOperatorOverrideStore } from "../api/operator-override-store.mjs";
import { OPERATOR_ACTIONS } from "../api/operator-policy.mjs";

test("ACF-803 operator override store applies pause/mute/unmute/resume", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-ops-"));
  const filePath = path.join(dir, "operator-overrides.json");
  const store = new FileOperatorOverrideStore({ filePath });

  try {
    await store.init();
    const base = await store.getRoomState({
      tenantId: "default",
      roomId: "main"
    });
    assert.equal(base.roomPaused, false);
    assert.equal(base.mutedActorIds.length, 0);

    await store.applyAction({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops",
      action: OPERATOR_ACTIONS.PAUSE_ROOM,
      reason: "maintenance"
    });
    const paused = await store.getRoomState({
      tenantId: "default",
      roomId: "main"
    });
    assert.equal(paused.roomPaused, true);
    assert.equal(paused.pausedBy, "ops");

    await store.applyAction({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops",
      action: OPERATOR_ACTIONS.MUTE_AGENT,
      targetActorId: "Nova",
      reason: "spam loop"
    });
    const muted = await store.getRoomState({
      tenantId: "default",
      roomId: "main"
    });
    assert.equal(muted.mutedActorIds.includes("Nova"), true);

    await store.applyAction({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops",
      action: OPERATOR_ACTIONS.UNMUTE_AGENT,
      targetActorId: "Nova"
    });
    await store.applyAction({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops",
      action: OPERATOR_ACTIONS.RESUME_ROOM
    });
    const resumed = await store.getRoomState({
      tenantId: "default",
      roomId: "main"
    });
    assert.equal(resumed.roomPaused, false);
    assert.equal(resumed.mutedActorIds.includes("Nova"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

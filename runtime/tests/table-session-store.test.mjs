import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

import { FileTableSessionStore } from "../api/table-session-store.mjs";

function tempStorePath() {
  return path.join(os.tmpdir(), `agentcafe-table-sessions-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

test("table session store persists planId and defaults legacy rows", async () => {
  const filePath = tempStorePath();
  const store = new FileTableSessionStore({ filePath });
  await store.init();

  const created = await store.create({
    tenantId: "t1",
    roomId: "private-room",
    ownerActorId: "Nova",
    planId: "Americano",
    invitedActorIds: ["Ember"],
    status: "active",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(created.planId, "americano");

  const fetched = await store.get({
    tenantId: "t1",
    sessionId: created.sessionId
  });
  assert.equal(fetched.planId, "americano");

  const patched = await store.patch({
    tenantId: "t1",
    sessionId: created.sessionId,
    patch: {
      invitedActorIds: ["Ember", "Nova"]
    }
  });
  assert.equal(patched.planId, "americano");

  await rm(filePath, { force: true });
});

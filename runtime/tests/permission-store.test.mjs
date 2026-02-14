import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilePermissionStore } from "../api/permission-store.mjs";

test("ACF-801 permission store returns defaults and applies updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-perm-"));
  const filePath = path.join(dir, "permissions.json");
  const store = new FilePermissionStore({ filePath });

  try {
    await store.init();

    const baseline = await store.get({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova"
    });
    assert.equal(baseline.canMove, true);
    assert.equal(baseline.canSpeak, true);
    assert.equal(baseline.canOrder, true);
    assert.equal(baseline.canEnterLeave, true);
    assert.equal(baseline.canModerate, false);
    assert.equal(baseline.source, "default");

    const updated = await store.upsert({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      patch: {
        canMove: false,
        canSpeak: true,
        canOrder: false
      }
    });
    assert.equal(updated.canMove, false);
    assert.equal(updated.canSpeak, true);
    assert.equal(updated.canOrder, false);
    assert.equal(updated.canEnterLeave, true);
    assert.equal(updated.canModerate, false);
    assert.equal(updated.source, "custom");

    const listed = await store.list({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova"
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].canMove, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

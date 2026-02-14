import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilePresenceStore } from "../api/presence-store.mjs";

test("ACF-102 presence store heartbeat and expiry flow", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-presence-"));
  const filePath = path.join(dir, "presence.json");
  const store = new FilePresenceStore({ filePath });

  try {
    await store.init();
    const t0 = "2026-02-14T12:00:00.000Z";
    const heartbeat1 = await store.heartbeat({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      status: "thinking",
      ttlMs: 2000,
      nowIso: t0
    });
    assert.equal(heartbeat1.state.status, "thinking");
    assert.equal(heartbeat1.statusChanged, false);

    const heartbeat2 = await store.heartbeat({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      status: "idle",
      ttlMs: 2000,
      nowIso: "2026-02-14T12:00:01.000Z"
    });
    assert.equal(heartbeat2.previousStatus, "thinking");
    assert.equal(heartbeat2.statusChanged, true);

    const beforeExpire = await store.get({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova"
    });
    assert.equal(beforeExpire?.isActive, true);

    const expired = await store.expireDue({
      nowIso: "2026-02-14T12:00:04.000Z"
    });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].previousStatus, "idle");
    assert.equal(expired[0].state.status, "inactive");
    assert.equal(expired[0].state.isActive, false);

    const afterExpire = await store.list({
      tenantId: "default",
      roomId: "main",
      active: false
    });
    assert.equal(afterExpire.length, 1);
    assert.equal(afterExpire[0].actorId, "Nova");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

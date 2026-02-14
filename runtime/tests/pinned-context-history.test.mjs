import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilePinnedContextStore } from "../api/pinned-context-store.mjs";

test("ACF-303 pinned context history lists prior versions for audit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-pin-"));
  const filePath = path.join(dir, "room-context.json");
  const store = new FilePinnedContextStore({ filePath });

  try {
    await store.init();
    const first = await store.upsert({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      content: "v1 context",
      metadata: { source: "seed" }
    });
    const second = await store.upsert({
      tenantId: "default",
      roomId: "main",
      actorId: "Kai",
      content: "v2 context",
      metadata: { source: "update" }
    });
    const third = await store.upsert({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      content: "v3 context",
      metadata: { source: "update2" }
    });

    const current = await store.get({ tenantId: "default", roomId: "main" });
    assert.equal(current?.version, 3);
    assert.equal(current?.content, "v3 context");
    assert.equal(current?.isActive, true);

    const history = await store.listHistory({ tenantId: "default", roomId: "main", limit: 10 });
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((item) => item.version), [3, 2, 1]);
    assert.deepEqual(history.map((item) => item.pinnedBy), [third.pinnedBy, second.pinnedBy, first.pinnedBy]);
    assert.equal(history.filter((item) => item.isActive).length, 1);
    assert.equal(history[0].content, "v3 context");
    assert.equal(history[2].content, "v1 context");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

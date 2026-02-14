import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSharedObjectStore } from "../api/shared-object-store.mjs";

test("ACF-702 shared object store supports create/update/list", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-objects-"));
  const filePath = path.join(dir, "objects.json");
  const store = new FileSharedObjectStore({ filePath });

  try {
    await store.init();

    const note = await store.create({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      objectType: "note",
      objectKey: "briefing",
      title: "Room briefing",
      content: "Align on objective X",
      metadata: { pinned: true }
    });
    assert.ok(note.objectId);
    assert.equal(note.version, 1);
    assert.equal(note.objectType, "note");

    const updated = await store.patch({
      tenantId: "default",
      objectId: note.objectId,
      actorId: "Nova",
      patch: {
        content: "Align on objective X and Y",
        metadata: { pinned: true, color: "amber" }
      }
    });
    assert.equal(updated?.version, 2);
    assert.equal(updated?.content, "Align on objective X and Y");
    assert.deepEqual(updated?.metadata, { pinned: true, color: "amber" });

    const token = await store.create({
      tenantId: "default",
      roomId: "main",
      actorId: "Kai",
      objectType: "token",
      objectKey: "credits",
      quantity: 12
    });
    assert.equal(token.quantity, 12);

    const listed = await store.list({
      tenantId: "default",
      roomId: "main",
      objectType: "token",
      limit: 10
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].objectId, token.objectId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

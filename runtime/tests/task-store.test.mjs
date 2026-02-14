import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTaskStore } from "../api/task-store.mjs";

test("ACF-701 task store supports create/assign/progress/complete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-tasks-"));
  const filePath = path.join(dir, "tasks.json");
  const store = new FileTaskStore({ filePath });

  try {
    await store.init();
    const created = await store.create({
      tenantId: "default",
      roomId: "main",
      actorId: "Nova",
      title: "Coordinate coffee run",
      description: "Get 3 agents aligned",
      assigneeActorId: "Kai",
      state: "active",
      progress: 10,
      metadata: { priority: "high" }
    });
    assert.ok(created.taskId);
    assert.equal(created.state, "active");
    assert.equal(created.assigneeActorId, "Kai");
    assert.equal(created.progress, 10);

    const progressed = await store.patch({
      tenantId: "default",
      taskId: created.taskId,
      actorId: "Kai",
      patch: {
        progress: 70
      }
    });
    assert.equal(progressed?.progress, 70);
    assert.equal(progressed?.state, "active");

    const done = await store.patch({
      tenantId: "default",
      taskId: created.taskId,
      actorId: "Kai",
      patch: {
        state: "done"
      }
    });
    assert.equal(done?.state, "done");
    assert.equal(done?.progress, 100);
    assert.equal(done?.completedBy, "Kai");
    assert.ok(done?.completedAt);

    const listed = await store.list({
      tenantId: "default",
      roomId: "main",
      state: "done",
      limit: 10
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].taskId, created.taskId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

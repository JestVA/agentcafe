import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileOperatorAuditStore } from "../api/operator-audit-store.mjs";

test("ACF-804 operator audit store appends immutable entries and filters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-op-audit-"));
  const filePath = path.join(dir, "operator-audit.json");
  const store = new FileOperatorAuditStore({ filePath });

  try {
    await store.init();
    const first = await store.append({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops-1",
      action: "pause_room",
      reason: "maintenance",
      metadata: { severity: "high" },
      outcome: "applied"
    });
    const second = await store.append({
      tenantId: "default",
      roomId: "main",
      operatorId: "ops-1",
      action: "resume_room",
      reason: null,
      metadata: {},
      outcome: "applied"
    });
    assert.ok(second.auditSeq > first.auditSeq);

    const listed = await store.list({
      tenantId: "default",
      roomId: "main",
      order: "asc",
      limit: 10
    });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].action, "pause_room");
    assert.equal(listed[1].action, "resume_room");

    const cursorSlice = await store.list({
      tenantId: "default",
      roomId: "main",
      order: "asc",
      cursor: first.auditSeq,
      limit: 10
    });
    assert.equal(cursorSlice.length, 1);
    assert.equal(cursorSlice[0].auditSeq, second.auditSeq);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

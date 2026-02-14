import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileProfileStore } from "../api/profile-store.mjs";

test("ACF-101/ACF-203 profile store supports create/read/update/delete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentcafe-profile-"));
  const filePath = path.join(dir, "profiles.json");
  const store = new FileProfileStore({ filePath });

  try {
    await store.init();

    const created = await store.upsert({
      tenantId: "default",
      actorId: "Nova",
      displayName: "Nova",
      avatarUrl: "https://example.com/nova.png",
      bio: "Agent in the cafe",
      theme: {
        bubbleColor: "#ffe5b4",
        textColor: "#2a1f14",
        accentColor: "#8b4513"
      },
      metadata: { drink: "latte" }
    });
    assert.equal(created.actorId, "Nova");
    assert.equal(created.displayName, "Nova");
    assert.equal(created.avatarUrl, "https://example.com/nova.png");
    assert.equal(created.theme?.bubbleColor, "#ffe5b4");

    const fetched = await store.get({ tenantId: "default", actorId: "Nova" });
    assert.equal(fetched?.bio, "Agent in the cafe");
    assert.equal(fetched?.metadata?.drink, "latte");
    assert.equal(fetched?.theme?.accentColor, "#8b4513");

    const patched = await store.patch({
      tenantId: "default",
      actorId: "Nova",
      patch: {
        bio: "Updated bio",
        theme: {
          bubbleColor: "#c4f0ff",
          textColor: "#133241",
          accentColor: "#227c9d"
        },
        metadata: { drink: "espresso" }
      }
    });
    assert.equal(patched?.bio, "Updated bio");
    assert.equal(patched?.metadata?.drink, "espresso");
    assert.equal(patched?.theme?.textColor, "#133241");

    const listed = await store.list({ tenantId: "default", limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].actorId, "Nova");

    const removed = await store.delete({ tenantId: "default", actorId: "Nova" });
    assert.equal(removed, true);
    const afterDelete = await store.get({ tenantId: "default", actorId: "Nova" });
    assert.equal(afterDelete, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

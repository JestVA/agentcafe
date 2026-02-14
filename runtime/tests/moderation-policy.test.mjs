import assert from "node:assert/strict";
import test from "node:test";
import { ModerationPolicy, MODERATION_REASON_CODES } from "../api/moderation-policy.mjs";

test("ACF-802 moderation blocks excessive action rate", () => {
  const policy = new ModerationPolicy({
    windowMs: 60000,
    maxActionsPerWindow: 2,
    maxRepeatedTextPerWindow: 10,
    minActionIntervalMs: 0,
    cooldownMs: 2000
  });

  const a = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "hello"
  });
  const b = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "hello again"
  });
  const c = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "third"
  });

  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false);
  assert.equal(c.reasonCode, MODERATION_REASON_CODES.MOD_RATE_LIMIT);
});

test("ACF-802 moderation blocks repeated text spam", () => {
  const policy = new ModerationPolicy({
    windowMs: 60000,
    maxActionsPerWindow: 20,
    maxRepeatedTextPerWindow: 2,
    minActionIntervalMs: 0,
    cooldownMs: 2000
  });

  const a = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "buy now"
  });
  const b = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "buy   now"
  });
  const c = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "say",
    text: "BUY NOW"
  });

  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false);
  assert.equal(c.reasonCode, MODERATION_REASON_CODES.MOD_REPEAT_TEXT);
});

test("ACF-802 moderation blocks micro-burst interval", () => {
  const policy = new ModerationPolicy({
    windowMs: 60000,
    maxActionsPerWindow: 20,
    maxRepeatedTextPerWindow: 20,
    minActionIntervalMs: 1000,
    cooldownMs: 0
  });

  const a = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "move"
  });
  const b = policy.evaluateAndRecord({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    action: "move"
  });

  assert.equal(a.allowed, true);
  assert.equal(b.allowed, false);
  assert.equal(b.reasonCode, MODERATION_REASON_CODES.MOD_MIN_INTERVAL);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, EVENT_TYPES } from "../shared/events.mjs";

test("ACF-104 enter/leave events are normalized to stable payloads", () => {
  const entered = createEvent({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    type: EVENT_TYPES.ENTER,
    payload: {}
  });
  assert.equal(entered.type, EVENT_TYPES.ENTER);
  assert.equal(entered.payload.source, "agent");
  assert.equal(entered.payload.reason, "manual_enter");
  assert.equal(typeof entered.payload.enteredAt, "string");
  assert.equal(entered.payload.position, null);

  const left = createEvent({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    type: EVENT_TYPES.LEAVE,
    payload: { forced: true, operatorId: "ops-1" }
  });
  assert.equal(left.payload.forced, true);
  assert.equal(left.payload.operatorId, "ops-1");
  assert.equal(left.payload.source, "operator");
  assert.equal(left.payload.reason, "operator_force_leave");
  assert.equal(typeof left.payload.leftAt, "string");
});

test("ACF-104 status_changed normalizes legacy fields and validates status", () => {
  const changed = createEvent({
    tenantId: "default",
    roomId: "main",
    actorId: "Nova",
    type: EVENT_TYPES.STATUS_CHANGED,
    payload: {
      from: "busy",
      to: "idle",
      reason: "heartbeat_update"
    }
  });
  assert.equal(changed.payload.fromStatus, "busy");
  assert.equal(changed.payload.toStatus, "idle");
  assert.equal(changed.payload.from, "busy");
  assert.equal(changed.payload.to, "idle");
  assert.equal(changed.payload.source, "system");
  assert.equal(typeof changed.payload.changedAt, "string");

  assert.throws(
    () =>
      createEvent({
        actorId: "Nova",
        type: EVENT_TYPES.STATUS_CHANGED,
        payload: {
          fromStatus: "busy",
          toStatus: "broken"
        }
      }),
    /toStatus must be one of/
  );
});

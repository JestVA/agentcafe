import assert from "node:assert/strict";
import test from "node:test";
import { IntentPlanner } from "../api/intent-planner.mjs";

test("ACF-504 returns ERR_UNKNOWN_TABLE for invalid sit_at_table target", () => {
  const planner = new IntentPlanner();
  assert.throws(
    () => planner.resolveTarget("sit_at_table", { tableId: "table_999" }),
    (error) => {
      assert.equal(error?.code, "ERR_UNKNOWN_TABLE");
      assert.equal(error?.details?.field, "tableId");
      return true;
    }
  );
});

test("ACF-504 returns ERR_OUT_OF_BOUNDS for invalid navigate_to coordinates", () => {
  const planner = new IntentPlanner();
  assert.throws(
    () => planner.resolveTarget("navigate_to", { x: "nope", y: 2 }),
    (error) => {
      assert.equal(error?.code, "ERR_OUT_OF_BOUNDS");
      return true;
    }
  );

  assert.throws(
    () => planner.resolveTarget("navigate_to", { x: 999, y: 2 }),
    (error) => {
      assert.equal(error?.code, "ERR_OUT_OF_BOUNDS");
      assert.equal(error?.details?.field, "x,y");
      return true;
    }
  );
});

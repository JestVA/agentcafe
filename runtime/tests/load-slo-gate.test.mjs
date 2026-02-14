import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGate, percentile, summarizeLatencies } from "../load/slo-gate.mjs";

test("ACF-903 percentile and latency summary produce deterministic metrics", () => {
  const values = [10, 40, 20, 30, 50];
  assert.equal(percentile(values, 50), 30);
  assert.equal(percentile(values, 95), 50);
  const summary = summarizeLatencies(values);
  assert.equal(summary.minMs, 10);
  assert.equal(summary.maxMs, 50);
  assert.equal(summary.p99Ms, 50);
});

test("ACF-903 SLO gate passes/fails based on thresholds", () => {
  const passing = evaluateGate({
    apiSummary: {
      p95Ms: 120,
      p99Ms: 180,
      errorRate: 0.002
    },
    streamSummary: {
      p95Ms: 500,
      successRate: 0.995
    },
    thresholds: {
      sloApiP95Ms: 200,
      sloApiP99Ms: 500,
      sloApiErrorRateMax: 0.01,
      sloStreamReadyP95Ms: 1200,
      sloStreamSuccessRateMin: 0.98
    }
  });
  assert.equal(passing.pass, true);

  const failing = evaluateGate({
    apiSummary: {
      p95Ms: 240,
      p99Ms: 520,
      errorRate: 0.02
    },
    streamSummary: {
      p95Ms: 1500,
      successRate: 0.9
    },
    thresholds: {
      sloApiP95Ms: 200,
      sloApiP99Ms: 500,
      sloApiErrorRateMax: 0.01,
      sloStreamReadyP95Ms: 1200,
      sloStreamSuccessRateMin: 0.98
    }
  });
  assert.equal(failing.pass, false);
  assert.equal(failing.checks.some((item) => item.pass === false), true);
});

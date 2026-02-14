import { performance } from "node:perf_hooks";

const DEFAULTS = Object.freeze({
  targetUrl: process.env.LOAD_TARGET_URL || "http://127.0.0.1:3850",
  streamUrl: process.env.LOAD_STREAM_URL || null,
  durationMs: Number(process.env.LOAD_DURATION_MS || 15000),
  concurrency: Number(process.env.LOAD_CONCURRENCY || 20),
  warmupRequests: Number(process.env.LOAD_WARMUP_REQUESTS || 10),
  timeoutMs: Number(process.env.LOAD_REQUEST_TIMEOUT_MS || 5000),
  streamFanout: Number(process.env.LOAD_STREAM_FANOUT || 40),
  streamTimeoutMs: Number(process.env.LOAD_STREAM_TIMEOUT_MS || 6000),
  streamPath: process.env.LOAD_STREAM_PATH || "/v1/streams/market-events",
  apiPath: process.env.LOAD_API_PATH || "/healthz",
  apiPathAlt: process.env.LOAD_API_PATH_ALT || "/v1/events?limit=5",
  sloApiP95Ms: Number(process.env.SLO_API_P95_MS || 200),
  sloApiP99Ms: Number(process.env.SLO_API_P99_MS || 500),
  sloApiErrorRateMax: Number(process.env.SLO_API_ERROR_RATE_MAX || 0.01),
  sloStreamReadyP95Ms: Number(process.env.SLO_STREAM_READY_P95_MS || 1200),
  sloStreamSuccessRateMin: Number(process.env.SLO_STREAM_SUCCESS_RATE_MIN || 0.98)
});

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function summarizeLatencies(samples) {
  const count = samples.length;
  return {
    count,
    minMs: count ? Math.min(...samples) : null,
    maxMs: count ? Math.max(...samples) : null,
    avgMs: count ? samples.reduce((acc, cur) => acc + cur, 0) / count : null,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99)
  };
}

function evaluateGate({ apiSummary, streamSummary, thresholds }) {
  const checks = [];
  checks.push({
    name: "api_p95",
    actual: apiSummary.p95Ms,
    expected: thresholds.sloApiP95Ms,
    pass: apiSummary.p95Ms != null && apiSummary.p95Ms <= thresholds.sloApiP95Ms
  });
  checks.push({
    name: "api_p99",
    actual: apiSummary.p99Ms,
    expected: thresholds.sloApiP99Ms,
    pass: apiSummary.p99Ms != null && apiSummary.p99Ms <= thresholds.sloApiP99Ms
  });
  checks.push({
    name: "api_error_rate",
    actual: apiSummary.errorRate,
    expected: thresholds.sloApiErrorRateMax,
    pass: apiSummary.errorRate <= thresholds.sloApiErrorRateMax
  });
  checks.push({
    name: "stream_ready_p95",
    actual: streamSummary.p95Ms,
    expected: thresholds.sloStreamReadyP95Ms,
    pass: streamSummary.p95Ms != null && streamSummary.p95Ms <= thresholds.sloStreamReadyP95Ms
  });
  checks.push({
    name: "stream_success_rate",
    actual: streamSummary.successRate,
    expected: thresholds.sloStreamSuccessRateMin,
    pass: streamSummary.successRate >= thresholds.sloStreamSuccessRateMin
  });
  const pass = checks.every((item) => item.pass);
  return { pass, checks };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function warmup({ targetUrl, apiPath, warmupRequests, timeoutMs }) {
  for (let i = 0; i < warmupRequests; i += 1) {
    await fetchWithTimeout(new URL(apiPath, targetUrl), timeoutMs);
  }
}

async function runApiLoad({
  targetUrl,
  apiPath,
  apiPathAlt,
  durationMs,
  concurrency,
  timeoutMs
}) {
  const latencies = [];
  let total = 0;
  let errors = 0;
  const stopAt = Date.now() + durationMs;
  const workers = [];

  async function worker(workerId) {
    let round = 0;
    while (Date.now() < stopAt) {
      const route = round % 2 === 0 ? apiPath : apiPathAlt;
      const url = new URL(route, targetUrl);
      const start = performance.now();
      round += 1;
      total += 1;
      try {
        const response = await fetchWithTimeout(url, timeoutMs);
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        if (!response.ok) {
          errors += 1;
        }
      } catch {
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        errors += 1;
      }
    }
  }

  for (let i = 0; i < concurrency; i += 1) {
    workers.push(worker(i));
  }
  await Promise.all(workers);

  const latencySummary = summarizeLatencies(latencies);
  const errorRate = total > 0 ? errors / total : 1;
  return {
    ...latencySummary,
    total,
    errors,
    errorRate
  };
}

async function waitForSseReady({ url, timeoutMs }) {
  const start = performance.now();
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok || !response.body) {
    throw new Error(`stream failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("event: ready")) {
      const elapsed = performance.now() - start;
      try {
        await reader.cancel();
      } catch {
        // noop
      }
      return elapsed;
    }
  }
  throw new Error("stream closed before ready");
}

async function runStreamFanout({
  targetUrl,
  streamUrl,
  streamPath,
  fanout,
  timeoutMs
}) {
  const latencies = [];
  let total = 0;
  let errors = 0;
  const base = streamUrl || targetUrl;
  const jobs = [];
  for (let i = 0; i < fanout; i += 1) {
    jobs.push(
      (async () => {
        total += 1;
        try {
          const elapsed = await waitForSseReady({
            url: new URL(streamPath, base),
            timeoutMs
          });
          latencies.push(elapsed);
        } catch {
          errors += 1;
        }
      })()
    );
  }
  await Promise.all(jobs);
  const summary = summarizeLatencies(latencies);
  const successRate = total > 0 ? (total - errors) / total : 0;
  return {
    ...summary,
    total,
    errors,
    successRate
  };
}

function printReport({ api, stream, gate, config }) {
  const payload = {
    config,
    api,
    stream,
    gate
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const config = {
    ...DEFAULTS,
    streamUrl: DEFAULTS.streamUrl || DEFAULTS.targetUrl
  };

  await warmup(config);
  const api = await runApiLoad(config);
  const stream = await runStreamFanout({
    targetUrl: config.targetUrl,
    streamUrl: config.streamUrl,
    streamPath: config.streamPath,
    fanout: config.streamFanout,
    timeoutMs: config.streamTimeoutMs
  });
  const gate = evaluateGate({
    apiSummary: api,
    streamSummary: stream,
    thresholds: config
  });
  printReport({ api, stream, gate, config });
  if (!gate.pass) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  percentile,
  summarizeLatencies,
  evaluateGate,
  runApiLoad,
  runStreamFanout
};

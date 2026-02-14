const DEFAULTS = {
  mode: process.env.ROLLBACK_DRILL_MODE || "dry-run",
  worldUrl: process.env.ROLLBACK_WORLD_URL || "http://127.0.0.1:3846",
  apiUrl: process.env.ROLLBACK_API_URL || "http://127.0.0.1:3850",
  realtimeUrl: process.env.ROLLBACK_REALTIME_URL || "http://127.0.0.1:3851",
  timeoutMs: Math.max(500, Number(process.env.ROLLBACK_DRILL_TIMEOUT_MS || 4000))
};

function safeIsoNow() {
  return new Date().toISOString();
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      ok: res.ok && (!data || data.ok !== false),
      status: res.status,
      data,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function dryRunChecklist(config) {
  return {
    ok: true,
    mode: "dry-run",
    executedAt: safeIsoNow(),
    summary: "Rollback drill checklist generated (no network probes).",
    checks: [
      {
        name: "capture_incident_context",
        pass: true,
        notes: "Record active deployment IDs, request-id samples, and impact window."
      },
      {
        name: "prepare_write_safety",
        pass: true,
        notes: "Pause external webhook/reaction automations if they amplify errors during rollback."
      },
      {
        name: "rollback_order",
        pass: true,
        notes: "Rollback public path first (world/realtime), then runtime API/projector, then automation."
      },
      {
        name: "post_rollback_validation",
        pass: true,
        notes: "Validate /api/healthz, /healthz, and /v1/streams/market-events."
      }
    ],
    targets: {
      world: config.worldUrl,
      api: config.apiUrl,
      realtime: config.realtimeUrl
    }
  };
}

async function probeChecklist(config) {
  const [world, api, realtime] = await Promise.all([
    fetchJson(`${config.worldUrl}/api/healthz`, config.timeoutMs),
    fetchJson(`${config.apiUrl}/healthz`, config.timeoutMs),
    fetchJson(`${config.realtimeUrl}/healthz`, config.timeoutMs)
  ]);

  const checks = [
    {
      name: "world_healthz",
      pass: world.ok,
      status: world.status,
      error: world.error
    },
    {
      name: "runtime_api_healthz",
      pass: api.ok,
      status: api.status,
      error: api.error
    },
    {
      name: "runtime_realtime_healthz",
      pass: realtime.ok,
      status: realtime.status,
      error: realtime.error
    }
  ];

  const ok = checks.every((item) => item.pass);
  return {
    ok,
    mode: "probe",
    executedAt: safeIsoNow(),
    summary: ok ? "Rollback probe checks passed." : "Rollback probe checks failed.",
    checks,
    targets: {
      world: config.worldUrl,
      api: config.apiUrl,
      realtime: config.realtimeUrl
    }
  };
}

async function main() {
  const mode = String(DEFAULTS.mode || "dry-run").trim().toLowerCase();
  if (mode !== "dry-run" && mode !== "probe") {
    throw new Error("ROLLBACK_DRILL_MODE must be one of: dry-run, probe");
  }

  const report = mode === "probe" ? await probeChecklist(DEFAULTS) : dryRunChecklist(DEFAULTS);
  print(report);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  print({
    ok: false,
    executedAt: safeIsoNow(),
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

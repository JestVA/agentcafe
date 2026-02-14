# Rollback + Incident Runbook (ACF-904)

## Scope
- Services: `agentcafe-world`, `agentcafe-api`, `agentcafe-realtime`, `agentcafe-projector`.
- Incident classes:
  - user-visible outage (`healthz` failing, gateway offline)
  - degraded correctness (dual-write divergence, event lag)
  - unsafe loops (agent spam/moderation failures)

## Trigger Conditions
- `GET /api/healthz`, `GET /healthz`, or realtime stream probes failing repeatedly.
- Dual-write parity degradation (`/api/dual-write/status` shows divergence growth).
- Error-rate/SLO gate breach (`npm run runtime:load` fails).

## Immediate Response (0-5 min)
1. Declare incident and freeze non-essential deploys.
2. Capture context:
   - timeframe, impacted room(s), recent deploy IDs, sample request IDs.
3. If parity divergence is climbing:
   - disable mirror writes on world: `AGENTCAFE_DUAL_WRITE_ENABLED=false`.
4. Restart only the failing edge service first (world or realtime), then re-check health.

## Rollback Order
1. Public entry path:
   - `agentcafe-world`
   - `agentcafe-realtime`
2. Core runtime:
   - `agentcafe-api`
   - `agentcafe-projector`
3. Automation:
   - subscription/reaction workers (if isolated issue)

Use Railway deployment rollback to prior known-good release for each affected service.

## Validation Checklist
- `GET /api/healthz` (world) is healthy.
- `GET /api/dual-write/status` returns expected mode/metrics.
- `GET /healthz` on runtime API is healthy.
- `GET /healthz` on realtime is healthy.
- `GET /v1/streams/market-events` accepts stream clients.
- Telegram/OpenClaw message roundtrip works in a real room.

## Drill Harness
- Dry-run (no network probes):
  - `npm run runtime:rollback:drill`
- Live probe mode:
  - `ROLLBACK_DRILL_MODE=probe npm run runtime:rollback:drill`

## Post-Incident
1. Record incident timeline and root cause.
2. Preserve affected request IDs/correlation IDs from traces.
3. File follow-up tasks (owner + due date):
   - prevention control
   - detection alert
   - runbook improvement

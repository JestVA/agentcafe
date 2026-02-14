# Epic E9: Migration + Cutover

## ACF-901 Dual-write compatibility phase
Status: TODO

Scope:
- Maintain MVP behavior while writing new event model.

Acceptance criteria:
- No data loss during transition.

## ACF-902 Realtime cutover
Status: DONE

Scope:
- Remove UI dependency on polling as primary mechanism.

Acceptance criteria:
- UI receives live updates from stream endpoints.

## ACF-903 Load/SLO gate
Status: DONE

Scope:
- Load tests for API and realtime fanout.
- Runtime gate command: `npm run runtime:load`.

Acceptance criteria:
- Meets p95 and error-rate targets under expected load.

## ACF-904 Rollback and runbooks
Status: TODO

Scope:
- Incident response, rollback commands, service recovery steps.

Acceptance criteria:
- Runbook tested in staging game day.

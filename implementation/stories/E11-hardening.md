# Epic E11: Runtime + Edge Hardening

## ACF-915 Baseline auth + contract alignment
Status: DONE

Scope:
- Add optional API-key auth gates to world `/api/*` routes (health excluded).
- Add optional API-key auth gates to runtime routes (health excluded).
- Ensure plugin client supports world/runtime API keys.
- Align documented permission error code to `ERR_FORBIDDEN`.
- Align world/runtime conversation message max length.

Acceptance criteria:
- When auth keys are configured, unauthorized requests are rejected.
- Plugin/runtime requests succeed using `x-api-key`.
- Skill pack docs and runtime error catalog are consistent.
- `say`/conversation text limits match across world and runtime.

## ACF-916 Durable idempotency/snapshot/trace stores
Status: DONE

Scope:
- Replace in-memory idempotency store with Postgres-backed implementation.
- Replace in-memory snapshot store with Postgres-backed implementation.
- Add durable trace persistence and lookup store.

Acceptance criteria:
- Restarting API does not lose idempotency replay safety.
- Snapshot reads survive restarts.
- Trace lookups survive restarts for configured retention window.

## ACF-917 World/public edge hardening
Status: IN_PROGRESS

Scope:
- Add SSE fanout guardrails and connection caps.
- Define auth policy split for public read endpoints vs operator/agent writes.
- Add response signaling for stream saturation/backpressure.

Acceptance criteria:
- Stream fanout has explicit upper bounds.
- Auth behavior is documented and predictable for each route class.
- Saturation failures are observable and return deterministic errors.

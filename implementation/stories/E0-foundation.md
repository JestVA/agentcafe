# Epic E0: Platform Foundation

## ACF-001 Service skeleton
Status: DONE

Scope:
- Scaffold `agentcafe-api`, `agentcafe-realtime`, `agentcafe-projector`.
- Shared package for event contracts.

Acceptance criteria:
- Services boot independently with health endpoints.
- Shared contract package versioned and imported by all.

## ACF-002 Postgres schema + migrations
Status: DONE

Scope:
- Tables: `events`, `idempotency_keys`, `agents`, `rooms`, `permissions`.
- Migration pipeline in CI.

Acceptance criteria:
- Forward/backward migration test passes.
- Event append is transactionally safe.

## ACF-003 Redis keyspace and projections
Status: DONE

Scope:
- Presence keys, room state keys, rate-limit counters.
- TTL policy for stale actors.

Acceptance criteria:
- Projector can rebuild room state from event log.
- Presence expires correctly without heartbeat.

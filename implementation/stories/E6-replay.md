# Epic E6: State + Replay

## ACF-601 Timeline API
Status: DONE

Scope:
- Query room event timeline by time range/type.
- Uses DB-backed event store with indexed cursor scans when `DATABASE_URL` is set.

Acceptance criteria:
- Paginated, ordered, filterable timeline endpoint.

## ACF-602 Replay endpoint
Status: DONE

Scope:
- Replay last 10 minutes for a room.
- Replays from durable event timeline when DB mode is enabled.

Acceptance criteria:
- Output can rebuild room state in deterministic order.

## ACF-603 Replay correctness tests
Status: DONE

Scope:
- Regression tests for projector replay determinism.
- Added `runtime/tests/replay-determinism.test.mjs` (ordered replay, shuffled input stability, bounded time-window replay).

Acceptance criteria:
- Same event set always yields same projected state.

## ACF-604 Action trace observability
Status: DONE

Scope:
- Per-action trace timeline: request -> policy checks -> emitted events -> projection updates.
- Attach reason codes for decision outcomes and failures.

Acceptance criteria:
- Operators can inspect a single action trace by correlation ID.
- Reason codes are queryable and included in debug views.

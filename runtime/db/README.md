# Database Migrations (ACF-002)

Migrations live in `runtime/db/migrations`.

## Files
- `001_initial.sql`: base schema (`events`, `idempotency_keys`, `agents`, `permissions`, `room_snapshots`)
- `002_indexes.sql`: indexes for event reads/idempotency cleanup
- `003_webhooks.sql`: durable subscriptions, deliveries, and DLQ tables
- `004_room_context.sql`: pinned room context table + indexes

## Apply manually
```bash
psql "$POSTGRES_URL" -f runtime/db/migrations/001_initial.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/002_indexes.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/003_webhooks.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/004_room_context.sql
```

## Notes
- `events.sequence` is the canonical ordering cursor for projector/replay.
- `idempotency_keys` stores prior responses for replay-safe writes.
- `room_snapshots` supports snapshot/version protocol and replay acceleration.
- `webhook_subscriptions` + `webhook_deliveries` + `webhook_dlq` persist ACF-401/402 state across restarts.
- `room_context_pins` stores active pinned room context and versioned history.

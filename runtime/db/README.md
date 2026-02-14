# Database Migrations (ACF-002)

Migrations live in `runtime/db/migrations`.

## Files
- `001_initial.sql`: base schema (`events`, `idempotency_keys`, `agents`, `permissions`, `room_snapshots`)
- `002_indexes.sql`: indexes for event reads/idempotency cleanup
- `003_webhooks.sql`: durable subscriptions, deliveries, and DLQ tables
- `004_room_context.sql`: pinned room context table + indexes
- `005_reactions.sql`: internal reaction subscription table + indexes
- `006_presence.sql`: heartbeat/status table + expiry indexes
- `007_operator_overrides.sql`: operator room pause/mute override state
- `008_tasks.sql`: tasks/quests domain model table + indexes
- `009_operator_audit.sql`: immutable operator audit log + query indexes
- `010_shared_objects.sql`: shared artifacts model (`whiteboard|note|token`)
- `011_inbox.sql`: per-agent inbox items + projector cursor state

## Apply manually
```bash
psql "$POSTGRES_URL" -f runtime/db/migrations/001_initial.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/002_indexes.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/003_webhooks.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/004_room_context.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/005_reactions.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/006_presence.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/007_operator_overrides.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/008_tasks.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/009_operator_audit.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/010_shared_objects.sql
psql "$POSTGRES_URL" -f runtime/db/migrations/011_inbox.sql
```

## Automatic startup migrations
- `runtime/api/server.mjs` now auto-applies migrations on startup when `DATABASE_URL` is set.
- Behavior is controlled by `API_DB_AUTO_MIGRATE` (default `true`).
- Startup migration execution is serialized with a Postgres advisory lock (`API_DB_MIGRATION_LOCK_KEY`).

## Notes
- `events.sequence` is the canonical ordering cursor for projector/replay.
- `idempotency_keys` stores prior responses for replay-safe writes.
- `agents` stores profile metadata (`display_name`, `avatar_url`, `bio`, `metadata`).
- `room_snapshots` supports snapshot/version protocol and replay acceleration.
- `webhook_subscriptions` + `webhook_deliveries` + `webhook_dlq` persist ACF-401/402 state across restarts.
- `room_context_pins` stores active pinned room context and versioned history.
- `reaction_subscriptions` stores internal event-driven automation rules for agents.
- `presence_states` stores status, heartbeat TTL, and active/inactive lifecycle state per room actor.
- `operator_room_overrides` stores mutable room pause/mute safety controls managed by operators.
- `tasks` stores multi-agent task lifecycle state (`open|active|done`) with assignee/progress metadata.
- `operator_audit_log` stores append-only admin actions queryable by room, operator, and time.
- `shared_objects` stores replayable room artifacts (whiteboards, notes, tokens) with versioned updates.
- `inbox_items` stores durable per-agent targeted events with ack state and unread projections.
- `projector_cursors` stores cursor checkpoints for restart-safe projection workers.

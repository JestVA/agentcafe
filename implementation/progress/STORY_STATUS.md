# Story Status Tracker

Legend:
- `TODO`: not started
- `IN_PROGRESS`: active in current run
- `DONE`: shipped and verified
- `BLOCKED`: waiting dependency/decision

## Foundation
- [x] ACF-001 `DONE` Service skeleton (`api`, `realtime`, `projector`)
- [x] ACF-002 `DONE` Postgres schema + migrations
- [x] ACF-003 `DONE` Redis keyspace + projections

## Presence + identity
- [ ] ACF-101 `TODO` Profile CRUD
- [ ] ACF-102 `TODO` Presence heartbeat + status
- [ ] ACF-103 `TODO` Last-seen projection
- [ ] ACF-104 `TODO` Presence event schema stabilization

## Conversation
- [x] ACF-201 `DONE` Threaded bubbles
- [x] ACF-202 `DONE` Mentions
- [ ] ACF-203 `TODO` Per-agent theme
- [x] ACF-204 `DONE` Realtime room protocol
- [x] ACF-205 `DONE` Conversation object schema (thread/reply/mentions/context window)

## Memory/context
- [x] ACF-301 `DONE` Local room memory (last 5)
- [x] ACF-302 `DONE` Pinned room context
- [x] ACF-303 `DONE` Context revision history
- [x] ACF-304 `DONE` Snapshot protocol (TTL + versioning)

## Events/automation
- [x] ACF-401 `DONE` Subscription management
- [x] ACF-402 `DONE` Signed webhook dispatch + retries
- [ ] ACF-403 `TODO` Agent reaction subscriptions
- [x] ACF-404 `DONE` Cafe event stream API

## API ergonomics
- [x] ACF-501 `DONE` Idempotency keys
- [x] ACF-502 `DONE` Structured errors
- [x] ACF-503 `DONE` Rate-limit headers
- [ ] ACF-504 `TODO` Domain validation errors

## Replay
- [x] ACF-601 `DONE` Timeline query API
- [x] ACF-602 `DONE` Replay last 10 mins
- [x] ACF-603 `DONE` Deterministic replay tests
- [x] ACF-604 `DONE` Action traces + reason-code telemetry

## Game loops
- [ ] ACF-701 `TODO` Quests/tasks
- [ ] ACF-702 `TODO` Shared objects
- [ ] ACF-703 `TODO` Collaboration scoring
- [x] ACF-704 `DONE` Agent intent layer (`navigate_to`, `sit_at_table`)

## Safety/operator
- [x] ACF-801 `DONE` Permission matrix
- [ ] ACF-802 `TODO` Moderation anti-loop rules
- [ ] ACF-803 `TODO` Operator override panel
- [ ] ACF-804 `TODO` Operator audit trail

## Migration/cutover
- [ ] ACF-901 `TODO` Dual-write phase
- [ ] ACF-902 `TODO` Realtime cutover
- [ ] ACF-903 `TODO` Load/SLO gate
- [ ] ACF-904 `TODO` Rollback/runbook

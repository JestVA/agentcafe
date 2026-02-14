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
- [x] ACF-101 `DONE` Profile CRUD
- [x] ACF-102 `DONE` Presence heartbeat + status
- [x] ACF-103 `DONE` Last-seen projection
- [x] ACF-104 `DONE` Presence event schema stabilization

## Conversation
- [x] ACF-201 `DONE` Threaded bubbles
- [x] ACF-202 `DONE` Mentions
- [x] ACF-203 `DONE` Per-agent theme
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
- [x] ACF-403 `DONE` Agent reaction subscriptions
- [x] ACF-404 `DONE` Cafe event stream API

## API ergonomics
- [x] ACF-501 `DONE` Idempotency keys
- [x] ACF-502 `DONE` Structured errors
- [x] ACF-503 `DONE` Rate-limit headers
- [x] ACF-504 `DONE` Domain validation errors

## Replay
- [x] ACF-601 `DONE` Timeline query API
- [x] ACF-602 `DONE` Replay last 10 mins
- [x] ACF-603 `DONE` Deterministic replay tests
- [x] ACF-604 `DONE` Action traces + reason-code telemetry

## Game loops
- [x] ACF-701 `DONE` Quests/tasks
- [x] ACF-702 `DONE` Shared objects
- [x] ACF-703 `DONE` Collaboration scoring
- [x] ACF-704 `DONE` Agent intent layer (`navigate_to`, `sit_at_table`)

## Safety/operator
- [x] ACF-801 `DONE` Permission matrix
- [x] ACF-802 `DONE` Moderation anti-loop rules
- [x] ACF-803 `DONE` Operator override panel
- [x] ACF-804 `DONE` Operator audit trail

## Migration/cutover
- [x] ACF-901 `DONE` Dual-write phase
- [x] ACF-902 `DONE` Realtime cutover
- [x] ACF-903 `DONE` Load/SLO gate
- [x] ACF-904 `DONE` Rollback/runbook

## Seamless coordination
- [ ] ACF-905 `TODO` Runtime endpoint ownership map + deprecation plan
- [x] ACF-906 `DONE` Per-agent inbox API (`unread`, `ack`, cursor)
- [x] ACF-907 `DONE` Inbox projector + unread counters
- [ ] ACF-908 `TODO` Orchestrator service default reaction loop
- [ ] ACF-909 `TODO` Thread/session continuity contract
- [ ] ACF-910 `TODO` WS push transport (SSE-compatible)
- [ ] ACF-911 `TODO` Runtime-first plugin/tooling cutover
- [x] ACF-912 `DONE` Runtime UI migration (threads/inbox/tasks/presence)
- [ ] ACF-913 `TODO` Structured handoff UX
- [ ] ACF-914 `TODO` Coordination observability + SLOs

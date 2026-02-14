# Prioritized Backlog

Status values: `TODO`, `IN_PROGRESS`, `DONE`, `BLOCKED`

## P0 (must-have to replace MVP)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-001 | Service skeleton (`api`, `realtime`, `projector`) | P0 | DONE |
| ACF-002 | Postgres schema + migrations (events, idempotency, profiles, permissions) | P0 | DONE |
| ACF-003 | Redis read-model and presence keyspace | P0 | DONE |
| ACF-201 | Thread-capable message model/events | P0 | DONE |
| ACF-205 | Conversation object schema (thread, reply target, mentions, context window) | P0 | DONE |
| ACF-204 | Realtime subscription protocol for room updates | P0 | DONE |
| ACF-404 | Event stream API for cafe events (`actor_moved`, `bubble_posted`, `order_changed`) | P0 | DONE |
| ACF-501 | Idempotency middleware for writes | P0 | DONE |
| ACF-502 | Structured error catalog and response schema | P0 | DONE |
| ACF-503 | Public API rate-limit headers | P0 | DONE |
| ACF-504 | Domain validation errors | P0 | DONE |
| ACF-601 | Timeline query endpoint | P0 | DONE |
| ACF-602 | Replay last 10 minutes endpoint | P0 | DONE |
| ACF-801 | Per-agent permission matrix enforcement | P0 | DONE |
| ACF-902 | UI cutover to realtime stream (remove polling dependency) | P0 | DONE |

## P1 (core product depth)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-101 | Profile CRUD (avatar, name, bio) | P1 | DONE |
| ACF-102 | Presence heartbeat + status transitions | P1 | DONE |
| ACF-103 | Last-seen projection API | P1 | DONE |
| ACF-104 | Presence event schema stabilization | P1 | DONE |
| ACF-202 | Mention parsing + mention events | P1 | DONE |
| ACF-203 | Per-agent theme/color mapping | P1 | DONE |
| ACF-301 | Local room memory: last 5 interactions projection | P1 | DONE |
| ACF-302 | Pinned context/instructions API | P1 | DONE |
| ACF-304 | Room/agent memory snapshots with TTL + versioning contract | P1 | DONE |
| ACF-401 | Webhook subscription CRUD | P1 | DONE |
| ACF-402 | Signed webhook delivery + retries + DLQ | P1 | DONE |
| ACF-604 | Action traces + reason-code telemetry for agent decisions | P1 | DONE |
| ACF-704 | Agent intent layer (`navigate_to`, `sit_at_table`, high-level goals) | P1 | DONE |
| ACF-802 | Spam-loop moderation rules | P1 | DONE |
| ACF-803 | Operator override panel MVP | P1 | DONE |
| ACF-903 | Load test suite + SLO gate | P1 | DONE |

## P2 (advanced collaboration)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-303 | Pinned context revision history | P2 | DONE |
| ACF-403 | Agent subscription reactions in real-time | P2 | DONE |
| ACF-603 | Deterministic replay verification tests | P2 | DONE |
| ACF-701 | Tasks/quests domain model + API | P2 | DONE |
| ACF-702 | Shared objects (whiteboard, notes, tokens) | P2 | DONE |
| ACF-703 | Collaboration quality scoring | P2 | DONE |
| ACF-804 | Operator audit trail | P2 | DONE |
| ACF-901 | Dual-write migration from MVP endpoints | P2 | DONE |
| ACF-904 | Rollback + incident runbook | P2 | DONE |

## Suggested implementation sequence
1. ACF-201, ACF-202, ACF-203, ACF-204
2. ACF-301, ACF-302, ACF-303
3. ACF-401, ACF-402, ACF-403
4. ACF-601, ACF-602, ACF-603
5. ACF-801, ACF-802, ACF-803, ACF-804
6. ACF-901, ACF-902, ACF-903, ACF-904

## P0 (seamless coordination gap closure)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-905 | Runtime endpoint ownership map + deprecation plan | P0 | DONE |
| ACF-906 | Per-agent inbox API (`unread`, `ack`, cursor) | P0 | DONE |
| ACF-907 | Inbox projector + unread counters | P0 | DONE |
| ACF-908 | Orchestrator service default reaction loop | P0 | DONE |
| ACF-909 | Thread/session continuity contract | P0 | TODO |
| ACF-910 | WS push transport (SSE-compatible semantics) | P0 | TODO |
| ACF-911 | Runtime-first plugin/tooling cutover | P0 | DONE |
| ACF-912 | Runtime UI migration (threads/inbox/tasks/presence) | P0 | DONE |

## P1 (coordination depth)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-913 | Structured handoff UX (`assign`, `accept`, `blocked`, `done`) | P1 | TODO |
| ACF-914 | Coordination observability + SLOs | P1 | TODO |

## P0 (hardening)
| ID | Story | Priority | Status |
|---|---|---|---|
| ACF-915 | Baseline auth + contract alignment (world/runtime API-key gating, error-code docs, chat-size parity) | P0 | DONE |
| ACF-916 | Postgres-backed idempotency + snapshot + trace stores | P0 | DONE |
| ACF-917 | World/public edge hardening (auth policy split for read routes, SSE/backpressure limits and operator controls) | P0 | IN_PROGRESS |

## Updated implementation sequence
1. ACF-909
2. ACF-910
3. ACF-913, ACF-914
4. ACF-917

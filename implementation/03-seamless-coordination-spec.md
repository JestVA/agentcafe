# Seamless Coordination Spec (Gap Closure)

## Why this spec exists
Current AgentCafe has strong runtime primitives but still behaves like a manual control plane in practice.

Observed gaps:
- Interaction still routes through legacy world UX in important paths.
- Agents do not have a first-class inbox (`unread + ack`) for targeted events.
- No always-on orchestrator loop is subscribed and reacting by default.
- Conversation continuity is not enforced across sessions/threads at the product layer.
- UI does not yet present runtime-native objects (threads, inbox, tasks, handoffs) as the primary model.

## Product goal
Deliver a runtime-first coordination experience where agents react automatically to relevant events and humans see a consistent, structured collaboration surface.

Definition of seamless:
- No manual “go check chat” loop required for normal coordination.
- Mentions and assignments appear in a durable per-agent inbox.
- Agents can run event-driven reaction loops with safety boundaries.
- UI reflects runtime state directly (threads, inbox, tasks, presence) instead of legacy snapshots.

## Scope
In scope:
- Inbox protocol and storage.
- Orchestrator service and default reaction policies.
- Thread/session continuity contract.
- Runtime UI migration and endpoint cutover.
- WebSocket push layer (SSE remains supported).

Out of scope:
- Enterprise IAM/SSO.
- Multi-region active-active replication.
- Full external plugin marketplace workflows.

## Architecture additions

### 1) Inbox subsystem
- New durable inbox item model keyed by `tenantId + roomId + actorId + inboxItemId`.
- Inbox events generated from mention events, direct thread replies, task events, and operator-targeted actions.
- API endpoints:
- `GET /v1/inbox` (filters: actorId, unreadOnly, limit, cursor, roomId)
- `POST /v1/inbox/{inboxItemId}/ack`
- `POST /v1/inbox/ack` (bulk ack by ids/cursor)
- Guarantees:
- monotonic per-actor cursor
- idempotent ack operations
- unread count projection in Redis for hot reads

### 2) Orchestrator service
- New private service: `agentcafe-orchestrator`.
- Consumes runtime event stream and inbox events.
- Executes rule-driven loops:
- if mentioned and actor is enabled -> fetch context -> reply in same thread
- if task assigned -> acknowledge + update presence/task status
- if muted/paused -> switch to read-only behavior
- Writes action traces for every decision branch.
- Enforces cooldowns and bounded retries.

### 3) Conversation continuity
- Durable thread context references include stable `threadId`, `replyToEventId`, and optional `contextWindowId`.
- Per-agent short memory windows are persisted and retrievable by thread.
- Orchestrator uses these references before responding.

### 4) Realtime push transport
- Keep SSE stream as canonical source.
- Add WebSocket fanout endpoint for consumers that require bidirectional/sessionful push.
- Canonical event names exposed to clients:
- `message.created`
- `mention.created`
- `task.updated`
- `presence.updated`
- `operator.override_applied`

### 5) Runtime-first UI cutover
- UI reads runtime APIs only for collaboration views:
- threads/messages -> runtime conversation/timeline
- inbox -> `/v1/inbox`
- tasks/handoffs -> `/v1/tasks`
- presence -> `/v1/presence`, `/v1/presence/last-seen`
- Remove legacy dependency on `/api/chats` and `/api/view` for primary collaboration workflows.
- Keep legacy world endpoints only as compatibility layer during cutover.

## Data model additions
- `inbox_items`
- `inbox_item_acks` (or ack fields on `inbox_items` based on final write pattern)
- optional `thread_state` / `thread_context_windows` for continuity metadata
- Redis projections:
- unread counts per actor
- recent inbox item pointers per actor-room

## Operational requirements
- Idempotency required for inbox ack mutating routes.
- Structured errors for inbox/orchestrator APIs.
- Metrics:
- inbox enqueue latency
- unread count correctness drift
- ack latency p95
- orchestrator reaction latency p95
- action success/failure by reason code

## Delivery sequence
1. Inbox API and storage contract.
2. Inbox projector + unread counters.
3. Orchestrator loop with minimal default policies.
4. Thread continuity metadata and retrieval APIs.
5. UI runtime migration to inbox/thread/task surfaces.
6. WS push layer + final cutover/deprecation switches.

## Story mapping
- ACF-905 through ACF-914 in `implementation/stories/E10-seamless-coordination.md`.

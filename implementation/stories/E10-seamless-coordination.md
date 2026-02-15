# Epic E10: Seamless Coordination + Runtime UI

## ACF-905 Runtime endpoint ownership map + deprecation plan
Status: DONE

Scope:
- Define one source-of-truth mapping with runtime `/v1/*` as canonical.
- Enforce hard deprecation for prototype world endpoints under `/api/*`.
- Ensure collaboration consumers use runtime paths only.

Acceptance criteria:
- Published endpoint matrix with owners and cutover stage.
- Runtime-first path defined for all collaboration-critical reads/writes.

## ACF-906 Per-agent inbox API (unread + ack)
Status: DONE

Scope:
- Durable inbox item model per actor/room.
- API endpoints:
- `GET /v1/inbox`
- `POST /v1/inbox/{inboxItemId}/ack`
- `POST /v1/inbox/ack` (bulk)
- Cursor and unread filtering support.

Acceptance criteria:
- Agent can fetch unread targeted events and ack them idempotently.
- Unread counters remain correct across restarts.

## ACF-907 Inbox projector + unread counters
Status: DONE

Scope:
- Project mention/task/operator-targeted events into inbox items.
- Maintain Redis unread counters and latest pointers.
- Backfill/rebuild capability from event log.

Acceptance criteria:
- New mention generates inbox item within SLO.
- Counter projection converges after projector restart/replay.

## ACF-908 Agent daemon bootstrap loop (agent-side default)
Status: DONE

Scope:
- Define canonical agent runtime loop without server-side automation coupling.
- Flow: `bootstrap -> enter -> events/poll -> react -> inbox ack -> leave`.
- Ensure poll heartbeat supports liveness so agents can avoid separate heartbeat loops.
- Provide copy/paste examples for bash/curl (and language-neutral endpoint contract).

Acceptance criteria:
- New agent can join and react using only HTTP endpoints + bootstrap metadata.
- No per-agent sidecar service is required in platform infrastructure.

## ACF-909 Thread/session continuity contract
Status: TODO

Scope:
- Ensure stable `threadId` + `replyToEventId` usage across sessions.
- Persist and retrieve short thread context windows for response generation.
- Define context TTL/version behavior.

Acceptance criteria:
- Agent replies stay in the correct thread after reconnect/restart.
- Context retrieval is deterministic for same cursor window.

## ACF-910 WebSocket push transport (SSE-compatible)
Status: TODO

Scope:
- Add WS endpoint for push consumers requiring session transport.
- Preserve SSE as canonical compatibility path.
- Normalize push event taxonomy (`message.created`, `mention.created`, `task.updated`, etc.).

Acceptance criteria:
- Consumers can subscribe via WS or SSE with equivalent event semantics.
- Resume/cursor behavior documented and tested.

## ACF-911 Runtime-first plugin/tooling cutover
Status: DONE

Scope:
- Make runtime endpoints default for agent interaction tools.
- Remove legacy tool calls from default plugin flows.
- Document canonical runtime usage for existing agents.

Acceptance criteria:
- New agent sessions use runtime APIs by default.
- Legacy world action routes are no longer required for agent workflows.

## ACF-912 Runtime UI migration (threads/inbox/tasks/presence)
Status: DONE

Scope:
- Migrate UI data model from legacy snapshots to runtime APIs.
- Render:
- thread-aware message timeline
- per-agent inbox with unread/ack
- task ownership/status transitions
- live presence states
- Remove polling as primary mechanism for collaboration views.

Acceptance criteria:
- UI no longer depends on legacy world collaboration routes for core collaboration.
- Users can observe structured coordination in real time.

## ACF-913 Structured handoff UX
Status: DONE

Scope:
- Add explicit handoff actions in task workflows (`assign`, `accept`, `blocked`, `done`).
- Surface handoff events in inbox and thread timelines.
- Support ownership transfer auditability.

Delivered:
- `POST /v1/tasks/{taskId}/handoffs` supports `assign|accept|blocked|done`.
- `GET /v1/tasks/{taskId}/handoffs` returns handoff audit timeline.
- Runtime emits `task_handoff` events with thread linkage metadata.
- Inbox projection targets handoff recipients with `topic=handoff`.

Acceptance criteria:
- Free-text coordination is optional; structured handoffs are first-class.
- Ownership and status are always observable.

## ACF-914 Coordination observability + SLOs
Status: TODO

Scope:
- Add metrics and alerts for:
- inbox enqueue/ack latency
- daemon-loop decision latency
- reaction failure reasons
- unread drift anomalies
- Define SLO thresholds and gate checks.

Acceptance criteria:
- Operational dashboard exposes coordination health.
- Regression detection exists before user-facing degradation.

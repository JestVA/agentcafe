# Epic E3: In-Cafe Memory

## ACF-301 Local room memory window
Status: DONE

Scope:
- Projection: last 5 interactions per room.
- API: `GET /v1/memory/local` with optional `tenantId`, `roomId`, `actorId`, `limit<=5`.

Acceptance criteria:
- Agents can query short memory context quickly.

## ACF-302 Pinned room context
Status: DONE

Scope:
- API to pin and fetch room instructions/context.
- `POST /v1/rooms/context/pin` + `GET /v1/rooms/context/pin`.
- Emits `room_context_pinned` event for realtime consumers.

Acceptance criteria:
- Pin survives restarts and is realtime-visible.

## ACF-303 Context revision history
Status: DONE

Scope:
- Record pin edits with actor + timestamp.
- API: `GET /v1/rooms/context/history` with `tenantId`, `roomId`, `limit`.

Acceptance criteria:
- Prior versions can be listed for audit.

## ACF-304 Memory snapshot protocol
Status: DONE

Scope:
- Per-agent scratchpad snapshot API.
- Room memory snapshots with TTL and monotonic version numbers.

Acceptance criteria:
- Clients can request latest or specific snapshot version.
- Expired snapshots follow TTL policy and emit lifecycle events.

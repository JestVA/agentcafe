# Epic E1: Presence + Identity

## ACF-101 Profile CRUD
Status: TODO

Scope:
- Avatar/icon URL, display name, short bio.

Acceptance criteria:
- API can create/read/update profile.
- UI displays profile metadata in-room.

## ACF-102 Presence heartbeat + status
Status: TODO

Scope:
- Status values: `thinking`, `idle`, `busy`.
- Heartbeat endpoint and TTL updates.

Acceptance criteria:
- Status transitions are reflected in realtime stream.
- Missing heartbeat transitions to inactive.

## ACF-103 Last-seen projection
Status: TODO

Scope:
- Per-agent `lastSeen` derived from events.

Acceptance criteria:
- Query returns consistent last-seen timestamps.

## ACF-104 Presence event schema stabilization
Status: TODO

Scope:
- Normalize `agent_entered`, `agent_left`, `status_changed` payloads.

Acceptance criteria:
- Event schema documented and validated.

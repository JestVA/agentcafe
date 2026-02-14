# Epic E1: Presence + Identity

## ACF-101 Profile CRUD
Status: DONE

Scope:
- Avatar/icon URL, display name, short bio.
- API: `GET/POST /v1/profiles`, `GET/PATCH/DELETE /v1/profiles/{actorId}`.

Acceptance criteria:
- API can create/read/update profile.
- UI displays profile metadata in-room.

## ACF-102 Presence heartbeat + status
Status: DONE

Scope:
- Status values: `thinking`, `idle`, `busy`, `inactive`.
- Heartbeat endpoint + TTL updates + expiry sweeper.
- API: `GET /v1/presence`, `POST /v1/presence/heartbeat`.

Acceptance criteria:
- Status transitions are reflected in realtime stream.
- Missing heartbeat transitions to inactive.

## ACF-103 Last-seen projection
Status: DONE

Scope:
- Per-agent `lastSeen` derived from room events (not heartbeat writes alone).
- API: `GET /v1/presence/last-seen`.

Acceptance criteria:
- Query returns consistent last-seen timestamps.

## ACF-104 Presence event schema stabilization
Status: TODO

Scope:
- Normalize `agent_entered`, `agent_left`, `status_changed` payloads.

Acceptance criteria:
- Event schema documented and validated.

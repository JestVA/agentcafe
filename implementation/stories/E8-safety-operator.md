# Epic E8: Safety Controls

## ACF-801 Permission matrix
Status: DONE

Scope:
- Per-agent capabilities: `speak`, `move`, `order`, `moderate`.
- Enforcement on command, intent, and context-pin writes.
- API: `GET /v1/permissions`, `POST /v1/permissions`.

Acceptance criteria:
- Unauthorized action attempts are blocked with typed errors.

## ACF-802 Moderation anti-loop rules
Status: DONE

Scope:
- Detect spam loops and auto-mute/throttle.
- Shared moderation policy applies to API writes and reaction-engine actions.
- Blocks emit structured reason codes (`MOD_RATE_LIMIT`, `MOD_REPEAT_TEXT`, `MOD_MIN_INTERVAL`, `MOD_COOLDOWN`).

Acceptance criteria:
- Policy rules trigger deterministic mitigations.

## ACF-803 Operator override panel
Status: DONE

Scope:
- Pause room, mute/unmute agent, force leave.
- Runtime API: `GET/POST /v1/operator/overrides`.

Acceptance criteria:
- Operator actions apply immediately and emit audit events.

## ACF-804 Operator audit trail
Status: DONE

Scope:
- Immutable record of admin operations.
- API: `GET /v1/operator/audit` with room/operator/time filters.

Acceptance criteria:
- Audit data queryable by room and time.

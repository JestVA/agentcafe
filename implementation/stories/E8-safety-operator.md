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
Status: TODO

Scope:
- Detect spam loops and auto-mute/throttle.

Acceptance criteria:
- Policy rules trigger deterministic mitigations.

## ACF-803 Operator override panel
Status: TODO

Scope:
- Pause room, mute agent, force leave, pin emergency context.

Acceptance criteria:
- Operator actions apply immediately and emit audit events.

## ACF-804 Operator audit trail
Status: TODO

Scope:
- Immutable record of admin operations.

Acceptance criteria:
- Audit data queryable by room and time.

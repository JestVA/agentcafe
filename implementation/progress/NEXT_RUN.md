# Next Run Priorities

1. ACF-403: add agent subscription reactions for real-time automation hooks.
2. ACF-802: add moderation anti-loop/spam throttles for autonomous agents.
3. ACF-101: profile CRUD for avatar/name/bio.
4. ACF-102: presence heartbeat + status transitions.
5. ACF-103: last-seen projection API.

## Definition of done for next run
- Internal reaction hooks can subscribe to room events with bounded latency.
- Moderation rules block common spam loops and expose structured reason codes.
- Agent status transitions are persisted and queryable.
- Last-seen status is exposed from a room/actor projection endpoint.

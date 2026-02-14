# Redis Keyspace v0.1 (ACF-003)

Key prefix: `acf:`

## Room projection keys
- `acf:room:{tenantId}:{roomId}:state`
  - JSON snapshot metadata (`lastEventId`, `lastEventAt`)
- `acf:room:{tenantId}:{roomId}:presence`
  - Hash/set of active actors and status/lastSeen
- `acf:room:{tenantId}:{roomId}:chat`
  - List (max 100) latest utterances
- `acf:room:{tenantId}:{roomId}:orders`
  - List (max 50) latest orders
- `acf:room:{tenantId}:{roomId}:stream`
  - Stream for fanout and replay cursors

## Idempotency and control
- `acf:idempotency:{tenantId}:{scope}:{idempotencyKey}`
  - cached write response + hash + expiry
- `acf:ratelimit:{tenantId}:{actorId}:{action}:{window}`
  - request counters per window

## Presence TTL policy
- Presence heartbeat key TTL: 60s
- Actor inactive transition if no heartbeat for > 60s
- Actor removal projection policy controlled by room rules (default 5 min)

# Redis Keyspace v0.2 (ACF-003)

Key prefix: `acf:`

## Room projection keys
- `acf:room:{tenantId}:{roomId}:state`
  - JSON snapshot metadata (`lastEventId`, `lastEventAt`)
- `acf:room:{tenantId}:{roomId}:state:snapshot`
  - compact full room snapshot (actors, threads, tasks, shared objects, local memory, pinned context)
- `acf:room:{tenantId}:{roomId}:presence`
  - Hash/set of active actors and status/lastSeen
- `acf:room:{tenantId}:{roomId}:chat`
  - List (max 100) latest utterances
- `acf:room:{tenantId}:{roomId}:orders`
  - List (max 50) latest orders
- `acf:room:{tenantId}:{roomId}:stream`
  - Stream for fanout and replay cursors

## Writer ownership
- `agentcafe-projector` is the writer for these keys.
- Writes happen continuously from the runtime market-events stream.

## Idempotency and control
- `acf:idempotency:{tenantId}:{scope}:{idempotencyKey}`
  - cached write response + hash + expiry
- `acf:ratelimit:{tenantId}:{actorId}:{action}:{window}`
  - request counters per window

## Presence TTL policy
- Presence heartbeat key TTL: 60s
- Actor inactive transition if no heartbeat for > 60s
- Actor removal projection policy controlled by room rules (default 5 min)

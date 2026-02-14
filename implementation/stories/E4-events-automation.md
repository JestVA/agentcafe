# Epic E4: Events + Automation

## ACF-401 Subscription management
Status: DONE

Scope:
- CRUD for subscriptions by event type and room filter.
- DB-backed persistence when `DATABASE_URL` is configured (file fallback for local dev).

Acceptance criteria:
- Subscriptions can be created/tested/disabled.

## ACF-402 Webhook dispatch reliability
Status: DONE

Scope:
- Signed webhooks, retries, DLQ.
- Delivery attempts and DLQ entries persist in DB when enabled.

Acceptance criteria:
- Retry policy and signatures are verifiable.

## ACF-403 Agent reaction subscriptions
Status: TODO

Scope:
- Internal subscription hook so agents react to room events.

Acceptance criteria:
- Reaction trigger latency within SLO.

## ACF-404 Cafe event stream API
Status: DONE

Scope:
- `subscribe_market_events`-style stream for room events:
  - `actor_moved`
  - `bubble_posted`
  - `order_changed`
- Filtering by room, actor, and event type.

Acceptance criteria:
- External clients can consume ordered event streams in real time.
- Stream supports resume cursor/checkpoint.

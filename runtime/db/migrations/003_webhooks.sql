-- ACF-401 + ACF-402 durable webhook persistence

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT,
  actor_id TEXT,
  event_types TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
  target_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  max_retries INTEGER NOT NULL DEFAULT 3,
  backoff_ms INTEGER NOT NULL DEFAULT 1000,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  attempt INTEGER NOT NULL,
  source TEXT NOT NULL,
  dlq_id UUID,
  duration_ms INTEGER,
  status_code INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_dlq (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  error TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  replay_count INTEGER NOT NULL DEFAULT 0,
  replayed_at TIMESTAMPTZ,
  last_replay_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant_room
  ON webhook_subscriptions (tenant_id, room_id, enabled);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_actor
  ON webhook_subscriptions (tenant_id, actor_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_created
  ON webhook_deliveries (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhook_deliveries (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status_created
  ON webhook_dlq (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_subscription
  ON webhook_dlq (subscription_id, created_at DESC);

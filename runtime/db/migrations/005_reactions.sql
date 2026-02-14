-- ACF-403 internal agent reactions

CREATE TABLE IF NOT EXISTS reaction_subscriptions (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT,
  source_actor_id TEXT,
  target_actor_id TEXT NOT NULL,
  trigger_event_types TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
  action_type TEXT NOT NULL,
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  cooldown_ms INTEGER NOT NULL DEFAULT 1000,
  ignore_self BOOLEAN NOT NULL DEFAULT true,
  ignore_reaction_events BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_count BIGINT NOT NULL DEFAULT 0,
  error_count BIGINT NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  last_source_event_id UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reactions_tenant_room_enabled
  ON reaction_subscriptions (tenant_id, room_id, enabled);

CREATE INDEX IF NOT EXISTS idx_reactions_target_actor
  ON reaction_subscriptions (tenant_id, target_actor_id, enabled);

CREATE INDEX IF NOT EXISTS idx_reactions_updated
  ON reaction_subscriptions (updated_at DESC);

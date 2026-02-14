-- ACF-803 operator overrides (pause room, mute agent, force leave control state)

CREATE TABLE IF NOT EXISTS operator_room_overrides (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  room_paused BOOLEAN NOT NULL DEFAULT false,
  paused_by TEXT,
  pause_reason TEXT,
  paused_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  muted_actors JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_room_overrides_updated
  ON operator_room_overrides (tenant_id, updated_at DESC);

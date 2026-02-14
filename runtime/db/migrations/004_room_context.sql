-- ACF-302 room pinned context

CREATE TABLE IF NOT EXISTS room_context_pins (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  pinned_by TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, room_id, version)
);

CREATE INDEX IF NOT EXISTS idx_room_context_active
  ON room_context_pins (tenant_id, room_id, is_active, version DESC);

CREATE INDEX IF NOT EXISTS idx_room_context_history
  ON room_context_pins (tenant_id, room_id, version DESC);

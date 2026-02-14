-- ACF-102 presence heartbeat + status

CREATE TABLE IF NOT EXISTS presence_states (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  ttl_ms INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, room_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_room_status
  ON presence_states (tenant_id, room_id, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_presence_expires
  ON presence_states (expires_at, is_active);

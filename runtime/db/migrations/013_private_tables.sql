-- ACF-1001 private table rooms + paid table sessions

CREATE TABLE IF NOT EXISTS rooms (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'lobby',
  display_name TEXT,
  owner_actor_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, room_id),
  CONSTRAINT chk_rooms_type CHECK (room_type IN ('lobby', 'private_table'))
);

CREATE INDEX IF NOT EXISTS idx_rooms_tenant_type_updated
  ON rooms (tenant_id, room_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_rooms_owner_updated
  ON rooms (tenant_id, owner_actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS table_sessions (
  session_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  invited_actor_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  payment_ref TEXT,
  payment_amount_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_provider TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_table_sessions_status CHECK (status IN ('active', 'ended')),
  CONSTRAINT chk_table_sessions_payment_amount CHECK (payment_amount_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_table_sessions_tenant_room_status_updated
  ON table_sessions (tenant_id, room_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_table_sessions_owner_updated
  ON table_sessions (tenant_id, owner_actor_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_table_sessions_expires
  ON table_sessions (expires_at);

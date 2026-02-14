-- ACF-002 initial schema

CREATE TABLE IF NOT EXISTS events (
  sequence BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  causation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agents (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS permissions (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  can_move BOOLEAN NOT NULL DEFAULT true,
  can_speak BOOLEAN NOT NULL DEFAULT true,
  can_order BOOLEAN NOT NULL DEFAULT true,
  can_enter_leave BOOLEAN NOT NULL DEFAULT true,
  can_moderate BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, room_id)
);

CREATE TABLE IF NOT EXISTS room_snapshots (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  snapshot_version BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, room_id, snapshot_version)
);

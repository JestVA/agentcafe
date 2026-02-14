-- ACF-916 durable stores: agent snapshots + traces

CREATE TABLE IF NOT EXISTS agent_snapshots (
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  snapshot_version BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, room_id, actor_id, snapshot_version)
);

CREATE INDEX IF NOT EXISTS idx_agent_snapshots_expiry
  ON agent_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS traces (
  trace_id UUID NOT NULL,
  correlation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  actor_id TEXT,
  tenant_id TEXT,
  room_id TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_traces_started_at
  ON traces (started_at DESC);

CREATE TABLE IF NOT EXISTS trace_steps (
  step_seq BIGSERIAL PRIMARY KEY,
  correlation_id TEXT NOT NULL REFERENCES traces(correlation_id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  code TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_trace_steps_lookup
  ON trace_steps (correlation_id, step_seq DESC);

-- ACF-002 performance indexes

CREATE INDEX IF NOT EXISTS idx_events_tenant_room_sequence
  ON events (tenant_id, room_id, sequence);

CREATE INDEX IF NOT EXISTS idx_events_tenant_room_created
  ON events (tenant_id, room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_created
  ON events (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_permissions_agent
  ON permissions (tenant_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_expiry
  ON room_snapshots (expires_at);

-- ACF-804 immutable operator audit trail

CREATE TABLE IF NOT EXISTS operator_audit_log (
  id UUID PRIMARY KEY,
  audit_seq BIGSERIAL UNIQUE,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_actor_id TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  request_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'applied',
  event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_tenant_room_created
  ON operator_audit_log (tenant_id, room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_tenant_operator_created
  ON operator_audit_log (tenant_id, operator_id, created_at DESC);

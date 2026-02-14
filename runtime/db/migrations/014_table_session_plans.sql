-- ACF-1002 plan-aware private table sessions

ALTER TABLE table_sessions
  ADD COLUMN IF NOT EXISTS plan_id TEXT;

UPDATE table_sessions
SET plan_id = COALESCE(NULLIF(plan_id, ''), 'cappuccino')
WHERE plan_id IS NULL OR plan_id = '';

ALTER TABLE table_sessions
  ALTER COLUMN plan_id SET DEFAULT 'cappuccino';

ALTER TABLE table_sessions
  ALTER COLUMN plan_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_table_sessions_tenant_plan_updated
  ON table_sessions (tenant_id, plan_id, updated_at DESC);

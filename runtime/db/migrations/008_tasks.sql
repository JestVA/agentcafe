-- ACF-701 tasks/quests domain model

CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  assignee_actor_id TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  CONSTRAINT chk_tasks_state CHECK (state IN ('open', 'active', 'done')),
  CONSTRAINT chk_tasks_progress CHECK (progress >= 0 AND progress <= 100)
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_room_state_updated
  ON tasks (tenant_id, room_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_updated
  ON tasks (tenant_id, assignee_actor_id, updated_at DESC);

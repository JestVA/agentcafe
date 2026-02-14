-- ACF-702 shared objects (whiteboard, notes, tokens)

CREATE TABLE IF NOT EXISTS shared_objects (
  object_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_key TEXT,
  title TEXT,
  content TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  quantity INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_shared_objects_type CHECK (object_type IN ('whiteboard', 'note', 'token')),
  CONSTRAINT chk_shared_objects_quantity CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT chk_shared_objects_version CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_shared_objects_tenant_room_updated
  ON shared_objects (tenant_id, room_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_objects_tenant_room_type_updated
  ON shared_objects (tenant_id, room_id, object_type, updated_at DESC);

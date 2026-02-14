-- ACF-906/ACF-907 inbox durability + projector cursor

CREATE TABLE IF NOT EXISTS inbox_items (
  inbox_seq BIGSERIAL PRIMARY KEY,
  inbox_id UUID NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_event_id UUID NOT NULL,
  source_event_sequence BIGINT NOT NULL DEFAULT 0,
  source_event_type TEXT NOT NULL,
  source_actor_id TEXT,
  source_event_at TIMESTAMPTZ,
  thread_id TEXT,
  topic TEXT NOT NULL DEFAULT 'unknown',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at TIMESTAMPTZ,
  acked_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_dedupe
  ON inbox_items (tenant_id, room_id, actor_id, source_event_id);

CREATE INDEX IF NOT EXISTS idx_inbox_items_lookup
  ON inbox_items (tenant_id, actor_id, room_id, inbox_seq DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_items_unread
  ON inbox_items (tenant_id, actor_id, room_id, acked_at, inbox_seq DESC);

CREATE TABLE IF NOT EXISTS projector_cursors (
  projector TEXT PRIMARY KEY,
  cursor BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_usage_events
  ADD COLUMN IF NOT EXISTS revision_id TEXT REFERENCES memory_revisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS memory_usage_events_revision_id_idx
  ON memory_usage_events(revision_id);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, revision_number)
);

ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS current_revision_id TEXT REFERENCES memory_revisions(id);

CREATE INDEX IF NOT EXISTS memory_revisions_entry_revision_idx
  ON memory_revisions(entry_id, revision_number);

CREATE INDEX IF NOT EXISTS memory_entries_current_revision_idx
  ON memory_entries(current_revision_id);

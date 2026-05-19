CREATE TABLE IF NOT EXISTS memory_refinement_opinions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  opinion_type TEXT NOT NULL CHECK (
    opinion_type IN (
      'opinion',
      'patch_request',
      'correction',
      'question'
    )
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN (
      'open',
      'resolved',
      'rejected'
    )
  ),
  body TEXT NOT NULL,
  suggested_patch JSONB,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_refinement_opinions_entry_id_idx ON memory_refinement_opinions(entry_id);
CREATE INDEX IF NOT EXISTS memory_refinement_opinions_status_idx ON memory_refinement_opinions(status);
CREATE INDEX IF NOT EXISTS memory_refinement_opinions_created_at_idx ON memory_refinement_opinions(created_at);

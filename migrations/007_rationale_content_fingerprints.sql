CREATE TABLE IF NOT EXISTS rationale_content_fingerprints (
  content_fingerprint TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rationale_content_fingerprints_entry_idx
  ON rationale_content_fingerprints(entry_id);

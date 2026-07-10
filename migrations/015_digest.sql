CREATE TABLE IF NOT EXISTS digest_claims (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('now', 'recent', 'longterm', 'about')),
  text TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1 CHECK (evidence_count >= 1),
  sample_note_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS digest_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  note_cursor TIMESTAMPTZ,
  prose JSONB NOT NULL DEFAULT '{"now":"","recent":"","longterm":"","about":""}'::jsonb,
  synthesized_at TIMESTAMPTZ,
  refresh_started_at TIMESTAMPTZ
);

INSERT INTO digest_state (id)
VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ops JSONB NOT NULL,
  prose_snapshot JSONB NOT NULL,
  new_note_count INTEGER NOT NULL CHECK (new_note_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error TEXT
);

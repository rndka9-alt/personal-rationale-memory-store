CREATE TABLE IF NOT EXISTS retrieval_query_events (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('search', 'compose')),
  query TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  top_score DOUBLE PRECISION,
  warning_kinds TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retrieval_query_events_created_idx
  ON retrieval_query_events(created_at);

CREATE INDEX IF NOT EXISTS retrieval_query_events_zero_hit_idx
  ON retrieval_query_events(created_at)
  WHERE result_count = 0;

CREATE TABLE IF NOT EXISTS llm_request_logs (
  id TEXT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cost_usd NUMERIC,
  usage_raw JSONB,
  run_id TEXT
);

CREATE INDEX IF NOT EXISTS llm_request_logs_requested_at_idx ON llm_request_logs(requested_at DESC);

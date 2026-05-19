CREATE TABLE IF NOT EXISTS memory_usage_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'retrieved',
      'composed',
      'applied',
      'dismissed',
      'user_helpful',
      'user_unhelpful'
    )
  ),
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  task TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_usage_events_entry_id_idx ON memory_usage_events(entry_id);
CREATE INDEX IF NOT EXISTS memory_usage_events_event_type_idx ON memory_usage_events(event_type);
CREATE INDEX IF NOT EXISTS memory_usage_events_created_at_idx ON memory_usage_events(created_at);

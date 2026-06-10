ALTER TABLE retrieval_query_events
  ADD COLUMN IF NOT EXISTS project_name TEXT;

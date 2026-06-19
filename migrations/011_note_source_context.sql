ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS topic TEXT CHECK (topic IS NULL OR char_length(topic) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS source_conversation JSONB;

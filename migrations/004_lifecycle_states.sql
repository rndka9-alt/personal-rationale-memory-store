ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS acceptance_state TEXT NOT NULL DEFAULT 'candidate',
  ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS decision_state TEXT NOT NULL DEFAULT 'unknown';

UPDATE memory_entries
SET acceptance_state = CASE
    WHEN status IN ('accepted', 'deprecated') THEN status
    ELSE 'candidate'
  END
WHERE acceptance_state = 'candidate';

UPDATE memory_entries
SET review_state = COALESCE(metadata->>'review_state', 'unreviewed')
WHERE review_state = 'unreviewed'
  AND COALESCE(metadata->>'review_state', '') IN ('unreviewed', 'reviewed', 'needs_revision');

CREATE INDEX IF NOT EXISTS memory_entries_acceptance_state_idx ON memory_entries(acceptance_state);
CREATE INDEX IF NOT EXISTS memory_entries_review_state_idx ON memory_entries(review_state);
CREATE INDEX IF NOT EXISTS memory_entries_decision_state_idx ON memory_entries(decision_state);

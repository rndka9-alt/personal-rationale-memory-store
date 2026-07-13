CREATE TABLE IF NOT EXISTS digest_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES digest_claims(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id),
  observed_at TIMESTAMPTZ NOT NULL,
  source_kind TEXT NOT NULL,
  PRIMARY KEY (claim_id, note_id)
);

CREATE INDEX IF NOT EXISTS digest_claim_evidence_observed_at_idx
  ON digest_claim_evidence(claim_id, observed_at, note_id);

CREATE TABLE IF NOT EXISTS digest_deferred_promotions (
  claim_id TEXT PRIMARY KEY REFERENCES digest_claims(id) ON DELETE CASCADE,
  target_layer TEXT NOT NULL CHECK (target_layer IN ('longterm', 'about')),
  requested_at TIMESTAMPTZ NOT NULL,
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS digest_deferred_promotions_requested_at_idx
  ON digest_deferred_promotions(requested_at, claim_id);

ALTER TABLE digest_state
  ADD COLUMN IF NOT EXISTS note_cursor_id TEXT,
  ADD COLUMN IF NOT EXISTS judgment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS longterm_merge_pressure BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS about_merge_pressure BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS skipped_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS deferred_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'synthesis';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'digest_claims'
      AND column_name = 'sample_note_ids'
  ) THEN
    INSERT INTO digest_claim_evidence (claim_id, note_id, observed_at, source_kind)
    SELECT claims.id, sampled.note_id, notes.created_at, 'legacy'
    FROM digest_claims AS claims
    CROSS JOIN LATERAL unnest(claims.sample_note_ids) AS sampled(note_id)
    JOIN notes ON notes.id = sampled.note_id
    ON CONFLICT (claim_id, note_id) DO NOTHING;
  END IF;
END
$$;

UPDATE digest_state
SET note_cursor_id = COALESCE((
  SELECT MAX(notes.id)
  FROM notes
  WHERE notes.created_at = digest_state.note_cursor
), '')
WHERE note_cursor IS NOT NULL
  AND note_cursor_id IS NULL;

UPDATE digest_state
SET judgment_at = synthesized_at
WHERE judgment_at IS NULL
  AND synthesized_at IS NOT NULL;

ALTER TABLE digest_claims
  DROP COLUMN IF EXISTS sample_note_ids,
  DROP COLUMN IF EXISTS evidence_count;

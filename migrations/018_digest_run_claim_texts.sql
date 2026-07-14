-- 합성 히스토리(digest_runs.ops)는 claim을 id로만 참조하므로, 이후 revise로 문구가
-- 바뀌면 run 당시 무엇이 강화·승격·은퇴됐는지 재구성할 수 없다. run 시점의 claim
-- 문구를 별도 스냅샷으로 얼려 히스토리가 사후 수정에 오염되지 않게 한다.
CREATE TABLE IF NOT EXISTS digest_run_claim_texts (
  run_id TEXT NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES digest_claims(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, claim_id)
);

-- "이 claim이 어떤 run들에서 다뤄졌는지" 역방향 조회용.
CREATE INDEX IF NOT EXISTS digest_run_claim_texts_claim_id_idx
  ON digest_run_claim_texts(claim_id);

COMMENT ON TABLE digest_run_claim_texts IS
  '합성 run이 id로만 참조하는 claim의 run 시점 문구 스냅샷. ops·skipped_operations·deferred_events가 가리키는 claim을 사람이 읽을 수 있게 보존한다.';
COMMENT ON COLUMN digest_run_claim_texts.run_id IS
  '문구를 관측한 합성 run. run 삭제 시 스냅샷도 함께 삭제된다.';
COMMENT ON COLUMN digest_run_claim_texts.claim_id IS
  '참조된 claim. 한 run이 같은 claim을 여러 operation에서 다뤄도 스냅샷은 1행이다.';
COMMENT ON COLUMN digest_run_claim_texts.text IS
  'run 시작 시점(판단 입력에 노출된) claim 문구. 이후 revise되어도 이 행은 불변이다.';

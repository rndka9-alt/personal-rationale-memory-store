-- 합성 히스토리(digest_runs.ops)는 claim을 id로만 참조하므로, 이후 revise로 문구가
-- 바뀌면 run 당시 무엇이 강화·승격·은퇴됐는지 재구성할 수 없다. run 시점의 claim
-- 문구를 별도 스냅샷으로 얼려 히스토리가 사후 수정에 오염되지 않게 한다.
-- claim_id는 RESTRICT: 스냅샷은 역사 기록이라 claim 삭제를 따라 증발하면 안 된다.
-- 정상 삭제 경로(seed --force)는 run을 먼저 지워 run_id CASCADE로 스냅샷이 비워지므로
-- claim 삭제가 막히지 않고, 그 외의 직접 claim 삭제는 실수로 보고 차단한다.
CREATE TABLE IF NOT EXISTS digest_run_claim_texts (
  run_id TEXT NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES digest_claims(id) ON DELETE RESTRICT,
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, claim_id)
);

-- 초기 배포본은 claim_id가 CASCADE였다. CREATE IF NOT EXISTS는 기존 테이블을 건드리지
-- 않으므로, 이미 만들어진 DB의 제약을 같은 정의로 맞춘다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'digest_run_claim_texts_claim_id_fkey'
      AND confdeltype = 'c'
  ) THEN
    ALTER TABLE digest_run_claim_texts
      DROP CONSTRAINT digest_run_claim_texts_claim_id_fkey;
    ALTER TABLE digest_run_claim_texts
      ADD CONSTRAINT digest_run_claim_texts_claim_id_fkey
      FOREIGN KEY (claim_id) REFERENCES digest_claims(id) ON DELETE RESTRICT;
  END IF;
END
$$;

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

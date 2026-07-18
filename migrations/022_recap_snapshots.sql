-- 돌아보기(Recap) 스냅샷: 수동 새로고침으로 생성되는 "완결된 기간 회고"의 실행 상태와 결과.
-- 러너가 매 기동 전체 재실행하므로 모든 DDL은 idempotent하게 작성한다(021 계승).

CREATE TABLE IF NOT EXISTS recap_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  period_days INTEGER NOT NULL CHECK (period_days >= 1),
  period_end DATE NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  snapshot_id TEXT
);

-- 동시 클릭 잠금: 같은 (기간 길이, 기간 끝)에 running 상태 run은 하나만 존재할 수 있다.
CREATE UNIQUE INDEX IF NOT EXISTS recap_runs_running_unique_idx
  ON recap_runs(period_days, period_end)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS recap_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  period_days INTEGER NOT NULL CHECK (period_days >= 1),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  comparison_start DATE NOT NULL,
  comparison_end DATE NOT NULL,
  time_zone TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  prompt_version INTEGER NOT NULL,
  source_version BIGINT NOT NULL,
  source_counters JSONB NOT NULL,
  result JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recap_snapshots_period_generated_idx
  ON recap_snapshots(period_days, generated_at DESC);

-- 스냅샷 신선도의 원천. 스냅샷 행을 UPDATE하지 않고, 스냅샷이 저장한 source_version과
-- 이 singleton의 현재 version 차이로 stale을 파생 계산한다. 소스별 counter는
-- "새 노트 2 · 새 질의 4" 같은 차이 표시용.
CREATE TABLE IF NOT EXISTS recap_activity_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  version BIGINT NOT NULL DEFAULT 0,
  note_events BIGINT NOT NULL DEFAULT 0,
  retrieval_events BIGINT NOT NULL DEFAULT 0,
  usage_events BIGINT NOT NULL DEFAULT 0,
  revision_events BIGINT NOT NULL DEFAULT 0
);

INSERT INTO recap_activity_state (id)
VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;

-- llm_request_logs가 여기 없는 것은 의도다: recap 합성 자신의 LLM 로그가 방금 만든
-- 스냅샷을 즉시 stale로 만드는 자가참조를 막는다. recap 비용은 LLM 대시보드에서 본다.
CREATE OR REPLACE FUNCTION recap_bump_activity() RETURNS trigger AS $$
BEGIN
  UPDATE recap_activity_state SET
    version = version + 1,
    note_events = note_events + (CASE WHEN TG_TABLE_NAME = 'notes' THEN 1 ELSE 0 END),
    retrieval_events = retrieval_events + (CASE WHEN TG_TABLE_NAME = 'retrieval_query_events' THEN 1 ELSE 0 END),
    usage_events = usage_events + (CASE WHEN TG_TABLE_NAME = 'memory_usage_events' THEN 1 ELSE 0 END),
    revision_events = revision_events + (CASE WHEN TG_TABLE_NAME = 'memory_revisions' THEN 1 ELSE 0 END)
  WHERE id = 'singleton';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- notes는 INSERT 외에 본문·topic 수정과 archive/restore도 집계에 영향을 주므로 UPDATE OF를 건다.
DROP TRIGGER IF EXISTS recap_activity_notes_trigger ON notes;
CREATE TRIGGER recap_activity_notes_trigger
  AFTER INSERT OR UPDATE OF content, topic, archived ON notes
  FOR EACH ROW EXECUTE FUNCTION recap_bump_activity();

DROP TRIGGER IF EXISTS recap_activity_retrieval_trigger ON retrieval_query_events;
CREATE TRIGGER recap_activity_retrieval_trigger
  AFTER INSERT ON retrieval_query_events
  FOR EACH ROW EXECUTE FUNCTION recap_bump_activity();

DROP TRIGGER IF EXISTS recap_activity_usage_trigger ON memory_usage_events;
CREATE TRIGGER recap_activity_usage_trigger
  AFTER INSERT ON memory_usage_events
  FOR EACH ROW EXECUTE FUNCTION recap_bump_activity();

DROP TRIGGER IF EXISTS recap_activity_revisions_trigger ON memory_revisions;
CREATE TRIGGER recap_activity_revisions_trigger
  AFTER INSERT ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION recap_bump_activity();

COMMENT ON TABLE recap_runs IS 'recap 스냅샷 합성 실행 상태. POST /api/recap/refresh가 생성하고 클라이언트는 폴링한다.';
COMMENT ON TABLE recap_snapshots IS 'recap 합성 결과. result에 facts/themes/cards/opening/evidence를 함께 저장해 재검증 가능하다. 노트 스니펫은 역사 기록으로 보존한다(원본 archive와 무관).';
COMMENT ON TABLE recap_activity_state IS 'recap 신선도 판정용 활동 버전 singleton. 트리거가 소스 테이블 변경 시 증가시킨다.';
COMMENT ON COLUMN recap_snapshots.period_end IS 'exclusive 상한. KST 자정 경계의 DATE라 같은 날 재클릭은 동일 기간이 되어 재합성하지 않는다.';
COMMENT ON COLUMN recap_snapshots.source_version IS '합성 시점의 recap_activity_state.version. 현재 version이 더 크면 stale.';

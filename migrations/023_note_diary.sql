-- 일기장(Note Diary): 완결된 KST 주간(월~일)의 노트를 에피소드로 엮은 스냅샷.
-- 러너가 매 기동 전체 재실행하므로 모든 DDL은 idempotent하게 작성한다(021 계승).

CREATE TABLE IF NOT EXISTS note_diary_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  week_start DATE NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  snapshot_id TEXT
);

-- 동시 클릭 잠금: 같은 주에 running 상태 run은 하나만 존재할 수 있다.
CREATE UNIQUE INDEX IF NOT EXISTS note_diary_runs_running_unique_idx
  ON note_diary_runs(week_start)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS note_diary_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  time_zone TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  prompt_version INTEGER NOT NULL,
  result JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_diary_snapshots_week_generated_idx
  ON note_diary_snapshots(week_start, generated_at DESC);

COMMENT ON TABLE note_diary_runs IS '일기장 합성 실행 상태. POST /api/diary/refresh가 생성하고 클라이언트는 폴링한다.';
COMMENT ON TABLE note_diary_snapshots IS '일기장 합성 결과. result에 서문·에피소드(노트 원문 포함)·한마디를 저장한다. 노트 원문은 역사 기록으로 보존한다(이후 archive·수정과 무관).';
COMMENT ON COLUMN note_diary_snapshots.week_start IS 'KST 달력 기준 그 주 월요일. 완결된 주만 합성 대상이다.';
COMMENT ON COLUMN note_diary_snapshots.week_end IS 'exclusive 상한(다음 주 월요일).';

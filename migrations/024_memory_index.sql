-- 메모리 색인(Memory Index): 반복 재캡처된 지식을 트리거 문구 한 줄로 상시 노출하는 색인.
-- 유사도는 저장하지 않는다 — memory_chunks 임베딩에서 즉석 재계산 가능한 파생값이라
-- 영속화하면 낡음 관리 대상만 늘어난다. 러너가 매 기동 전체 재실행하므로 idempotent DDL(021 계승).

CREATE TABLE IF NOT EXISTS memory_index_lines (
  id TEXT PRIMARY KEY,
  trigger_phrase TEXT NOT NULL,
  anchor_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  project_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_index_lines_status_idx
  ON memory_index_lines(status);

CREATE TABLE IF NOT EXISTS memory_index_line_members (
  line_id TEXT NOT NULL REFERENCES memory_index_lines(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, entry_id)
);

CREATE INDEX IF NOT EXISTS memory_index_line_members_entry_idx
  ON memory_index_line_members(entry_id);

COMMENT ON TABLE memory_index_lines IS '메모리 색인 줄. 반복 재캡처로 자동 승격된 트리거 문구를 compose_context 상단에 상시 노출한다.';
COMMENT ON COLUMN memory_index_lines.trigger_phrase IS '승격 LLM이 생성한 인출 단서 한 줄 — 상황 조건이 앞에 오는 명령형.';
COMMENT ON COLUMN memory_index_lines.anchor_entry_id IS '클러스터 medoid(멤버간 평균 유사도 최고 문서). 편입 쿼럼 판정의 기준점이며 편입·탈퇴 때 재선출된다.';
COMMENT ON COLUMN memory_index_lines.project_name IS '멤버 전원이 같은 프로젝트면 그 이름, 아니면 NULL(프로젝트 무관).';
COMMENT ON COLUMN memory_index_lines.status IS 'retired는 소프트 삭제 — 멤버가 3건 미만으로 떨어지면 내려가고 이력은 보존한다.';
COMMENT ON TABLE memory_index_line_members IS '색인 줄과 memory_entries의 N:N 매핑. 한 메모리가 여러 줄의 근거일 수 있다. 멤버의 created_at이 곧 재캡처 발생 기록이다.';

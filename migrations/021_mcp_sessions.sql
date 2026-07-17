-- MCP transport 세션 단위 관측 메타데이터. 클라이언트 정보(clientInfo)는 initialize
-- 핸드셰이크에서만 오는 세션 스코프 데이터라, 로그 테이블마다 반복 저장하지 않고
-- 여기 1회만 적재한 뒤 각 로그의 session_id로 조인해 되찾는다.
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  client_name TEXT,
  client_version TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 관측 전용이라 FK 제약을 걸지 않는다: 세션 upsert 실패가 도메인 쓰기를 막으면 안 되고,
-- 세션 row 선행 존재를 강제하는 순서 결합도 피한다. 읽을 땐 LEFT JOIN mcp_sessions로 붙인다.
-- rationale 활동은 mutable 카탈로그(memory_entries)가 아니라 append-only 리비전 이력에 싣는다.
-- 캡처(rev0)와 수정(rev1+)이 각각 1행이라 세션별 활동 신호가 더 정확하고, insertMemoryRevision이
-- 요청 스코프 안에서 pool로 직접 실행돼 배선도 깔끔하다.
ALTER TABLE notes                  ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE retrieval_query_events ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE memory_usage_events    ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE memory_revisions       ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_session_id                  ON notes(session_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_query_events_session_id ON retrieval_query_events(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_events_session_id    ON memory_usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_session_id       ON memory_revisions(session_id);

-- 매 기동 전체 재실행 러너에서 미래의 DROP/RENAME이 COMMENT ON을 지뢰로 만들지 않도록
-- 대상 존재를 확인한 뒤에만 코멘트를 적용한다(019 및 뚠뚠이 교훈 계승).
DO $$
DECLARE
  entry RECORD;
BEGIN
  IF to_regclass('mcp_sessions') IS NOT NULL THEN
    COMMENT ON TABLE mcp_sessions IS 'MCP transport 세션 단위 관측 메타데이터. 세션 스코프 클라이언트 정보를 1회만 적재하고 각 로그가 session_id로 참조한다.';
  END IF;

  FOR entry IN
    SELECT * FROM (VALUES
      ('mcp_sessions', 'id',             'transport가 발급한 mcp-session-id UUID. 각 로그의 session_id가 가리키는 대상.'),
      ('mcp_sessions', 'client_name',    'initialize clientInfo.name(예: claude-code, openai-mcp). 자기신고가 아닌 핸드셰이크 값.'),
      ('mcp_sessions', 'client_version', 'initialize clientInfo.version.'),
      ('mcp_sessions', 'user_agent',     'HTTP User-Agent 헤더. clientInfo가 없을 때의 보조 식별자.'),
      ('mcp_sessions', 'created_at',     '행 생성 시각 = 세션 연결(초기화) 시각.'),
      ('notes',                  'session_id', '이 노트를 기록한 MCP 세션(mcp_sessions.id). 비-MCP 경로는 NULL. FK 없는 관측용 조인 키.'),
      ('retrieval_query_events', 'session_id', '이 질의가 실행된 MCP 세션(mcp_sessions.id). 비-MCP 경로는 NULL.'),
      ('memory_usage_events',    'session_id', '이 사용 이벤트가 발생한 MCP 세션(mcp_sessions.id). 비-MCP 경로는 NULL.'),
      ('memory_revisions',       'session_id', '이 rationale 리비전을 기록한 MCP 세션(mcp_sessions.id). 비-MCP 경로는 NULL.')
    ) AS c(table_name, column_name, comment_text)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = entry.table_name AND column_name = entry.column_name
    ) THEN
      EXECUTE format('COMMENT ON COLUMN %I.%I IS %L', entry.table_name, entry.column_name, entry.comment_text);
    END IF;
  END LOOP;
END $$;

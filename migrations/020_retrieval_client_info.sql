-- 질의 로그에 "누가 보냈는지"를 남긴다. LLM에게 자기 식별을 지시하는 방식은
-- 프롬프트 오염과 허위 신고 위험이 있어, MCP initialize 핸드셰이크의 clientInfo와
-- HTTP User-Agent 등 전송 계층 메타데이터만으로 클라이언트를 구분한다.
ALTER TABLE retrieval_query_events
  ADD COLUMN IF NOT EXISTS client_name TEXT,
  ADD COLUMN IF NOT EXISTS client_version TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

COMMENT ON COLUMN retrieval_query_events.client_name IS 'MCP initialize 핸드셰이크의 clientInfo.name. 도구 스키마 변경 전후의 클라이언트별 사용 행태 비교 축. stdio 등 미확보 경로는 NULL.';
COMMENT ON COLUMN retrieval_query_events.client_version IS 'MCP initialize 핸드셰이크의 clientInfo.version.';
COMMENT ON COLUMN retrieval_query_events.user_agent IS '질의가 실린 HTTP 요청의 User-Agent 헤더. clientInfo가 앱 단위 식별에 그칠 때의 보조 신호.';

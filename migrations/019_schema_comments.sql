-- 기존 스키마 전체에 테이블·컬럼 코멘트를 소급 부여한다. 새 테이블·컬럼의 코멘트는
-- 각자의 마이그레이션에서 함께 정의한다.
--
-- 러너(src/db/migrations.ts)는 추적 테이블 없이 매 기동마다 전체 파일을 재실행하므로,
-- 이후 마이그레이션이 컬럼·테이블을 DROP/RENAME하면 그 대상을 가리키는 COMMENT ON이
-- 기동을 막는다. 존재 확인 후 EXECUTE하는 DO 블록으로 감싸 사라진 대상은 조용히
-- 건너뛰게 한다.
DO $$
DECLARE
  table_entry RECORD;
  column_entry RECORD;
BEGIN
  FOR table_entry IN
    SELECT * FROM (VALUES
      ('memory_entries', 'rationale 메모리(근거·실패 사례·선호·컨벤션·제약 등)의 카탈로그. 소스 오브 트루스는 canonical_path의 markdown 파일이고, 이 행은 검색과 수명주기 관리를 위한 인덱스다.'),
      ('memory_chunks', '검색용 파생 테이블. 메모리 본문을 청크로 쪼개 임베딩과 함께 보관하며, 원본 재인덱싱으로 언제든 재생성할 수 있다.'),
      ('ontology_terms', '분류 어휘(domain/intent/mode/memory_type 등) 레지스트리. 소스 오브 트루스는 data/ontology의 YAML이고 이 테이블은 로드 시 동기화된다.'),
      ('ontology_proposals', '분류 어휘 변경 제안 큐. 캡처 과정에서 발견된 새 어휘 후보를 사람이 결정할 때까지 보관한다.'),
      ('memory_usage_events', '메모리 단위 사용·피드백 이벤트 로그. 어떤 메모리가 실제로 도움이 됐는지 추적해 랭킹과 수명주기 판단의 근거로 쓴다.'),
      ('rationale_content_fingerprints', 'auto-capture 중복 방지 원장. 같은 내용이 여러 세션에서 재캡처될 때 기존 메모리로 안내하기 위해 내용 지문을 보관한다.'),
      ('retrieval_query_events', '검색·컨텍스트 컴포즈 질의 로그. 제로히트 질의와 낮은 매칭 점수를 관찰해 메모리 커버리지 공백을 찾는 용도다.'),
      ('notes', '사용자 개인 노트 원장. digest 합성의 원료이자 compose_notes_context의 직접 출력이다.'),
      ('memory_revisions', '메모리 본문의 append-only 리비전 이력. 수정 전 내용과 사유를 보존해 피드백을 리비전 단위로 귀속시킨다.'),
      ('digest_claims', 'digest 원장: 노트에서 합성된 사용자에 대한 주장(claim). 은퇴해도 행을 지우지 않아 run 히스토리의 id 참조가 항상 해석된다.'),
      ('digest_state', 'digest 전역 상태 싱글턴(id=singleton 1행). 노트 커서, 렌더된 산문, 리프레시 락을 담는다.'),
      ('digest_runs', '합성 run의 append-only 감사 로그. 성공·실패 모두 기록하며 웹 UI 합성 히스토리가 이 테이블을 읽는다.'),
      ('llm_request_logs', 'LLM 호출 단위 사용량·비용 로그. 게이트웨이 비용 대시보드와 실패 진단의 원천이다.'),
      ('digest_claim_evidence', 'claim을 뒷받침하는 노트 증거(claim-노트 쌍당 1행). 관측일 수·관측 스팬 계산의 원천이다.'),
      ('digest_deferred_promotions', '관측 스팬 게이트에 걸려 대기 중인 승격 큐(claim당 1행). 대기 중인 claim은 recent 노후화 은퇴에서 보호된다.')
    ) AS tables(table_name, comment_text)
  LOOP
    IF to_regclass(table_entry.table_name) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE %I IS %L', table_entry.table_name, table_entry.comment_text);
    END IF;
  END LOOP;

  FOR column_entry IN
    SELECT * FROM (VALUES
      ('memory_entries', 'id', 'frontmatter id와 동일한 메모리 식별자.'),
      ('memory_entries', 'type', '메모리 종류(rationale, known_failure, preference, convention, constraint, principle 등).'),
      ('memory_entries', 'status', '레거시 상태 필드. 수명주기 로직은 acceptance_state/review_state/decision_state를 사용하고 이 컬럼은 호환용으로만 유지한다.'),
      ('memory_entries', 'title', '메모리 제목.'),
      ('memory_entries', 'summary', '본문에서 추출한 최대 500자 요약. 검색 결과·목록 표시용 파생 값.'),
      ('memory_entries', 'canonical_path', '소스 오브 트루스인 markdown 파일 경로. DB 행이 유실돼도 이 파일에서 재인덱싱할 수 있다.'),
      ('memory_entries', 'scope', '적용 범위 라벨(기본 general).'),
      ('memory_entries', 'source_kind', '메모리 출처 종류(도구·세션 등). 출처가 없는 수동 등록은 NULL.'),
      ('memory_entries', 'source_ref', 'source_kind 내부의 구체 참조 값.'),
      ('memory_entries', 'confidence', '0~1 신뢰도. 검색 랭킹 신호로 쓰인다.'),
      ('memory_entries', 'created_at', '메모리 생성 시각.'),
      ('memory_entries', 'updated_at', '메모리 마지막 수정 시각.'),
      ('memory_entries', 'last_used_at', '검색·컴포즈에 마지막으로 쓰인 시각. 최근 사용 랭킹·정렬 신호.'),
      ('memory_entries', 'use_count', '검색·컴포즈에 쓰인 누적 횟수. 자주 쓰인 메모리를 우대하는 랭킹 신호.'),
      ('memory_entries', 'promoted_to', '이 메모리를 승격해 만든 상위(principle) 메모리 id.'),
      ('memory_entries', 'deprecated_by', '이 메모리를 대체(폐기)시킨 메모리 id.'),
      ('memory_entries', 'metadata', 'domains/intents/modes/project 등 스키마로 굳히지 않은 부가 분류 정보(JSONB).'),
      ('memory_entries', 'acceptance_state', '수용 수명주기: candidate → accepted → deprecated.'),
      ('memory_entries', 'review_state', '리뷰 상태: unreviewed | reviewed | needs_revision.'),
      ('memory_entries', 'decision_state', '의사결정형 메모리의 결정 상태: proposed | decided | superseded | unknown.'),
      ('memory_entries', 'current_revision_id', '현재 본문이 가리키는 memory_revisions 리비전. 리비전 이력 도입 이전 행은 NULL.'),
      ('memory_chunks', 'id', '청크 행 식별자.'),
      ('memory_chunks', 'entry_id', '청크가 속한 메모리.'),
      ('memory_chunks', 'chunk_index', '엔트리 내 청크 순서.'),
      ('memory_chunks', 'chunk_kind', 'summary(제목+요약 결합) 또는 body(본문 문단 묶음).'),
      ('memory_chunks', 'content', '청크 텍스트 원문.'),
      ('memory_chunks', 'embedding', '벡터 검색용 1024차원 임베딩. 임베딩 실패 시 NULL로 남아 어휘 검색만 가능하다.'),
      ('memory_chunks', 'token_estimate', '대략적 토큰 수. 컨텍스트 예산 계산에 쓴다.'),
      ('memory_chunks', 'metadata', '청크 부가 정보(JSONB). chunk_index 등 디버깅용 사본을 담는다.'),
      ('ontology_terms', 'id', '어휘 항 식별자.'),
      ('ontology_terms', 'kind', '어휘 종류: intent | domain | mode | memory_type | routing_policy.'),
      ('ontology_terms', 'name', '어휘 항 이름.'),
      ('ontology_terms', 'description', '어휘 항 설명.'),
      ('ontology_terms', 'status', '어휘 항 상태(기본 accepted).'),
      ('ontology_terms', 'parent_id', '계층 구조를 표현하는 상위 항 id.'),
      ('ontology_terms', 'metadata', '어휘 항 부가 정보(JSONB).'),
      ('ontology_terms', 'created_at', '어휘 항 등록 시각.'),
      ('ontology_terms', 'updated_at', '어휘 항 마지막 동기화 시각.'),
      ('ontology_proposals', 'id', '제안 식별자.'),
      ('ontology_proposals', 'proposal_type', '제안 동작: add | deprecate | rename | merge | split.'),
      ('ontology_proposals', 'target_kind', '대상 어휘 종류: intent | domain | mode | memory_type | routing_policy.'),
      ('ontology_proposals', 'name', '제안 대상 어휘 이름.'),
      ('ontology_proposals', 'reason', '제안 사유.'),
      ('ontology_proposals', 'proposed_change', '제안된 변경 내용(JSONB).'),
      ('ontology_proposals', 'status', '제안 상태(proposed에서 시작해 결정 시 갱신).'),
      ('ontology_proposals', 'created_at', '제안 생성 시각.'),
      ('ontology_proposals', 'decided_at', '제안 결정 시각. 미결정이면 NULL.'),
      ('memory_usage_events', 'id', '이벤트 식별자.'),
      ('memory_usage_events', 'entry_id', '이벤트 대상 메모리.'),
      ('memory_usage_events', 'event_type', 'retrieved | composed | applied | dismissed | user_helpful | user_unhelpful.'),
      ('memory_usage_events', 'source_kind', '이벤트를 만든 주체·도구 종류.'),
      ('memory_usage_events', 'source_ref', 'source_kind 내부의 구체 참조 값.'),
      ('memory_usage_events', 'task', '이벤트 당시 수행 중이던 작업 설명.'),
      ('memory_usage_events', 'metadata', '이벤트 부가 정보(JSONB).'),
      ('memory_usage_events', 'created_at', '이벤트 발생 시각.'),
      ('memory_usage_events', 'revision_id', '피드백이 관측된 시점의 본문 리비전. 리비전별 품질 추적을 위해 남기며, 리비전 삭제 시 NULL이 된다.'),
      ('rationale_content_fingerprints', 'content_fingerprint', '정규화한 제목+본문의 SHA-256. 출처·분류가 달라도 같은 문서는 같은 지문을 갖는다.'),
      ('rationale_content_fingerprints', 'entry_id', '지문이 가리키는 메모리.'),
      ('rationale_content_fingerprints', 'status', 'processing | completed | failed. 동시 캡처 경합에서 승자 하나만 진행하게 한다.'),
      ('rationale_content_fingerprints', 'failure_reason', 'status=failed일 때의 실패 사유.'),
      ('rationale_content_fingerprints', 'created_at', '지문 등록 시각.'),
      ('rationale_content_fingerprints', 'updated_at', '지문 상태 마지막 갱신 시각.'),
      ('retrieval_query_events', 'id', '질의 이벤트 식별자.'),
      ('retrieval_query_events', 'source_kind', '질의 출처: search(검색 도구) | compose(컨텍스트 컴포즈).'),
      ('retrieval_query_events', 'query', '질의 원문.'),
      ('retrieval_query_events', 'result_count', '반환된 결과 수. 0이면 커버리지 공백 후보.'),
      ('retrieval_query_events', 'top_score', '최고 매칭 점수. 결과가 없으면 NULL.'),
      ('retrieval_query_events', 'warning_kinds', '질의 처리 중 발생한 경고 종류 배열.'),
      ('retrieval_query_events', 'created_at', '질의 시각.'),
      ('retrieval_query_events', 'project_name', '질의 시 랭킹 부스트 대상이던 프로젝트 이름. 프로젝트 컨텍스트가 없으면 NULL.'),
      ('notes', 'id', '노트 식별자.'),
      ('notes', 'content', '노트 본문(1~1000자).'),
      ('notes', 'upvotes', 'rate_note 긍정 평가 누적. 컨텍스트 노출 우선순위 신호.'),
      ('notes', 'downvotes', 'rate_note 부정 평가 누적.'),
      ('notes', 'archived', 'TRUE면 컨텍스트 출력과 digest 신규 노트 대상에서 제외한다.'),
      ('notes', 'created_at', '노트 작성 시각. digest 증거의 observed_at 원천이 된다.'),
      ('notes', 'updated_at', '노트 마지막 수정 시각.'),
      ('notes', 'topic', '노트가 나온 대화의 짧은 주제 라벨(1~120자).'),
      ('notes', 'source_conversation', '노트의 근거가 된 대화 발췌(역할·순서를 보존한 1~4개 메시지, JSONB). 직접 발화 판별에 쓰인다.'),
      ('memory_revisions', 'id', '리비전 식별자.'),
      ('memory_revisions', 'entry_id', '리비전이 속한 메모리.'),
      ('memory_revisions', 'revision_number', '엔트리 내 0부터 증가하는 리비전 번호.'),
      ('memory_revisions', 'content', '이 리비전 시점의 markdown 본문 전문.'),
      ('memory_revisions', 'reason', '이 리비전을 만든 수정 사유.'),
      ('memory_revisions', 'metadata', '리비전 부가 정보(JSONB).'),
      ('memory_revisions', 'created_at', '리비전 생성 시각.'),
      ('digest_claims', 'id', 'claim 식별자(D + uuid).'),
      ('digest_claims', 'layer', '수명 레이어: now(진행 중 관심사) | recent(최근 사건) | longterm(안정적 사실) | about(성향·취향).'),
      ('digest_claims', 'text', '현재 claim 문구. revise·merge로 갱신된다.'),
      ('digest_claims', 'created_at', 'claim 최초 생성 시각.'),
      ('digest_claims', 'updated_at', '문구·레이어·은퇴 상태의 마지막 변경 시각.'),
      ('digest_claims', 'retired_at', '은퇴 시각. NULL이면 활성 claim으로 판단·렌더 입력에 포함된다.'),
      ('digest_state', 'id', '싱글턴 고정 키(singleton).'),
      ('digest_state', 'note_cursor', '소화 완료한 마지막 노트의 created_at. note_cursor_id와 (created_at, id) 튜플 커서를 이룬다.'),
      ('digest_state', 'note_cursor_id', '튜플 커서의 id 부분. 같은 시각에 만들어진 노트를 중복·누락 없이 가르기 위해 필요하다.'),
      ('digest_state', 'prose', '레이어별 렌더 산문(JSONB). compose 시 즉시 출력되는 캐시다.'),
      ('digest_state', 'synthesized_at', '마지막 성공 run 시각(유지보수 run 포함).'),
      ('digest_state', 'refresh_started_at', '리프레시 락 토큰. 실행 중인 프로세스의 시작 시각이며 타임아웃이 지나면 다른 프로세스가 탈취할 수 있다.'),
      ('digest_state', 'judgment_at', '마지막 판단(synthesis) 실행 시각. 렌더만 한 run이 판단 주기를 뒤로 밀지 않도록 synthesized_at과 분리한다.'),
      ('digest_state', 'longterm_merge_pressure', 'longterm 레이어 소프트캡 압력 상태. 트리거·해제 수를 달리한 히스테리시스로 유지된다.'),
      ('digest_state', 'about_merge_pressure', 'about 레이어 소프트캡 압력 상태. longterm_merge_pressure와 같은 방식.'),
      ('digest_runs', 'id', 'run 식별자. llm_request_logs.run_id·digest_run_claim_texts.run_id와 연결된다.'),
      ('digest_runs', 'run_at', 'run 실행 시각.'),
      ('digest_runs', 'ops', '적용된 operation 목록(JSONB). LLM 판단 출력과 유지보수 자동 op의 직렬화 사본이라 형태가 6종으로 이질적이다.'),
      ('digest_runs', 'prose_snapshot', 'run 직후의 레이어별 산문 스냅샷(JSONB).'),
      ('digest_runs', 'new_note_count', '이 run이 소화한 신규 노트 수. 유지보수 run은 0.'),
      ('digest_runs', 'status', 'succeeded | failed.'),
      ('digest_runs', 'error', 'status=failed일 때의 실패 사유.'),
      ('digest_runs', 'skipped_operations', '검증·우선순위 충돌로 거부된 op와 거부 사유 목록(JSONB).'),
      ('digest_runs', 'deferred_events', '승격 대기 큐 변화 이벤트(queued/applied/removed/retained) 목록(JSONB).'),
      ('digest_runs', 'run_kind', 'synthesis(LLM 판단 포함) | maintenance(코드 전용 유지보수).'),
      ('llm_request_logs', 'id', '요청 로그 식별자.'),
      ('llm_request_logs', 'requested_at', '요청 시각.'),
      ('llm_request_logs', 'purpose', '호출 목적(digest_judgment | digest_render | digest_repair 등).'),
      ('llm_request_logs', 'provider', 'LLM 제공자(anthropic | openai | vercel).'),
      ('llm_request_logs', 'model', '요청에 사용한 모델 이름.'),
      ('llm_request_logs', 'status', 'succeeded | failed.'),
      ('llm_request_logs', 'error', '실패 사유. 토큰 한도 도달·빈 응답도 실패로 기록한다.'),
      ('llm_request_logs', 'duration_ms', '요청 소요 시간(ms).'),
      ('llm_request_logs', 'input_tokens', '입력 토큰 수. 제공자가 알려주지 않으면 NULL.'),
      ('llm_request_logs', 'output_tokens', '출력 토큰 수.'),
      ('llm_request_logs', 'total_tokens', '총 토큰 수.'),
      ('llm_request_logs', 'cached_input_tokens', '프롬프트 캐시에서 읽은 입력 토큰 수.'),
      ('llm_request_logs', 'cache_creation_input_tokens', '프롬프트 캐시 생성에 쓴 입력 토큰 수.'),
      ('llm_request_logs', 'cost_usd', '게이트웨이가 응답에 실은 실제 청구액(USD). Vercel AI Gateway만 제공하므로 다른 제공자는 NULL이고 토큰으로 사후 계산한다.'),
      ('llm_request_logs', 'usage_raw', '응답 usage 원본(JSONB). 비용 재계산·필드 누락 진단용.'),
      ('llm_request_logs', 'run_id', '이 호출을 만든 digest run. run 단위 비용 집계에 쓴다.'),
      ('digest_claim_evidence', 'claim_id', '증거가 속한 claim.'),
      ('digest_claim_evidence', 'note_id', '증거 노트.'),
      ('digest_claim_evidence', 'observed_at', '원본 노트의 작성 시각. run 시각을 쓰면 늦게 처리된 노트가 최신 관측으로 둔갑하므로 노트 시각을 보존한다.'),
      ('digest_claim_evidence', 'source_kind', '증거 유입 경로: note(합성) | seed(시드) | legacy(017 백필).'),
      ('digest_deferred_promotions', 'claim_id', '승격 대기 중인 claim.'),
      ('digest_deferred_promotions', 'target_layer', '승격 목표 안정 레이어: longterm | about.'),
      ('digest_deferred_promotions', 'requested_at', '승격이 처음 요청된 시각. 큐 처리 순서를 정한다.'),
      ('digest_deferred_promotions', 'run_id', '대기를 만든 run. 감사 추적용.'),
      ('digest_deferred_promotions', 'reason', '즉시 승격하지 못한 사유(관측 스팬 미달 등).')
    ) AS columns(table_name, column_name, comment_text)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = column_entry.table_name
        AND column_name = column_entry.column_name
    ) THEN
      EXECUTE format(
        'COMMENT ON COLUMN %I.%I IS %L',
        column_entry.table_name,
        column_entry.column_name,
        column_entry.comment_text
      );
    END IF;
  END LOOP;
END
$$;

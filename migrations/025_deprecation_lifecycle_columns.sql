-- deprecation lifecycle을 revision이 아닌 entry 컬럼으로 승격한다. revision은 콘텐츠
-- (title/body) 이력만 담고, deprecate/restore 같은 상태 전이는 이 컬럼들이 진실이다.
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS deprecation_reason TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

-- 구형 deprecate 경로는 replacement가 없으면 deprecated_by에 사유 문자열을 넣었다.
-- entry id 형태(R<timestamp>-...)가 아닌 값은 사유로 옮긴다.
UPDATE memory_entries
  SET deprecation_reason = deprecated_by,
      deprecated_by = NULL
  WHERE deprecated_by IS NOT NULL
    AND deprecated_by !~ '^R[0-9]{8}T'
    AND deprecation_reason IS NULL;

UPDATE memory_entries
  SET deprecation_reason = metadata->>'deprecation_reason'
  WHERE acceptance_state = 'deprecated'
    AND deprecation_reason IS NULL
    AND metadata->>'deprecation_reason' IS NOT NULL;

COMMENT ON COLUMN memory_entries.deprecation_reason IS '이 메모리를 폐기한 사유. 복원 시 비워진다.';
COMMENT ON COLUMN memory_entries.deprecated_at IS '폐기 시각. 복원 시 비워진다. 컬럼 도입(2026-08) 이전에 폐기된 행은 NULL일 수 있다.';

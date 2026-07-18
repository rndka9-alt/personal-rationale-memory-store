import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildPeakDayCandidate,
  buildRecordDayCandidate,
  buildSurgeCandidates,
  buildThemeRiseCandidates,
  mergeTopicCounts,
  RecapSnapshotService,
  selectCandidates,
  type RecapCandidate,
  type RecapWindowFacts
} from "../src/memory/recapSnapshotService.js";

const enabledDigestConfig = (() => {
  const config = loadConfig({
    DIGEST_ENABLED: "true",
    DIGEST_LLM_PROVIDER: "vercel",
    DIGEST_LLM_MODEL: "openai/gpt-test",
    DIGEST_LLM_API_KEY: "test-key"
  }).digest;
  if (!config.enabled) {
    throw new Error("Expected digest config to be enabled.");
  }
  return config;
})();

describe("recap refresh idempotency", () => {
  it("reuses the snapshot when one already exists for the same period", async () => {
    const query = vi.fn().mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes("AS period_end")) {
        return Promise.resolve({ rows: [{ period_end: "2026-07-18" }] });
      }
      if (text.includes("FROM recap_snapshots")) {
        return Promise.resolve({ rows: [{ id: "snapshot-1" }] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const connect = vi.fn();
    const service = new RecapSnapshotService({ query, connect }, enabledDigestConfig, {
      generate: vi.fn()
    });

    await expect(service.requestRefresh(30)).resolves.toEqual({
      status: "exists",
      snapshotId: "snapshot-1"
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO recap_runs"))).toBe(false);
  });

  it("rejects synthesis when no LLM configuration is available", async () => {
    const service = new RecapSnapshotService({ query: vi.fn(), connect: vi.fn() }, null);

    expect(service.synthesisEnabled).toBe(false);
    await expect(service.requestRefresh(30)).rejects.toThrow("DIGEST_ENABLED");
  });
});

describe("recap candidate rules", () => {
  it("skips surge candidates below volume or ratio thresholds and keeps 0-to-N cases", () => {
    const current = createFacts({ noteCount: 12, retrievalQueryCount: 4, reuseAppliedCount: 12, rationaleCapturedCount: 0 });
    const comparison = createFacts({ noteCount: 4, retrievalQueryCount: 3, reuseAppliedCount: 0, rationaleCapturedCount: 30 });

    const candidates = buildSurgeCandidates(current, comparison);
    const ids = candidates.map((candidate) => candidate.id);

    // notes: 12 vs 4 → 3배 증가 채택. queries: 합계 7 < 10이라 볼륨 미달 제외.
    // reuse: 0→12는 배수 조건 없이 건수로 채택. captures: 30→0도 감소로 채택.
    expect(ids).toEqual(["surge_notes", "surge_reuse", "surge_captures"]);
  });

  it("keeps a record day only with enough observed history and a strict record", () => {
    const currentDaily = [
      { date: "2026-07-10", note_count: 12 },
      { date: "2026-07-11", note_count: 5 }
    ];
    expect(buildRecordDayCandidate(currentDaily, { max_daily_notes: null, earliest_note_at: null })).toBeNull();
    expect(buildRecordDayCandidate(currentDaily, {
      max_daily_notes: 8,
      earliest_note_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    })).toBeNull();
    expect(buildRecordDayCandidate(currentDaily, {
      max_daily_notes: 12,
      earliest_note_at: new Date("2026-01-01T00:00:00Z")
    })).toBeNull();

    const record = buildRecordDayCandidate(currentDaily, {
      max_daily_notes: 8,
      earliest_note_at: new Date("2026-01-01T00:00:00Z")
    });
    expect(record?.day).toBe("2026-07-10");
    expect(record?.candidate.kind).toBe("record_day");
  });

  it("flags a peak day only when it is an outlier against the same weekday baseline", () => {
    const quietDay = (date: string) => ({ date, note_count: 2, query_count: 1, revision_count: 0 });
    // 2026-07-17은 금요일. 직전 금요일들을 baseline으로 깐다.
    const baselineDays = ["2026-05-22", "2026-05-29", "2026-06-05", "2026-06-12", "2026-06-19", "2026-06-26", "2026-07-03", "2026-07-10"]
      .map(quietDay);
    const peakDay = { date: "2026-07-17", note_count: 30, query_count: 10, revision_count: 5 };
    const currentDaily = [quietDay("2026-07-16"), peakDay];

    const candidate = buildPeakDayCandidate(currentDaily, [...baselineDays, ...currentDaily]);
    expect(candidate?.day).toBe("2026-07-17");

    const notOutlier = buildPeakDayCandidate(
      [{ date: "2026-07-17", note_count: 3, query_count: 1, revision_count: 0 }],
      [...baselineDays, { date: "2026-07-17", note_count: 3, query_count: 1, revision_count: 0 }]
    );
    expect(notOutlier).toBeNull();

    const tooLittleBaseline = buildPeakDayCandidate(currentDaily, [quietDay("2026-07-10"), ...currentDaily]);
    expect(tooLittleBaseline).toBeNull();
  });

  it("merges current and comparison topics into one clustering universe", () => {
    const merged = mergeTopicCounts(
      [{ topic: "recap", note_count: 5 }, { topic: "flex", note_count: 2 }],
      [{ topic: "recap", note_count: 1 }, { topic: "digest", note_count: 4 }]
    );

    expect(merged.otherTopicCount).toBe(0);
    expect(merged.topics).toEqual([
      { id: "t0", label: "recap", currentCount: 5, comparisonCount: 1 },
      { id: "t1", label: "digest", currentCount: 0, comparisonCount: 4 },
      { id: "t2", label: "flex", currentCount: 2, comparisonCount: 0 }
    ]);
  });

  it("requires a real share gain before calling a theme rising", () => {
    const topics = [
      { id: "t0", label: "a", currentCount: 6, comparisonCount: 1 },
      { id: "t1", label: "b", currentCount: 4, comparisonCount: 9 }
    ];
    const themes = [
      { name: "테마A", topicLabels: ["a"], currentCount: 6, comparisonCount: 1 },
      { name: "테마B", topicLabels: ["b"], currentCount: 4, comparisonCount: 9 }
    ];

    const risers = buildThemeRiseCandidates(themes, topics);
    expect(risers).toHaveLength(1);
    expect(risers[0]?.stat.value).toContain("테마A");
  });

  it("caps selected candidates and limits surge cards to two", () => {
    const surge = (id: string): RecapCandidate => ({
      id,
      kind: "surge",
      stat: { label: id, value: "1건", comparison: null },
      reason: "test",
      evidence: [],
      brief: id
    });
    const selected = selectCandidates([
      surge("surge_a"),
      surge("surge_b"),
      surge("surge_c"),
      { ...surge("record"), kind: "record_day" },
      { ...surge("peak"), kind: "peak_day" }
    ]);

    expect(selected.map((candidate) => candidate.kind)).toEqual([
      "record_day",
      "peak_day",
      "surge",
      "surge"
    ]);
  });
});

function createFacts(overrides: Partial<RecapWindowFacts>): RecapWindowFacts {
  return {
    window: { start: "2026-06-18", end: "2026-07-18" },
    noteCount: 0,
    noteActiveDayCount: 0,
    retrievalQueryCount: 0,
    retrievalSessionCount: 0,
    retrievalSessionCoveredCount: 0,
    zeroHitCount: 0,
    reuseAppliedCount: 0,
    composedCount: 0,
    rationaleCapturedCount: 0,
    rationaleRevisedCount: 0,
    ...overrides
  };
}

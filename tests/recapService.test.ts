import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { RecapService } from "../src/memory/recapService.js";

describe("recap report", () => {
  it("aggregates window activity and fills weekday and hour buckets", async () => {
    const query = vi.fn().mockImplementation((sql) => Promise.resolve(resolveRecapQuery(String(sql))));
    const service = new RecapService({ query });

    const recap = await service.getRecap({ days: 30 });

    for (const [, parameters] of query.mock.calls) {
      expect(parameters).toEqual([30]);
    }
    expect(recap.periodDays).toBe(30);
    expect(recap.totals).toEqual({
      noteCount: 2,
      retrievalCount: 1,
      usageEventCount: 0,
      rationaleRevisionCount: 3,
      activeDayCount: 1
    });
    expect(recap.byWeekday).toHaveLength(7);
    expect(recap.byWeekday[4]).toEqual({ weekday: 5, eventCount: 6 });
    expect(recap.byWeekday[0]).toEqual({ weekday: 1, eventCount: 0 });
    expect(recap.byHour).toHaveLength(24);
    expect(recap.byHour[23]).toEqual({ hour: 23, eventCount: 6 });
    expect(recap.byHour[0]).toEqual({ hour: 0, eventCount: 0 });
    expect(recap.topics).toEqual([
      { topic: "Lnote", noteCount: 2 },
      { topic: null, noteCount: 1 }
    ]);
    expect(recap.retrieval.queryCount).toBe(1);
    expect(recap.retrieval.averageTopScore).toBeCloseTo(0.42);
    expect(recap.retrieval.byClient).toEqual([{ clientName: "claude-code", queryCount: 1 }]);
    expect(recap.retrieval.recentQueries).toEqual([{
      query: "돌아보기 데이터 소스",
      sourceKind: "search",
      projectName: null,
      resultCount: 3,
      createdAt: "2026-07-17T17:11:41.884Z"
    }]);
    expect(recap.rationales).toEqual({
      capturedCount: 2,
      revisedCount: 1,
      byProject: [{ projectName: "personal-rationale-memory-store", revisionCount: 3 }]
    });
    expect(recap.usageByEventType).toEqual([{ eventType: "composed", eventCount: 4 }]);
    expect(recap.llm).toEqual({ requestCount: 2, costUsd: 0.5, totalTokens: 1234 });
  });

  it("computes the window from a KST date boundary", async () => {
    const query = vi.fn().mockImplementation((sql) => Promise.resolve(resolveRecapQuery(String(sql))));
    const service = new RecapService({ query });

    await service.getRecap({ days: 7 });

    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toContain("Asia/Seoul");
      expect(String(sql)).toContain("$1::int - 1");
    }
  });

  it("counts rev0 rationale activity by the entry capture time, not the revision row time", async () => {
    const query = vi.fn().mockImplementation((sql) => Promise.resolve(resolveRecapQuery(String(sql))));
    const service = new RecapService({ query });

    await service.getRecap({ days: 30 });

    // 백필로 revision row가 한 시점에 몰려도 캡처 활동이 원래 날짜로 집계되어야 한다.
    const rationaleQueries = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("memory_revisions"));
    expect(rationaleQueries.length).toBeGreaterThanOrEqual(4);
    for (const sql of rationaleQueries) {
      expect(sql).toContain("CASE WHEN memory_revisions.revision_number = 0");
      expect(sql).toContain("THEN memory_entries.created_at");
    }
  });
});

function resolveRecapQuery(sql: string): pg.QueryResult {
  if (sql.includes("WITH days AS")) {
    return createQueryResult([
      {
        date: "2026-07-17",
        note_count: 2,
        retrieval_count: 1,
        usage_event_count: 0,
        rationale_revision_count: 3
      },
      {
        date: "2026-07-18",
        note_count: 0,
        retrieval_count: 0,
        usage_event_count: 0,
        rationale_revision_count: 0
      }
    ]);
  }
  if (sql.includes("AS weekday")) {
    return createQueryResult([{ weekday: 5, event_count: 6 }]);
  }
  if (sql.includes("AS hour")) {
    return createQueryResult([{ hour: 23, event_count: 6 }]);
  }
  if (sql.includes("GROUP BY topic")) {
    return createQueryResult([
      { topic: "Lnote", note_count: 2 },
      { topic: null, note_count: 1 }
    ]);
  }
  if (sql.includes("zero_hit_count")) {
    return createQueryResult([{ query_count: 1, zero_hit_count: 0, avg_top_score: "0.42" }]);
  }
  if (sql.includes("mcp_sessions")) {
    return createQueryResult([{ client_name: "claude-code", query_count: 1 }]);
  }
  if (sql.includes("GROUP BY project_name")) {
    return createQueryResult([{ project_name: null, query_count: 1 }]);
  }
  if (sql.includes("ORDER BY created_at DESC")) {
    return createQueryResult([{
      query: "돌아보기 데이터 소스",
      source_kind: "search",
      project_name: null,
      result_count: 3,
      created_at: new Date("2026-07-17T17:11:41.884Z")
    }]);
  }
  if (sql.includes("captured_count")) {
    return createQueryResult([{ captured_count: 2, revised_count: 1 }]);
  }
  if (sql.includes("'project' ->> 'name'")) {
    return createQueryResult([{ project_name: "personal-rationale-memory-store", revision_count: 3 }]);
  }
  if (sql.includes("GROUP BY event_type")) {
    return createQueryResult([{ event_type: "composed", event_count: 4 }]);
  }
  if (sql.includes("FROM llm_request_logs")) {
    return createQueryResult([{ request_count: 2, cost_usd: "0.5", total_tokens: "1234" }]);
  }
  throw new Error(`Unexpected recap query: ${sql}`);
}

function createQueryResult(rows: pg.QueryResultRow[]): pg.QueryResult {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows
  };
}

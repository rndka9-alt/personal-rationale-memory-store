import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { LlmRequestLogService } from "../src/memory/llmRequestLogService.js";

describe("LLM request log pagination", () => {
  it("returns the requested page with totals", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(createQueryResult([{ total_items: 3 }]))
      .mockResolvedValueOnce(createQueryResult([createRequestRow("request-2")]));
    const service = new LlmRequestLogService({ query });

    const result = await service.listRequests({ page: 2, pageSize: 2 });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LIMIT $1 OFFSET $2"),
      [2, 2]
    );
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2
    });
    expect(result.requests.map((request) => request.id)).toEqual(["request-2"]);
  });

  it("clamps a page beyond the final page before querying rows", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(createQueryResult([{ total_items: 3 }]))
      .mockResolvedValueOnce(createQueryResult([createRequestRow("request-2")]));
    const service = new LlmRequestLogService({ query });

    const result = await service.listRequests({ page: 9, pageSize: 2 });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LIMIT $1 OFFSET $2"),
      [2, 2]
    );
    expect(result.pagination.page).toBe(2);
  });
});

function createRequestRow(id: string): pg.QueryResultRow {
  return {
    id,
    requested_at: new Date("2026-07-13T00:00:00.000Z"),
    purpose: "digest_synthesis",
    provider: "vercel",
    model: "openai/gpt-5.6-terra",
    status: "succeeded",
    error: null,
    duration_ms: 1200,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: "0.01",
    usage_raw: {},
    run_id: null
  };
}

function createQueryResult(rows: pg.QueryResultRow[]): pg.QueryResult {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

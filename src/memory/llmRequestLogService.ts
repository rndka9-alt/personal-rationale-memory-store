import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

// 서버(컨테이너)는 UTC라 기본 date 경계로는 KST 새벽 요청이 전날로 집계된다.
const reportTimeZone = "Asia/Seoul";

const llmRequestLogRowSchema = z.object({
  id: z.string(),
  requested_at: z.coerce.date(),
  purpose: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().nullable(),
  duration_ms: z.coerce.number().int().nonnegative(),
  input_tokens: z.coerce.number().int().nonnegative().nullable(),
  output_tokens: z.coerce.number().int().nonnegative().nullable(),
  total_tokens: z.coerce.number().int().nonnegative().nullable(),
  cached_input_tokens: z.coerce.number().int().nonnegative().nullable(),
  cache_creation_input_tokens: z.coerce.number().int().nonnegative().nullable(),
  cost_usd: z.coerce.number().nonnegative().nullable(),
  usage_raw: z.unknown().nullable(),
  run_id: z.string().nullable()
});

const llmRequestAggregateRowSchema = z.object({
  cost_usd: z.coerce.number().nonnegative(),
  request_count: z.coerce.number().int().nonnegative(),
  failed_count: z.coerce.number().int().nonnegative()
});

const llmRequestGroupRowSchema = z.object({
  key: z.string(),
  cost_usd: z.coerce.number().nonnegative(),
  request_count: z.coerce.number().int().nonnegative()
});

const llmRequestDailyRowSchema = z.object({
  date: z.string(),
  cost_usd: z.coerce.number().nonnegative(),
  request_count: z.coerce.number().int().nonnegative()
});

const llmRequestCountRowSchema = z.object({
  total_items: z.coerce.number().int().nonnegative()
});

export type LlmRequestLogStatus = "succeeded" | "failed";

export type LlmRequestUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
  raw: unknown | null;
};

export type LlmRequestLogInput = {
  requestedAt: Date;
  purpose: string;
  provider: string;
  model: string;
  status: LlmRequestLogStatus;
  error: string | null;
  durationMs: number;
  usage: LlmRequestUsage;
  runId: string | null;
};

export type LlmRequestPageOptions = {
  page: number;
  pageSize: number;
};

export class LlmRequestLogService {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async recordRequest(input: LlmRequestLogInput) {
    await this.pool.query(
      `INSERT INTO llm_request_logs (
        id, requested_at, purpose, provider, model, status, error, duration_ms,
        input_tokens, output_tokens, total_tokens, cached_input_tokens,
        cache_creation_input_tokens, cost_usd, usage_raw, run_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      )`,
      [
        randomUUID(),
        input.requestedAt,
        input.purpose,
        input.provider,
        input.model,
        input.status,
        input.error,
        input.durationMs,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.totalTokens,
        input.usage.cachedInputTokens,
        input.usage.cacheCreationInputTokens,
        input.usage.costUsd,
        input.usage.raw,
        input.runId
      ]
    );
  }

  async listRequests(options: LlmRequestPageOptions) {
    const countResult = await this.pool.query(
      "SELECT COUNT(*)::int AS total_items FROM llm_request_logs"
    );
    const countRow = countResult.rows[0];
    if (!countRow) {
      throw new Error("LLM request count query returned no rows.");
    }
    const totalItems = llmRequestCountRowSchema.parse(countRow).total_items;
    const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
    const page = Math.min(options.page, totalPages);
    const result = await this.pool.query(
      `SELECT *
      FROM llm_request_logs
      ORDER BY requested_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
      [options.pageSize, (page - 1) * options.pageSize]
    );
    return {
      requests: result.rows.map(mapLlmRequestLogRow),
      pagination: {
        page,
        pageSize: options.pageSize,
        totalItems,
        totalPages
      }
    };
  }

  async getSummary() {
    const [totalResult, thisMonthResult, last7DaysResult, dailyResult, byPurposeResult, byModelResult] = await Promise.all([
      this.pool.query(createAggregateQuery()),
      this.pool.query(
        createAggregateQuery(
          `requested_at >= date_trunc('month', now() AT TIME ZONE '${reportTimeZone}') AT TIME ZONE '${reportTimeZone}'`
        )
      ),
      this.pool.query(createAggregateQuery("requested_at >= now() - interval '7 days'")),
      this.pool.query(
        `WITH days AS (
          SELECT generate_series(
            (now() AT TIME ZONE '${reportTimeZone}')::date - 29,
            (now() AT TIME ZONE '${reportTimeZone}')::date,
            interval '1 day'
          )::date AS day
        )
        SELECT
          to_char(days.day, 'YYYY-MM-DD') AS date,
          COALESCE(SUM(llm_request_logs.cost_usd), 0)::text AS cost_usd,
          COUNT(llm_request_logs.id)::int AS request_count
        FROM days
        LEFT JOIN llm_request_logs
          ON (llm_request_logs.requested_at AT TIME ZONE '${reportTimeZone}')::date = days.day
        GROUP BY days.day
        ORDER BY days.day ASC`
      ),
      this.pool.query(createGroupQuery("purpose")),
      this.pool.query(createGroupQuery("model"))
    ]);

    return {
      total: mapAggregateResult(totalResult),
      thisMonth: mapAggregateResult(thisMonthResult),
      last7Days: mapAggregateResult(last7DaysResult),
      daily: dailyResult.rows.map((row) => {
        const parsedRow = llmRequestDailyRowSchema.parse(row);
        return {
          date: parsedRow.date,
          costUsd: parsedRow.cost_usd,
          requestCount: parsedRow.request_count
        };
      }),
      byPurpose: byPurposeResult.rows.map(mapPurposeGroupRow),
      byModel: byModelResult.rows.map(mapModelGroupRow)
    };
  }
}

function createAggregateQuery(condition?: string) {
  const whereClause = condition ? `WHERE ${condition}` : "";
  return `SELECT
    COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
    COUNT(*)::int AS request_count,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
  FROM llm_request_logs
  ${whereClause}`;
}

function createGroupQuery(column: "purpose" | "model") {
  return `SELECT
    ${column} AS key,
    COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
    COUNT(*)::int AS request_count
  FROM llm_request_logs
  GROUP BY ${column}
  ORDER BY COALESCE(SUM(cost_usd), 0) DESC, request_count DESC, ${column} ASC`;
}

function mapAggregateResult(result: pg.QueryResult) {
  const row = result.rows[0];
  if (!row) {
    throw new Error("LLM request aggregate query returned no rows.");
  }
  const parsedRow = llmRequestAggregateRowSchema.parse(row);
  return {
    costUsd: parsedRow.cost_usd,
    requestCount: parsedRow.request_count,
    failedCount: parsedRow.failed_count
  };
}

function parseGroupRow(row: pg.QueryResultRow) {
  return llmRequestGroupRowSchema.parse(row);
}

function mapPurposeGroupRow(row: pg.QueryResultRow) {
  const parsedRow = parseGroupRow(row);
  return {
    purpose: parsedRow.key,
    costUsd: parsedRow.cost_usd,
    requestCount: parsedRow.request_count
  };
}

function mapModelGroupRow(row: pg.QueryResultRow) {
  const parsedRow = parseGroupRow(row);
  return {
    model: parsedRow.key,
    costUsd: parsedRow.cost_usd,
    requestCount: parsedRow.request_count
  };
}

function mapLlmRequestLogRow(row: pg.QueryResultRow) {
  const parsedRow = llmRequestLogRowSchema.parse(row);
  return {
    id: parsedRow.id,
    requestedAt: parsedRow.requested_at.toISOString(),
    purpose: parsedRow.purpose,
    provider: parsedRow.provider,
    model: parsedRow.model,
    status: parsedRow.status,
    error: parsedRow.error,
    durationMs: parsedRow.duration_ms,
    inputTokens: parsedRow.input_tokens,
    outputTokens: parsedRow.output_tokens,
    totalTokens: parsedRow.total_tokens,
    cachedInputTokens: parsedRow.cached_input_tokens,
    cacheCreationInputTokens: parsedRow.cache_creation_input_tokens,
    costUsd: parsedRow.cost_usd,
    usageRaw: parsedRow.usage_raw,
    runId: parsedRow.run_id
  };
}

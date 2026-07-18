import type pg from "pg";
import { z } from "zod";

// 서버(컨테이너)는 UTC라 기본 date 경계로는 KST 새벽 활동이 전날로 집계된다.
const reportTimeZone = "Asia/Seoul";

// KST 자정 기준으로 (days - 1)일 전부터 지금까지를 돌아보기 창으로 삼는다.
const windowStartExpression =
  `(((now() AT TIME ZONE '${reportTimeZone}')::date - ($1::int - 1))::timestamp AT TIME ZONE '${reportTimeZone}')`;

const recapDailyRowSchema = z.object({
  date: z.string(),
  note_count: z.coerce.number().int().nonnegative(),
  retrieval_count: z.coerce.number().int().nonnegative(),
  usage_event_count: z.coerce.number().int().nonnegative(),
  rationale_revision_count: z.coerce.number().int().nonnegative()
});

const recapWeekdayRowSchema = z.object({
  weekday: z.coerce.number().int().min(1).max(7),
  event_count: z.coerce.number().int().nonnegative()
});

const recapHourRowSchema = z.object({
  hour: z.coerce.number().int().min(0).max(23),
  event_count: z.coerce.number().int().nonnegative()
});

const recapTopicRowSchema = z.object({
  topic: z.string().nullable(),
  note_count: z.coerce.number().int().nonnegative()
});

const recapRetrievalStatsRowSchema = z.object({
  query_count: z.coerce.number().int().nonnegative(),
  zero_hit_count: z.coerce.number().int().nonnegative(),
  avg_top_score: z.coerce.number().nullable()
});

const recapClientRowSchema = z.object({
  client_name: z.string().nullable(),
  query_count: z.coerce.number().int().nonnegative()
});

const recapProjectQueryRowSchema = z.object({
  project_name: z.string().nullable(),
  query_count: z.coerce.number().int().nonnegative()
});

const recapRecentQueryRowSchema = z.object({
  query: z.string(),
  source_kind: z.string(),
  project_name: z.string().nullable(),
  result_count: z.coerce.number().int().nonnegative(),
  created_at: z.coerce.date()
});

const recapRationaleStatsRowSchema = z.object({
  captured_count: z.coerce.number().int().nonnegative(),
  revised_count: z.coerce.number().int().nonnegative()
});

const recapRationaleProjectRowSchema = z.object({
  project_name: z.string().nullable(),
  revision_count: z.coerce.number().int().nonnegative()
});

const recapUsageEventTypeRowSchema = z.object({
  event_type: z.string(),
  event_count: z.coerce.number().int().nonnegative()
});

const recapLlmRowSchema = z.object({
  request_count: z.coerce.number().int().nonnegative(),
  cost_usd: z.coerce.number().nonnegative(),
  total_tokens: z.coerce.number().int().nonnegative()
});

export type RecapOptions = {
  days: number;
};

type RecapDailyEntry = {
  date: string;
  noteCount: number;
  retrievalCount: number;
  usageEventCount: number;
  rationaleRevisionCount: number;
};

export type RecapReport = Awaited<ReturnType<RecapService["getRecap"]>>;

export class RecapService {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async getRecap(options: RecapOptions) {
    const parameters = [options.days];
    const [
      dailyResult,
      weekdayResult,
      hourResult,
      topicsResult,
      retrievalStatsResult,
      retrievalByClientResult,
      retrievalByProjectResult,
      recentQueriesResult,
      rationaleStatsResult,
      rationaleByProjectResult,
      usageByEventTypeResult,
      llmResult
    ] = await Promise.all([
      this.pool.query(createDailyQuery(), parameters),
      this.pool.query(createCombinedEventQuery(
        `EXTRACT(ISODOW FROM created_at AT TIME ZONE '${reportTimeZone}')::int AS weekday`,
        "weekday"
      ), parameters),
      this.pool.query(createCombinedEventQuery(
        `EXTRACT(HOUR FROM created_at AT TIME ZONE '${reportTimeZone}')::int AS hour`,
        "hour"
      ), parameters),
      this.pool.query(
        `SELECT topic, COUNT(*)::int AS note_count
        FROM notes
        WHERE created_at >= ${windowStartExpression}
        GROUP BY topic
        ORDER BY note_count DESC, topic ASC NULLS LAST
        LIMIT 12`,
        parameters
      ),
      this.pool.query(
        `SELECT
          COUNT(*)::int AS query_count,
          COUNT(*) FILTER (WHERE result_count = 0)::int AS zero_hit_count,
          AVG(top_score) AS avg_top_score
        FROM retrieval_query_events
        WHERE created_at >= ${windowStartExpression}`,
        parameters
      ),
      this.pool.query(
        // 020의 이벤트 자체 컬럼과 021의 세션 조인이 공존하는 과도기라 둘을 COALESCE로 합친다.
        `SELECT
          COALESCE(retrieval_query_events.client_name, mcp_sessions.client_name) AS client_name,
          COUNT(*)::int AS query_count
        FROM retrieval_query_events
        LEFT JOIN mcp_sessions ON mcp_sessions.id = retrieval_query_events.session_id
        WHERE retrieval_query_events.created_at >= ${windowStartExpression}
        GROUP BY 1
        ORDER BY query_count DESC, client_name ASC NULLS LAST
        LIMIT 10`,
        parameters
      ),
      this.pool.query(
        `SELECT project_name, COUNT(*)::int AS query_count
        FROM retrieval_query_events
        WHERE created_at >= ${windowStartExpression}
        GROUP BY project_name
        ORDER BY query_count DESC, project_name ASC NULLS LAST
        LIMIT 10`,
        parameters
      ),
      this.pool.query(
        `SELECT query, source_kind, project_name, result_count, created_at
        FROM retrieval_query_events
        WHERE created_at >= ${windowStartExpression}
        ORDER BY created_at DESC, id DESC
        LIMIT 10`,
        parameters
      ),
      this.pool.query(
        // revision_number 0은 최초 캡처, 그 이후는 수정이라 rationale 활동을 둘로 나눠 본다.
        `SELECT
          COUNT(*) FILTER (WHERE revision_number = 0)::int AS captured_count,
          COUNT(*) FILTER (WHERE revision_number > 0)::int AS revised_count
        FROM memory_revisions
        WHERE created_at >= ${windowStartExpression}`,
        parameters
      ),
      this.pool.query(
        `SELECT
          memory_entries.metadata -> 'project' ->> 'name' AS project_name,
          COUNT(*)::int AS revision_count
        FROM memory_revisions
        JOIN memory_entries ON memory_entries.id = memory_revisions.entry_id
        WHERE memory_revisions.created_at >= ${windowStartExpression}
        GROUP BY 1
        ORDER BY revision_count DESC, project_name ASC NULLS LAST
        LIMIT 10`,
        parameters
      ),
      this.pool.query(
        `SELECT event_type, COUNT(*)::int AS event_count
        FROM memory_usage_events
        WHERE created_at >= ${windowStartExpression}
        GROUP BY event_type
        ORDER BY event_count DESC, event_type ASC`,
        parameters
      ),
      this.pool.query(
        `SELECT
          COUNT(*)::int AS request_count,
          COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
        FROM llm_request_logs
        WHERE requested_at >= ${windowStartExpression}`,
        parameters
      )
    ]);

    const daily = dailyResult.rows.map((row) => {
      const parsedRow = recapDailyRowSchema.parse(row);
      return {
        date: parsedRow.date,
        noteCount: parsedRow.note_count,
        retrievalCount: parsedRow.retrieval_count,
        usageEventCount: parsedRow.usage_event_count,
        rationaleRevisionCount: parsedRow.rationale_revision_count
      };
    });
    const retrievalStats = readSingleRow(retrievalStatsResult, recapRetrievalStatsRowSchema, "recap retrieval stats");
    const rationaleStats = readSingleRow(rationaleStatsResult, recapRationaleStatsRowSchema, "recap rationale stats");
    const llmStats = readSingleRow(llmResult, recapLlmRowSchema, "recap LLM stats");

    return {
      periodDays: options.days,
      timeZone: reportTimeZone,
      totals: {
        noteCount: sumDaily(daily, "noteCount"),
        retrievalCount: sumDaily(daily, "retrievalCount"),
        usageEventCount: sumDaily(daily, "usageEventCount"),
        rationaleRevisionCount: sumDaily(daily, "rationaleRevisionCount"),
        activeDayCount: daily.filter((day) =>
          day.noteCount + day.retrievalCount + day.usageEventCount + day.rationaleRevisionCount > 0
        ).length
      },
      daily,
      byWeekday: fillBuckets(1, 7, weekdayResult.rows.map((row) => {
        const parsedRow = recapWeekdayRowSchema.parse(row);
        return { bucket: parsedRow.weekday, eventCount: parsedRow.event_count };
      })).map((entry) => ({ weekday: entry.bucket, eventCount: entry.eventCount })),
      byHour: fillBuckets(0, 23, hourResult.rows.map((row) => {
        const parsedRow = recapHourRowSchema.parse(row);
        return { bucket: parsedRow.hour, eventCount: parsedRow.event_count };
      })).map((entry) => ({ hour: entry.bucket, eventCount: entry.eventCount })),
      topics: topicsResult.rows.map((row) => {
        const parsedRow = recapTopicRowSchema.parse(row);
        return { topic: parsedRow.topic, noteCount: parsedRow.note_count };
      }),
      retrieval: {
        queryCount: retrievalStats.query_count,
        zeroHitCount: retrievalStats.zero_hit_count,
        averageTopScore: retrievalStats.avg_top_score,
        byClient: retrievalByClientResult.rows.map((row) => {
          const parsedRow = recapClientRowSchema.parse(row);
          return { clientName: parsedRow.client_name, queryCount: parsedRow.query_count };
        }),
        byProject: retrievalByProjectResult.rows.map((row) => {
          const parsedRow = recapProjectQueryRowSchema.parse(row);
          return { projectName: parsedRow.project_name, queryCount: parsedRow.query_count };
        }),
        recentQueries: recentQueriesResult.rows.map((row) => {
          const parsedRow = recapRecentQueryRowSchema.parse(row);
          return {
            query: parsedRow.query,
            sourceKind: parsedRow.source_kind,
            projectName: parsedRow.project_name,
            resultCount: parsedRow.result_count,
            createdAt: parsedRow.created_at.toISOString()
          };
        })
      },
      rationales: {
        capturedCount: rationaleStats.captured_count,
        revisedCount: rationaleStats.revised_count,
        byProject: rationaleByProjectResult.rows.map((row) => {
          const parsedRow = recapRationaleProjectRowSchema.parse(row);
          return { projectName: parsedRow.project_name, revisionCount: parsedRow.revision_count };
        })
      },
      usageByEventType: usageByEventTypeResult.rows.map((row) => {
        const parsedRow = recapUsageEventTypeRowSchema.parse(row);
        return { eventType: parsedRow.event_type, eventCount: parsedRow.event_count };
      }),
      llm: {
        requestCount: llmStats.request_count,
        costUsd: llmStats.cost_usd,
        totalTokens: llmStats.total_tokens
      }
    };
  }
}

function createDailyQuery() {
  return `WITH days AS (
    SELECT generate_series(
      (now() AT TIME ZONE '${reportTimeZone}')::date - ($1::int - 1),
      (now() AT TIME ZONE '${reportTimeZone}')::date,
      interval '1 day'
    )::date AS day
  ),
  note_counts AS (
    SELECT (created_at AT TIME ZONE '${reportTimeZone}')::date AS day, COUNT(*)::int AS note_count
    FROM notes
    WHERE created_at >= ${windowStartExpression}
    GROUP BY 1
  ),
  retrieval_counts AS (
    SELECT (created_at AT TIME ZONE '${reportTimeZone}')::date AS day, COUNT(*)::int AS retrieval_count
    FROM retrieval_query_events
    WHERE created_at >= ${windowStartExpression}
    GROUP BY 1
  ),
  usage_counts AS (
    SELECT (created_at AT TIME ZONE '${reportTimeZone}')::date AS day, COUNT(*)::int AS usage_event_count
    FROM memory_usage_events
    WHERE created_at >= ${windowStartExpression}
    GROUP BY 1
  ),
  revision_counts AS (
    SELECT (created_at AT TIME ZONE '${reportTimeZone}')::date AS day, COUNT(*)::int AS rationale_revision_count
    FROM memory_revisions
    WHERE created_at >= ${windowStartExpression}
    GROUP BY 1
  )
  SELECT
    to_char(days.day, 'YYYY-MM-DD') AS date,
    COALESCE(note_counts.note_count, 0) AS note_count,
    COALESCE(retrieval_counts.retrieval_count, 0) AS retrieval_count,
    COALESCE(usage_counts.usage_event_count, 0) AS usage_event_count,
    COALESCE(revision_counts.rationale_revision_count, 0) AS rationale_revision_count
  FROM days
  LEFT JOIN note_counts ON note_counts.day = days.day
  LEFT JOIN retrieval_counts ON retrieval_counts.day = days.day
  LEFT JOIN usage_counts ON usage_counts.day = days.day
  LEFT JOIN revision_counts ON revision_counts.day = days.day
  ORDER BY days.day ASC`;
}

function createCombinedEventQuery(bucketExpression: string, bucketName: string) {
  // 노트·질의·재사용·rationale 활동을 하나의 시각 축으로 합쳐 "언제 움직였는지"를 본다.
  return `WITH events AS (
    SELECT created_at FROM notes WHERE created_at >= ${windowStartExpression}
    UNION ALL
    SELECT created_at FROM retrieval_query_events WHERE created_at >= ${windowStartExpression}
    UNION ALL
    SELECT created_at FROM memory_usage_events WHERE created_at >= ${windowStartExpression}
    UNION ALL
    SELECT created_at FROM memory_revisions WHERE created_at >= ${windowStartExpression}
  )
  SELECT ${bucketExpression}, COUNT(*)::int AS event_count
  FROM events
  GROUP BY 1
  ORDER BY ${bucketName} ASC`;
}

function readSingleRow<TSchema extends z.ZodTypeAny>(
  result: pg.QueryResult,
  schema: TSchema,
  label: string
): z.infer<TSchema> {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${label} query returned no rows.`);
  }
  return schema.parse(row);
}

function sumDaily(daily: RecapDailyEntry[], key: keyof Omit<RecapDailyEntry, "date">) {
  return daily.reduce((total, day) => total + day[key], 0);
}

function fillBuckets(
  start: number,
  end: number,
  rows: Array<{ bucket: number; eventCount: number }>
) {
  const countsByBucket = new Map(rows.map((row) => [row.bucket, row.eventCount]));
  const buckets: Array<{ bucket: number; eventCount: number }> = [];
  for (let bucket = start; bucket <= end; bucket += 1) {
    buckets.push({ bucket, eventCount: countsByBucket.get(bucket) ?? 0 });
  }
  return buckets;
}

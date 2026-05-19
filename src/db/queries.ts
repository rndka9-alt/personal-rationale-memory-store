import { randomUUID } from "node:crypto";
import type pg from "pg";
import { logInfo } from "../diagnostics/index.js";
import {
  acceptanceStateSchema,
  decisionStateSchema,
  memoryUsageEventTypeSchema,
  refinementOpinionStatusSchema,
  refinementOpinionTypeSchema,
  reviewStateSchema,
  type MemoryEntryRecord,
  type MemoryRefinementOpinionRecord,
  type MemorySearchFilters,
  type MemoryUsageEventType,
  type ProjectContext
} from "../memory/schema.js";

export type MemoryChunkInsert = {
  entryId: string;
  chunkIndex: number;
  chunkKind: string;
  content: string;
  embedding?: number[];
  tokenEstimate: number;
  metadata: Record<string, unknown>;
};

export type MemoryUsageEventInsert = {
  entryId: string;
  eventType: MemoryUsageEventType;
  sourceKind: string;
  sourceRef?: string;
  task?: string;
  metadata: Record<string, unknown>;
};

export type MemoryRefinementOpinionInsert = {
  entryId: string;
  opinionType: MemoryRefinementOpinionRecord["opinionType"];
  body: string;
  suggestedPatch?: Record<string, unknown>;
  sourceKind: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
};

export async function upsertMemoryEntry(pool: pg.Pool, entry: MemoryEntryRecord) {
  logInfo("DB upsert memory entry started.", {
    entryId: entry.id,
    status: entry.status,
    type: entry.type
  });
  await pool.query(
    `INSERT INTO memory_entries (
      id, type, status, acceptance_state, review_state, decision_state, title, summary, canonical_path, scope, source_kind, source_ref,
      confidence, promoted_to, deprecated_by, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      status = EXCLUDED.status,
      acceptance_state = EXCLUDED.acceptance_state,
      review_state = EXCLUDED.review_state,
      decision_state = EXCLUDED.decision_state,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      canonical_path = EXCLUDED.canonical_path,
      scope = EXCLUDED.scope,
      source_kind = EXCLUDED.source_kind,
      source_ref = EXCLUDED.source_ref,
      confidence = EXCLUDED.confidence,
      promoted_to = EXCLUDED.promoted_to,
      deprecated_by = EXCLUDED.deprecated_by,
      metadata = EXCLUDED.metadata,
      updated_at = now()`,
    [
      entry.id,
      entry.type,
      entry.status,
      entry.acceptanceState,
      entry.reviewState,
      entry.decisionState,
      entry.title,
      entry.summary,
      entry.canonicalPath,
      entry.scope,
      entry.sourceKind,
      entry.sourceRef,
      entry.confidence,
      entry.promotedTo,
      entry.deprecatedBy,
      entry.metadata
    ]
  );
  logInfo("DB upsert memory entry completed.", {
    entryId: entry.id
  });
}

export async function recordMemoryRefinementOpinion(
  pool: pg.Pool,
  opinion: MemoryRefinementOpinionInsert
) {
  const id = randomUUID();
  logInfo("DB record memory refinement opinion started.", {
    opinionId: id,
    entryId: opinion.entryId,
    opinionType: opinion.opinionType
  });

  const result = await pool.query(
    `INSERT INTO memory_refinement_opinions (
      id, entry_id, opinion_type, body, suggested_patch, source_kind, source_ref, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      id,
      opinion.entryId,
      opinion.opinionType,
      opinion.body,
      opinion.suggestedPatch,
      opinion.sourceKind,
      opinion.sourceRef,
      opinion.metadata
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Memory refinement opinion insert returned no row.");
  }

  logInfo("DB record memory refinement opinion completed.", {
    opinionId: id,
    entryId: opinion.entryId
  });
  return mapMemoryRefinementOpinionRow(row);
}

export async function listOpenMemoryRefinementOpinions(
  pool: pg.Pool,
  entryIds: string[],
  limitPerEntry: number
) {
  if (entryIds.length === 0) {
    return [];
  }

  logInfo("DB list open memory refinement opinions started.", {
    entryCount: entryIds.length,
    limitPerEntry
  });

  const result = await pool.query(
    `WITH ranked_opinions AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY created_at DESC) AS row_rank
      FROM memory_refinement_opinions
      WHERE entry_id = ANY($1)
        AND status = 'open'
    )
    SELECT *
    FROM ranked_opinions
    WHERE row_rank <= $2
    ORDER BY entry_id, created_at DESC`,
    [entryIds, limitPerEntry]
  );

  logInfo("DB list open memory refinement opinions completed.", {
    entryCount: entryIds.length,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryRefinementOpinionRow);
}

export async function recordMemoryUsageEvents(pool: pg.Pool, events: MemoryUsageEventInsert[]) {
  if (events.length === 0) {
    return 0;
  }

  logInfo("DB record memory usage events started.", {
    eventCount: events.length
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of events) {
      await client.query(
        `INSERT INTO memory_usage_events (
          id, entry_id, event_type, source_kind, source_ref, task, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          event.entryId,
          event.eventType,
          event.sourceKind,
          event.sourceRef,
          event.task,
          event.metadata
        ]
      );

      if (shouldIncrementUseCount(event.eventType)) {
        await client.query(
          `UPDATE memory_entries
            SET use_count = use_count + 1,
                last_used_at = now(),
                updated_at = now()
            WHERE id = $1`,
          [event.entryId]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  logInfo("DB record memory usage events completed.", {
    eventCount: events.length
  });
  return events.length;
}

export async function replaceMemoryChunks(pool: pg.Pool, entryId: string, chunks: MemoryChunkInsert[]) {
  logInfo("DB replace memory chunks started.", {
    entryId,
    chunkCount: chunks.length
  });
  await pool.query("DELETE FROM memory_chunks WHERE entry_id = $1", [entryId]);

  for (const chunk of chunks) {
    const embeddingLiteral = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null;
    await pool.query(
      `INSERT INTO memory_chunks (
        entry_id, chunk_index, chunk_kind, content, embedding, token_estimate, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        chunk.entryId,
        chunk.chunkIndex,
        chunk.chunkKind,
        chunk.content,
        embeddingLiteral,
        chunk.tokenEstimate,
        chunk.metadata
      ]
    );
  }
  logInfo("DB replace memory chunks completed.", {
    entryId,
    chunkCount: chunks.length
  });
}

export async function findMemoryEntry(pool: pg.Pool, id: string) {
  logInfo("DB find memory entry started.", {
    entryId: id
  });
  const result = await pool.query("SELECT * FROM memory_entries WHERE id = $1", [id]);
  const row = result.rows[0];
  logInfo("DB find memory entry completed.", {
    entryId: id,
    found: Boolean(row)
  });
  return row ? mapMemoryEntryRow(row) : undefined;
}

export async function updateMemoryStatus(
  pool: pg.Pool,
  id: string,
  acceptanceState: string,
  updates: { deprecatedBy?: string; promotedTo?: string } = {}
) {
  logInfo("DB update memory status started.", {
    entryId: id,
    acceptanceState,
    deprecatedBy: updates.deprecatedBy,
    promotedTo: updates.promotedTo
  });
  await pool.query(
    `UPDATE memory_entries
      SET status = $2,
          acceptance_state = $2,
          deprecated_by = COALESCE($3, deprecated_by),
          promoted_to = COALESCE($4, promoted_to),
          updated_at = now()
      WHERE id = $1`,
    [id, acceptanceState, updates.deprecatedBy, updates.promotedTo]
  );
  logInfo("DB update memory status completed.", {
    entryId: id,
    acceptanceState
  });
}

export async function listRecentMemoryEntries(pool: pg.Pool, limit: number) {
  logInfo("DB list recent memory entries started.", {
    limit
  });
  const result = await pool.query(
    "SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT $1",
    [limit]
  );
  logInfo("DB list recent memory entries completed.", {
    limit,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function listMemoryEntriesByStatus(pool: pg.Pool, status: string, limit: number) {
  logInfo("DB list memory entries by status started.", {
    status,
    limit
  });
  const result = await pool.query(
    "SELECT * FROM memory_entries WHERE status = $1 ORDER BY updated_at DESC LIMIT $2",
    [status, limit]
  );
  logInfo("DB list memory entries by status completed.", {
    status,
    limit,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function listAllMemoryEntriesByStatus(pool: pg.Pool, status: string) {
  logInfo("DB list all memory entries by status started.", {
    status
  });
  const result = await pool.query(
    "SELECT * FROM memory_entries WHERE status = $1 ORDER BY updated_at DESC",
    [status]
  );
  logInfo("DB list all memory entries by status completed.", {
    status,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function listMemoryEntriesByAcceptanceState(pool: pg.Pool, acceptanceState: string, limit: number) {
  logInfo("DB list memory entries by acceptance state started.", {
    acceptanceState,
    limit
  });
  const result = await pool.query(
    "SELECT * FROM memory_entries WHERE acceptance_state = $1 ORDER BY updated_at DESC LIMIT $2",
    [acceptanceState, limit]
  );
  logInfo("DB list memory entries by acceptance state completed.", {
    acceptanceState,
    limit,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function listAllMemoryEntriesByAcceptanceState(pool: pg.Pool, acceptanceState: string) {
  logInfo("DB list all memory entries by acceptance state started.", {
    acceptanceState
  });
  const result = await pool.query(
    "SELECT * FROM memory_entries WHERE acceptance_state = $1 ORDER BY updated_at DESC",
    [acceptanceState]
  );
  logInfo("DB list all memory entries by acceptance state completed.", {
    acceptanceState,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function getDatabaseStatus(pool: pg.Pool) {
  logInfo("DB status query started.");
  const result = await pool.query(
    `SELECT
      (SELECT COUNT(*)::int FROM memory_entries) AS memory_entry_count,
      (SELECT COUNT(*)::int FROM memory_chunks) AS memory_chunk_count,
      (SELECT COUNT(*)::int FROM ontology_terms) AS ontology_term_count,
      (SELECT COUNT(*)::int FROM ontology_proposals) AS ontology_proposal_count,
      (SELECT COUNT(*)::int FROM memory_usage_events) AS memory_usage_event_count,
      (SELECT COUNT(*)::int FROM memory_refinement_opinions) AS memory_refinement_opinion_count`
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Database status query returned no rows.");
  }

  const status = {
    memoryEntryCount: Number(row.memory_entry_count),
    memoryChunkCount: Number(row.memory_chunk_count),
    ontologyTermCount: Number(row.ontology_term_count),
    ontologyProposalCount: Number(row.ontology_proposal_count),
    memoryUsageEventCount: Number(row.memory_usage_event_count),
    memoryRefinementOpinionCount: Number(row.memory_refinement_opinion_count)
  };
  logInfo("DB status query completed.", status);
  return status;
}

function mapMemoryRefinementOpinionRow(row: pg.QueryResultRow): MemoryRefinementOpinionRecord {
  const opinionType = refinementOpinionTypeSchema.parse(row.opinion_type);
  const status = refinementOpinionStatusSchema.parse(row.status);
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    opinionType,
    status,
    body: String(row.body),
    suggestedPatch: readOptionalRecord(row.suggested_patch, "suggested_patch"),
    sourceKind: String(row.source_kind),
    sourceRef: typeof row.source_ref === "string" ? row.source_ref : undefined,
    metadata: readRecord(row.metadata, "metadata"),
    createdAt: readTimestamp(row.created_at, "created_at"),
    updatedAt: readTimestamp(row.updated_at, "updated_at")
  };
}

function shouldIncrementUseCount(eventType: MemoryUsageEventType) {
  const parsedEventType = memoryUsageEventTypeSchema.parse(eventType);
  return parsedEventType === "composed" || parsedEventType === "applied" || parsedEventType === "user_helpful";
}

export async function searchMemoryEntriesLexical(pool: pg.Pool, query: string, filters: MemorySearchFilters) {
  logInfo("DB lexical memory search started.", {
    query,
    limit: filters.limit
  });
  const values: unknown[] = [`%${query}%`, filters.limit];
  const conditions = [
    "(e.title ILIKE $1 OR e.summary ILIKE $1 OR c.content ILIKE $1)"
  ];

  appendSearchFilters(conditions, values, filters);

  const result = await pool.query(
    `SELECT DISTINCT e.*, MAX(
      CASE
        WHEN e.title ILIKE $1 THEN 4
        WHEN e.summary ILIKE $1 THEN 2
        ELSE 1
      END
    ) AS lexical_rank
    FROM memory_entries e
    JOIN memory_chunks c ON c.entry_id = e.id
    WHERE ${conditions.join(" AND ")}
    GROUP BY e.id
    ORDER BY lexical_rank DESC, e.updated_at DESC
    LIMIT $2`,
    values
  );

  logInfo("DB lexical memory search completed.", {
    query,
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function searchMemoryEntriesVector(
  pool: pg.Pool,
  embedding: number[],
  filters: MemorySearchFilters
) {
  logInfo("DB vector memory search started.", {
    limit: filters.limit,
    embeddingDimension: embedding.length
  });
  const values: unknown[] = [`[${embedding.join(",")}]`, filters.limit];
  const conditions = ["c.embedding IS NOT NULL"];
  appendSearchFilters(conditions, values, filters);

  const result = await pool.query(
    `SELECT *
    FROM (
      SELECT DISTINCT ON (e.id)
        e.*,
        1 - (c.embedding <=> $1::vector) AS vector_score
      FROM memory_entries e
      JOIN memory_chunks c ON c.entry_id = e.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY e.id, c.embedding <=> $1::vector
    ) ranked_entries
    ORDER BY vector_score DESC
    LIMIT $2`,
    values
  );

  logInfo("DB vector memory search completed.", {
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

function appendSearchFilters(conditions: string[], values: unknown[], filters: MemorySearchFilters) {
  if (!filters.includeDeprecated) {
    conditions.push("e.acceptance_state <> 'deprecated'");
  }

  const acceptanceStates = filters.acceptanceStates ?? filters.status;
  if (acceptanceStates && acceptanceStates.length > 0) {
    values.push(acceptanceStates);
    conditions.push(`e.acceptance_state = ANY($${values.length})`);
  }

  if (filters.reviewStates && filters.reviewStates.length > 0) {
    values.push(filters.reviewStates);
    conditions.push(`e.review_state = ANY($${values.length})`);
  }

  if (filters.decisionStates && filters.decisionStates.length > 0) {
    values.push(filters.decisionStates);
    conditions.push(`e.decision_state = ANY($${values.length})`);
  }

  if (filters.types && filters.types.length > 0) {
    values.push(filters.types);
    conditions.push(`e.type = ANY($${values.length})`);
  }

  if (filters.domains && filters.domains.length > 0) {
    values.push(filters.domains);
    conditions.push(`e.metadata->'domains' ?| $${values.length}`);
  }

  if (filters.intents && filters.intents.length > 0) {
    values.push(filters.intents);
    conditions.push(`e.metadata->'intents' ?| $${values.length}`);
  }

  if (filters.modes && filters.modes.length > 0) {
    values.push(filters.modes);
    conditions.push(`e.metadata->'modes' ?| $${values.length}`);
  }
}

function mapMemoryEntryRow(row: pg.QueryResultRow): MemoryEntryRecord {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const acceptanceState = readAcceptanceState(row.acceptance_state, row.status);
  const reviewState = readReviewState(row.review_state, metadata.review_state);
  const decisionState = readDecisionState(row.decision_state);
  const entry: MemoryEntryRecord = {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    acceptanceState,
    reviewState,
    decisionState,
    title: String(row.title),
    summary: typeof row.summary === "string" ? row.summary : undefined,
    canonicalPath: String(row.canonical_path),
    scope: String(row.scope),
    sourceKind: typeof row.source_kind === "string" ? row.source_kind : undefined,
    sourceRef: typeof row.source_ref === "string" ? row.source_ref : undefined,
    confidence: Number(row.confidence),
    promotedTo: typeof row.promoted_to === "string" ? row.promoted_to : undefined,
    deprecatedBy: typeof row.deprecated_by === "string" ? row.deprecated_by : undefined,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : undefined,
    project: readProjectContext(metadata.project),
    metadata
  };

  if (typeof row.lexical_rank === "number") {
    entry.lexicalRank = row.lexical_rank;
  }
  if (typeof row.vector_score === "number") {
    entry.vectorScore = row.vector_score;
  }

  return entry;
}

function readAcceptanceState(primaryValue: unknown, fallbackValue: unknown): MemoryEntryRecord["acceptanceState"] {
  const primaryResult = acceptanceStateSchema.safeParse(primaryValue);
  if (primaryResult.success) {
    return primaryResult.data;
  }

  const fallbackResult = acceptanceStateSchema.safeParse(fallbackValue);
  return fallbackResult.success ? fallbackResult.data : "candidate";
}

function readReviewState(primaryValue: unknown, fallbackValue: unknown): MemoryEntryRecord["reviewState"] {
  const primaryResult = reviewStateSchema.safeParse(primaryValue);
  if (primaryResult.success) {
    return primaryResult.data;
  }

  const fallbackResult = reviewStateSchema.safeParse(fallbackValue);
  return fallbackResult.success ? fallbackResult.data : "unreviewed";
}

function readDecisionState(value: unknown): MemoryEntryRecord["decisionState"] {
  const result = decisionStateSchema.safeParse(value);
  return result.success ? result.data : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, columnName: string) {
  if (!isRecord(value)) {
    throw new Error(`Expected ${columnName} to be a JSON object.`);
  }
  return value;
}

function readOptionalRecord(value: unknown, columnName: string) {
  if (value === null || typeof value === "undefined") {
    return undefined;
  }
  return readRecord(value, columnName);
}

function readTimestamp(value: unknown, columnName: string) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`Expected ${columnName} to be a timestamp.`);
}

function readProjectContext(value: unknown): ProjectContext | undefined {
  if (typeof value === "string" && value.length > 0) {
    return { name: value };
  }

  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return undefined;
  }

  const project: ProjectContext = { name: value.name };
  if (typeof value.repo === "string" && value.repo.length > 0) {
    project.repo = value.repo;
  }
  if (typeof value.root === "string" && value.root.length > 0) {
    project.root = value.root;
  }
  return project;
}

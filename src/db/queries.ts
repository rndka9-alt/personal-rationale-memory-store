import type pg from "pg";
import { logInfo } from "../diagnostics/index.js";
import type { MemoryEntryRecord, MemorySearchFilters } from "../memory/schema.js";

export type MemoryChunkInsert = {
  entryId: string;
  chunkIndex: number;
  chunkKind: string;
  content: string;
  embedding?: number[];
  tokenEstimate: number;
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
      id, type, status, title, summary, canonical_path, scope, source_kind, source_ref,
      confidence, promoted_to, deprecated_by, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      status = EXCLUDED.status,
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
  status: string,
  updates: { deprecatedBy?: string; promotedTo?: string } = {}
) {
  logInfo("DB update memory status started.", {
    entryId: id,
    status,
    deprecatedBy: updates.deprecatedBy,
    promotedTo: updates.promotedTo
  });
  await pool.query(
    `UPDATE memory_entries
      SET status = $2,
          deprecated_by = COALESCE($3, deprecated_by),
          promoted_to = COALESCE($4, promoted_to),
          updated_at = now()
      WHERE id = $1`,
    [id, status, updates.deprecatedBy, updates.promotedTo]
  );
  logInfo("DB update memory status completed.", {
    entryId: id,
    status
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
    `SELECT DISTINCT ON (e.id)
      e.*,
      1 - (c.embedding <=> $1::vector) AS vector_score
    FROM memory_entries e
    JOIN memory_chunks c ON c.entry_id = e.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.id, c.embedding <=> $1::vector
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
    conditions.push("e.status <> 'deprecated'");
  }

  if (filters.status && filters.status.length > 0) {
    values.push(filters.status);
    conditions.push(`e.status = ANY($${values.length})`);
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
  return {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    title: String(row.title),
    summary: typeof row.summary === "string" ? row.summary : undefined,
    canonicalPath: String(row.canonical_path),
    scope: String(row.scope),
    sourceKind: typeof row.source_kind === "string" ? row.source_kind : undefined,
    sourceRef: typeof row.source_ref === "string" ? row.source_ref : undefined,
    confidence: Number(row.confidence),
    promotedTo: typeof row.promoted_to === "string" ? row.promoted_to : undefined,
    deprecatedBy: typeof row.deprecated_by === "string" ? row.deprecated_by : undefined,
    metadata: isRecord(row.metadata) ? row.metadata : {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


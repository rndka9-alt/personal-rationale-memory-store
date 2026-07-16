import { randomUUID } from "node:crypto";
import type pg from "pg";
import { logInfo } from "../diagnostics/index.js";
import {
  acceptanceStateSchema,
  decisionStateSchema,
  memoryUsageEventTypeSchema,
  reviewStateSchema,
  type MemoryEntryRecord,
  type MemoryRevisionRecord,
  type MemorySearchFilters,
  type MemoryUsageEventType,
  type NoteRating,
  type NoteRecord,
  noteSourceConversationSchema,
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

export type QueryExecutor = Pick<pg.Pool, "query">;

export type MemoryUsageEventInsert = {
  entryId: string;
  revisionId: string;
  eventType: MemoryUsageEventType;
  sourceKind: string;
  sourceRef?: string;
  task?: string;
  metadata: Record<string, unknown>;
};

export type MemoryUsageFeedbackCounts = {
  appliedCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  dismissedCount: number;
  positiveCount: number;
  negativeCount: number;
};

export type MemoryRevisionInsert = {
  id: string;
  entryId: string;
  revisionNumber: number;
  content: string;
  reason: string;
  metadata: Record<string, unknown>;
};

export type NoteInsert = {
  id: string;
  content: string;
  topic?: string;
  sourceConversation?: NoteRecord["sourceConversation"];
};

export type NoteListOptions = {
  includeArchived: boolean;
  search?: string;
  sortMode: "newest" | "oldest";
  page: number;
  pageSize: number;
};

export type ReviewQueueMemoryListOptions = {
  captureKind?: string;
  reviewState?: string;
  search?: string;
};

export type ReviewQueueMemoryPageOptions = ReviewQueueMemoryListOptions & {
  page: number;
  pageSize: number;
};

export type MemoryCatalogStatus = "current" | "deprecated" | "all";

export type MemoryCatalogSortMode = "created" | "last_used" | "uses";

export type MemoryCatalogPageOptions = {
  status: MemoryCatalogStatus;
  search?: string;
  sortMode: MemoryCatalogSortMode;
  page: number;
  pageSize: number;
};

export type RationaleContentFingerprintClaim =
  | { status: "claimed"; entryId: string }
  | { status: "processing"; entryId: string }
  | { status: "completed"; entry: MemoryEntryRecord }
  | { status: "failed"; entryId: string; failureReason?: string };

export async function claimRationaleContentFingerprint(
  pool: pg.Pool,
  contentFingerprint: string,
  entryId: string
): Promise<RationaleContentFingerprintClaim> {
  logInfo("DB claim rationale content fingerprint started.", {
    entryId,
    contentFingerprint
  });

  const inserted = await pool.query(
    `INSERT INTO rationale_content_fingerprints (content_fingerprint, entry_id, status)
    VALUES ($1, $2, 'processing')
    ON CONFLICT (content_fingerprint) DO NOTHING
    RETURNING entry_id`,
    [contentFingerprint, entryId]
  );

  if (inserted.rows.length > 0) {
    logInfo("DB claim rationale content fingerprint completed.", {
      entryId,
      contentFingerprint,
      status: "claimed"
    });
    return { status: "claimed", entryId };
  }

  const existing = await findRationaleContentFingerprint(pool, contentFingerprint);
  if (existing.status === "failed") {
    const reclaimed = await pool.query(
      `UPDATE rationale_content_fingerprints
        SET entry_id = $2,
            status = 'processing',
            failure_reason = NULL,
            updated_at = now()
        WHERE content_fingerprint = $1
          AND status = 'failed'
        RETURNING entry_id`,
      [contentFingerprint, entryId]
    );

    if (reclaimed.rows.length > 0) {
      logInfo("DB claim rationale content fingerprint completed.", {
        entryId,
        contentFingerprint,
        previousEntryId: existing.entryId,
        status: "claimed"
      });
      return { status: "claimed", entryId };
    }
  }

  const current = existing.status === "failed"
    ? await findRationaleContentFingerprint(pool, contentFingerprint)
    : existing;
  logInfo("DB claim rationale content fingerprint completed.", {
    entryId,
    contentFingerprint,
    status: current.status,
    existingEntryId: current.status === "completed" ? current.entry.id : current.entryId
  });
  return current;
}

export async function completeRationaleContentFingerprint(
  pool: pg.Pool,
  contentFingerprint: string,
  entryId: string
) {
  logInfo("DB complete rationale content fingerprint started.", {
    entryId,
    contentFingerprint
  });
  const result = await pool.query(
    `UPDATE rationale_content_fingerprints
      SET status = 'completed',
          failure_reason = NULL,
          updated_at = now()
      WHERE content_fingerprint = $1
        AND entry_id = $2
      RETURNING entry_id`,
    [contentFingerprint, entryId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Rationale content fingerprint claim was not found for ${entryId}.`);
  }

  logInfo("DB complete rationale content fingerprint completed.", {
    entryId,
    contentFingerprint
  });
}

export async function failRationaleContentFingerprint(
  pool: pg.Pool,
  contentFingerprint: string,
  entryId: string,
  failureReason: string
) {
  logInfo("DB fail rationale content fingerprint started.", {
    entryId,
    contentFingerprint
  });
  await pool.query(
    `UPDATE rationale_content_fingerprints
      SET status = 'failed',
          failure_reason = $3,
          updated_at = now()
      WHERE content_fingerprint = $1
        AND entry_id = $2`,
    [contentFingerprint, entryId, failureReason]
  );
  logInfo("DB fail rationale content fingerprint completed.", {
    entryId,
    contentFingerprint
  });
}

export async function syncCompletedRationaleContentFingerprint(
  pool: pg.Pool,
  contentFingerprint: string,
  entryId: string
) {
  logInfo("DB sync completed rationale content fingerprint started.", {
    entryId,
    contentFingerprint
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await syncCompletedRationaleContentFingerprintWithExecutor(client, contentFingerprint, entryId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  logInfo("DB sync completed rationale content fingerprint completed.", {
    entryId,
    contentFingerprint
  });
}

export async function syncCompletedRationaleContentFingerprintWithExecutor(
  executor: QueryExecutor,
  contentFingerprint: string,
  entryId: string
) {
  await executor.query(
    `DELETE FROM rationale_content_fingerprints
    WHERE entry_id = $1
      AND content_fingerprint <> $2`,
    [entryId, contentFingerprint]
  );
  await executor.query(
    `INSERT INTO rationale_content_fingerprints (content_fingerprint, entry_id, status)
    VALUES ($1, $2, 'completed')
    ON CONFLICT (content_fingerprint) DO UPDATE SET
      entry_id = EXCLUDED.entry_id,
      status = 'completed',
      failure_reason = NULL,
      updated_at = now()
    WHERE rationale_content_fingerprints.entry_id = EXCLUDED.entry_id
      OR rationale_content_fingerprints.status = 'failed'`,
    [contentFingerprint, entryId]
  );
}

export async function upsertMemoryEntry(executor: QueryExecutor, entry: MemoryEntryRecord) {
  logInfo("DB upsert memory entry started.", {
    entryId: entry.id,
    status: entry.status,
    type: entry.type
  });
  await executor.query(
    `INSERT INTO memory_entries (
      id, type, status, acceptance_state, review_state, decision_state, title, summary, canonical_path, scope, source_kind, source_ref,
      confidence, promoted_to, deprecated_by, metadata, current_revision_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      current_revision_id = COALESCE(EXCLUDED.current_revision_id, memory_entries.current_revision_id),
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
      entry.metadata,
      entry.currentRevisionId
    ]
  );
  logInfo("DB upsert memory entry completed.", {
    entryId: entry.id
  });
}

export async function insertMemoryRevision(executor: QueryExecutor, revision: MemoryRevisionInsert) {
  logInfo("DB insert memory revision started.", {
    revisionId: revision.id,
    entryId: revision.entryId,
    revisionNumber: revision.revisionNumber
  });
  const result = await executor.query(
    `INSERT INTO memory_revisions (
      id, entry_id, revision_number, content, reason, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      revision.id,
      revision.entryId,
      revision.revisionNumber,
      revision.content,
      revision.reason,
      revision.metadata
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Memory revision insert returned no row.");
  }
  logInfo("DB insert memory revision completed.", {
    revisionId: revision.id,
    entryId: revision.entryId
  });
  return mapMemoryRevisionRow(row);
}

export async function findMemoryRevision(executor: QueryExecutor, id: string) {
  logInfo("DB find memory revision started.", {
    revisionId: id
  });
  const result = await executor.query("SELECT * FROM memory_revisions WHERE id = $1", [id]);
  const row = result.rows[0];
  logInfo("DB find memory revision completed.", {
    revisionId: id,
    found: Boolean(row)
  });
  return row ? mapMemoryRevisionRow(row) : undefined;
}

export async function findLatestMemoryRevision(executor: QueryExecutor, entryId: string) {
  logInfo("DB find latest memory revision started.", {
    entryId
  });
  const result = await executor.query(
    `SELECT *
    FROM memory_revisions
    WHERE entry_id = $1
    ORDER BY revision_number DESC
    LIMIT 1`,
    [entryId]
  );
  const row = result.rows[0];
  logInfo("DB find latest memory revision completed.", {
    entryId,
    found: Boolean(row)
  });
  return row ? mapMemoryRevisionRow(row) : undefined;
}

export async function lockMemoryEntryForUpdate(executor: QueryExecutor, id: string) {
  logInfo("DB lock memory entry for update started.", {
    entryId: id
  });
  const result = await executor.query("SELECT * FROM memory_entries WHERE id = $1 FOR UPDATE", [id]);
  const row = result.rows[0];
  logInfo("DB lock memory entry for update completed.", {
    entryId: id,
    found: Boolean(row)
  });
  return row ? mapMemoryEntryRow(row) : undefined;
}

export async function setMemoryEntryCurrentRevision(executor: QueryExecutor, entryId: string, revisionId: string) {
  logInfo("DB set memory entry current revision started.", {
    entryId,
    revisionId
  });
  const result = await executor.query(
    `UPDATE memory_entries
    SET current_revision_id = $2,
        updated_at = now()
    WHERE id = $1
    RETURNING *`,
    [entryId, revisionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Memory entry not found while setting current revision: ${entryId}`);
  }
  logInfo("DB set memory entry current revision completed.", {
    entryId,
    revisionId
  });
  return mapMemoryEntryRow(row);
}

export async function insertNote(pool: pg.Pool, note: NoteInsert) {
  logInfo("DB insert note started.", {
    noteId: note.id,
    contentLength: note.content.length
  });
  const result = await pool.query(
    `INSERT INTO notes (id, content, topic, source_conversation)
    VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [note.id, note.content, note.topic, note.sourceConversation]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Note insert returned no row.");
  }
  logInfo("DB insert note completed.", {
    noteId: note.id
  });
  return mapNoteRow(row);
}

export async function incrementNoteRating(pool: pg.Pool, noteId: string, rating: NoteRating) {
  logInfo("DB increment note rating started.", {
    noteId,
    rating
  });
  const result = rating === "up"
    ? await pool.query(
      `UPDATE notes
        SET upvotes = upvotes + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [noteId]
    )
    : await pool.query(
      `UPDATE notes
        SET downvotes = downvotes + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [noteId]
    );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Note not found: ${noteId}`);
  }
  logInfo("DB increment note rating completed.", {
    noteId,
    rating
  });
  return mapNoteRow(row);
}

export async function archiveNoteRecord(pool: pg.Pool, noteId: string) {
  logInfo("DB archive note started.", {
    noteId
  });
  const result = await pool.query(
    `UPDATE notes
      SET archived = TRUE,
          updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [noteId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Note not found: ${noteId}`);
  }
  logInfo("DB archive note completed.", {
    noteId
  });
  return mapNoteRow(row);
}

export async function restoreNoteRecord(pool: pg.Pool, noteId: string) {
  logInfo("DB restore note started.", {
    noteId
  });
  const result = await pool.query(
    `UPDATE notes
      SET archived = FALSE,
          updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [noteId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Note not found: ${noteId}`);
  }
  logInfo("DB restore note completed.", {
    noteId
  });
  return mapNoteRow(row);
}

export async function listActiveNotes(pool: pg.Pool) {
  logInfo("DB list active notes started.");
  const result = await pool.query(
    "SELECT * FROM notes WHERE archived = FALSE ORDER BY created_at DESC"
  );
  logInfo("DB list active notes completed.", {
    resultCount: result.rows.length
  });
  return result.rows.map(mapNoteRow);
}

export async function listNotes(pool: pg.Pool, options: NoteListOptions) {
  logInfo("DB list notes started.", {
    includeArchived: options.includeArchived,
    hasSearch: Boolean(options.search),
    sortMode: options.sortMode,
    page: options.page,
    pageSize: options.pageSize
  });

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (!options.includeArchived) {
    conditions.push("archived = FALSE");
  }
  if (options.search) {
    values.push(`%${escapeLikePattern(options.search)}%`);
    conditions.push(`(topic ILIKE $${values.length} ESCAPE '!' OR content ILIKE $${values.length} ESCAPE '!')`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDirection = options.sortMode === "oldest" ? "ASC" : "DESC";
  const pageValues = [...values, options.pageSize, (options.page - 1) * options.pageSize];
  const [countResult, result] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total_count FROM notes ${whereClause}`, values),
    pool.query(
      `SELECT * FROM notes
      ${whereClause}
      ORDER BY created_at ${orderDirection}, id ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues
    )
  ]);
  const countRow = countResult.rows[0];
  if (!countRow) {
    throw new Error("Note count query returned no rows.");
  }
  const totalItems = Number(countRow.total_count);
  logInfo("DB list notes completed.", {
    includeArchived: options.includeArchived,
    totalItems,
    resultCount: result.rows.length
  });
  return {
    notes: result.rows.map(mapNoteRow),
    totalItems
  };
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
          id, entry_id, revision_id, event_type, source_kind, source_ref, task, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          event.entryId,
          event.revisionId,
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

export async function countMemoryUsageFeedback(pool: pg.Pool, entryIds: string[]) {
  if (entryIds.length === 0) {
    return new Map<string, MemoryUsageFeedbackCounts>();
  }

  logInfo("DB count memory usage feedback started.", {
    entryCount: entryIds.length
  });

  const result = await pool.query(
    `SELECT entry_id, event_type, COUNT(*)::int AS event_count
    FROM memory_usage_events
    WHERE entry_id = ANY($1)
      AND event_type = ANY($2)
    GROUP BY entry_id, event_type`,
    [entryIds, ["applied", "user_helpful", "user_unhelpful", "dismissed"]]
  );

  const counts = new Map<string, MemoryUsageFeedbackCounts>();
  for (const row of result.rows) {
    const entryId = String(row.entry_id);
    const feedbackCounts = counts.get(entryId) ?? createEmptyMemoryUsageFeedbackCounts();
    applyUsageFeedbackCount(feedbackCounts, String(row.event_type), Number(row.event_count));
    counts.set(entryId, feedbackCounts);
  }

  logInfo("DB count memory usage feedback completed.", {
    entryCount: entryIds.length,
    resultCount: result.rows.length
  });
  return counts;
}

export async function replaceMemoryChunks(executor: QueryExecutor, entryId: string, chunks: MemoryChunkInsert[]) {
  logInfo("DB replace memory chunks started.", {
    entryId,
    chunkCount: chunks.length
  });
  await executor.query("DELETE FROM memory_chunks WHERE entry_id = $1", [entryId]);

  for (const chunk of chunks) {
    const embeddingLiteral = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null;
    await executor.query(
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

export async function findMemoryEntry(executor: QueryExecutor, id: string) {
  logInfo("DB find memory entry started.", {
    entryId: id
  });
  const result = await executor.query("SELECT * FROM memory_entries WHERE id = $1", [id]);
  const row = result.rows[0];
  logInfo("DB find memory entry completed.", {
    entryId: id,
    found: Boolean(row)
  });
  return row ? mapMemoryEntryRow(row) : undefined;
}

async function findRationaleContentFingerprint(
  pool: pg.Pool,
  contentFingerprint: string
): Promise<Exclude<RationaleContentFingerprintClaim, { status: "claimed" }>> {
  const result = await pool.query(
    `SELECT
      fingerprint.entry_id AS fingerprint_entry_id,
      fingerprint.status AS fingerprint_status,
      fingerprint.failure_reason AS fingerprint_failure_reason,
      entry.*
    FROM rationale_content_fingerprints fingerprint
    LEFT JOIN memory_entries entry ON entry.id = fingerprint.entry_id
    WHERE fingerprint.content_fingerprint = $1`,
    [contentFingerprint]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Rationale content fingerprint disappeared before it could be read: ${contentFingerprint}`);
  }

  if (row.fingerprint_status === "completed") {
    if (typeof row.id !== "string") {
      throw new Error(`Completed rationale content fingerprint has no memory entry: ${contentFingerprint}`);
    }
    return { status: "completed", entry: mapMemoryEntryRow(row) };
  }

  if (row.fingerprint_status === "processing") {
    return { status: "processing", entryId: String(row.fingerprint_entry_id) };
  }

  if (row.fingerprint_status === "failed") {
    const failureReason = typeof row.fingerprint_failure_reason === "string"
      ? row.fingerprint_failure_reason
      : undefined;
    return { status: "failed", entryId: String(row.fingerprint_entry_id), failureReason };
  }

  throw new Error(`Unexpected rationale content fingerprint status: ${String(row.fingerprint_status)}`);
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

export async function listReviewQueueMemoryEntries(
  pool: pg.Pool,
  options: ReviewQueueMemoryListOptions
) {
  logInfo("DB list review queue memory entries started.", {
    captureKind: options.captureKind,
    reviewState: options.reviewState,
    hasSearch: Boolean(options.search)
  });
  const query = createReviewQueueMemoryQuery(options);

  const result = await pool.query(
    `SELECT e.*
    FROM memory_entries e
    WHERE ${query.conditions.join(" AND ")}
    ORDER BY e.created_at DESC, e.id ASC`,
    query.values
  );
  logInfo("DB list review queue memory entries completed.", {
    resultCount: result.rows.length
  });
  return result.rows.map(mapMemoryEntryRow);
}

export async function listReviewQueueMemoryPage(
  pool: pg.Pool,
  options: ReviewQueueMemoryPageOptions
) {
  logInfo("DB list paginated review queue memory entries started.", {
    captureKind: options.captureKind,
    reviewState: options.reviewState,
    hasSearch: Boolean(options.search),
    page: options.page,
    pageSize: options.pageSize
  });
  const query = createReviewQueueMemoryQuery(options);
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total_count
    FROM memory_entries e
    WHERE ${query.conditions.join(" AND ")}`,
    query.values
  );
  const countRow = countResult.rows[0];
  if (!countRow) {
    throw new Error("Review queue memory count query returned no rows.");
  }
  const totalItems = Number(countRow.total_count);
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const pageValues = [...query.values, options.pageSize, (page - 1) * options.pageSize];
  const result = await pool.query(
    `SELECT e.*
    FROM memory_entries e
    WHERE ${query.conditions.join(" AND ")}
    ORDER BY e.created_at DESC, e.id ASC
    LIMIT $${query.values.length + 1} OFFSET $${query.values.length + 2}`,
    pageValues
  );
  logInfo("DB list paginated review queue memory entries completed.", {
    page,
    pageSize: options.pageSize,
    totalItems,
    resultCount: result.rows.length
  });
  return {
    entries: result.rows.map(mapMemoryEntryRow),
    pagination: {
      page,
      pageSize: options.pageSize,
      totalItems,
      totalPages
    }
  };
}

export async function listMemoryCatalogPage(
  pool: pg.Pool,
  options: MemoryCatalogPageOptions
) {
  logInfo("DB list paginated memory catalog started.", {
    status: options.status,
    hasSearch: Boolean(options.search),
    sortMode: options.sortMode,
    page: options.page,
    pageSize: options.pageSize
  });
  const query = createMemoryCatalogQuery(options);
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total_count
    FROM memory_entries e
    WHERE ${query.conditions.join(" AND ")}`,
    query.values
  );
  const countRow = countResult.rows[0];
  if (!countRow) {
    throw new Error("Memory catalog count query returned no rows.");
  }

  const totalItems = Number(countRow.total_count);
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const pageValues = [...query.values, options.pageSize, (page - 1) * options.pageSize];
  const result = await pool.query(
    `SELECT e.*
    FROM memory_entries e
    WHERE ${query.conditions.join(" AND ")}
    ORDER BY ${memoryCatalogOrderBy(options.sortMode)}
    LIMIT $${query.values.length + 1} OFFSET $${query.values.length + 2}`,
    pageValues
  );

  logInfo("DB list paginated memory catalog completed.", {
    page,
    pageSize: options.pageSize,
    totalItems,
    resultCount: result.rows.length
  });
  return {
    entries: result.rows.map(mapMemoryEntryRow),
    pagination: {
      page,
      pageSize: options.pageSize,
      totalItems,
      totalPages
    }
  };
}

export type RetrievalQuerySourceKind = "search" | "compose";

export type RetrievalQueryEventInsert = {
  sourceKind: RetrievalQuerySourceKind;
  query: string;
  resultCount: number;
  topScore?: number;
  warningKinds: string[];
  projectName?: string;
  clientName?: string;
  clientVersion?: string;
  userAgent?: string;
};

export async function recordRetrievalQueryEvent(pool: pg.Pool, event: RetrievalQueryEventInsert) {
  await pool.query(
    `INSERT INTO retrieval_query_events (
      id, source_kind, query, result_count, top_score, warning_kinds, project_name,
      client_name, client_version, user_agent
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      event.sourceKind,
      event.query,
      event.resultCount,
      event.topScore,
      event.warningKinds,
      event.projectName,
      event.clientName,
      event.clientVersion,
      event.userAgent
    ]
  );
  logInfo("DB record retrieval query event completed.", {
    sourceKind: event.sourceKind,
    resultCount: event.resultCount
  });
}

export async function getRetrievalQueryStatus(pool: pg.Pool, windowDays = 7) {
  logInfo("DB retrieval query status started.", { windowDays });
  const countsResult = await pool.query(
    `SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE source_kind = 'search')::int AS search_count,
      COUNT(*) FILTER (WHERE source_kind = 'compose')::int AS compose_count,
      COUNT(*) FILTER (WHERE result_count = 0)::int AS zero_hit_count
    FROM retrieval_query_events
    WHERE created_at >= now() - make_interval(days => $1)`,
    [windowDays]
  );
  const countsRow = countsResult.rows[0];
  if (!countsRow) {
    throw new Error("Retrieval query status returned no rows.");
  }

  const zeroHitResult = await pool.query(
    `SELECT query, source_kind, project_name, created_at
    FROM retrieval_query_events
    WHERE result_count = 0 AND created_at >= now() - make_interval(days => $1)
    ORDER BY created_at DESC
    LIMIT 20`,
    [windowDays]
  );

  const zeroHitByProjectResult = await pool.query(
    `SELECT project_name, COUNT(*)::int AS zero_hit_count
    FROM retrieval_query_events
    WHERE result_count = 0 AND created_at >= now() - make_interval(days => $1)
    GROUP BY project_name
    ORDER BY zero_hit_count DESC
    LIMIT 10`,
    [windowDays]
  );

  const totalCount = Number(countsRow.total_count);
  const zeroHitCount = Number(countsRow.zero_hit_count);
  const status = {
    windowDays,
    totalCount,
    searchCount: Number(countsRow.search_count),
    composeCount: Number(countsRow.compose_count),
    zeroHitCount,
    zeroHitRate: totalCount > 0 ? zeroHitCount / totalCount : 0,
    recentZeroHitQueries: zeroHitResult.rows.map((row) => ({
      query: String(row.query),
      sourceKind: String(row.source_kind),
      // null means the caller did not pass a project filter for this query.
      projectName: row.project_name === null ? null : String(row.project_name),
      createdAt: new Date(row.created_at).toISOString()
    })),
    zeroHitByProject: zeroHitByProjectResult.rows.map((row) => ({
      projectName: row.project_name === null ? null : String(row.project_name),
      zeroHitCount: Number(row.zero_hit_count)
    }))
  };
  logInfo("DB retrieval query status completed.", {
    windowDays,
    totalCount,
    zeroHitCount
  });
  return status;
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
      (SELECT COUNT(*)::int FROM notes) AS note_count`
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
    noteCount: Number(row.note_count)
  };
  logInfo("DB status query completed.", status);
  return status;
}

function mapNoteRow(row: pg.QueryResultRow): NoteRecord {
  return {
    id: String(row.id),
    content: String(row.content),
    topic: readOptionalString(row.topic, "topic"),
    sourceConversation: readOptionalNoteSourceConversation(row.source_conversation),
    upvotes: Number(row.upvotes),
    downvotes: Number(row.downvotes),
    archived: Boolean(row.archived),
    createdAt: readTimestamp(row.created_at, "created_at"),
    updatedAt: readTimestamp(row.updated_at, "updated_at")
  };
}

function mapMemoryRevisionRow(row: pg.QueryResultRow): MemoryRevisionRecord {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    revisionNumber: Number(row.revision_number),
    content: String(row.content),
    reason: String(row.reason),
    metadata: readRecord(row.metadata, "metadata"),
    createdAt: readTimestamp(row.created_at, "created_at")
  };
}

function shouldIncrementUseCount(eventType: MemoryUsageEventType) {
  const parsedEventType = memoryUsageEventTypeSchema.parse(eventType);
  return parsedEventType === "applied" || parsedEventType === "user_helpful";
}

function createEmptyMemoryUsageFeedbackCounts(): MemoryUsageFeedbackCounts {
  return {
    appliedCount: 0,
    helpfulCount: 0,
    unhelpfulCount: 0,
    dismissedCount: 0,
    positiveCount: 0,
    negativeCount: 0
  };
}

function applyUsageFeedbackCount(
  counts: MemoryUsageFeedbackCounts,
  eventType: string,
  eventCount: number
) {
  if (eventType === "applied") {
    counts.appliedCount += eventCount;
    counts.positiveCount += eventCount;
    return;
  }

  if (eventType === "user_helpful") {
    counts.helpfulCount += eventCount;
    counts.positiveCount += eventCount;
    return;
  }

  if (eventType === "user_unhelpful") {
    counts.unhelpfulCount += eventCount;
    counts.negativeCount += eventCount;
    return;
  }

  if (eventType === "dismissed") {
    counts.dismissedCount += eventCount;
    counts.negativeCount += eventCount;
    return;
  }

  throw new Error(`Unexpected memory usage feedback event type: ${eventType}`);
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

  if (filters.excludeTypes && filters.excludeTypes.length > 0) {
    values.push(filters.excludeTypes);
    conditions.push(`NOT (e.type = ANY($${values.length}))`);
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
    currentRevisionId: typeof row.current_revision_id === "string" ? row.current_revision_id : undefined,
    scope: String(row.scope),
    sourceKind: typeof row.source_kind === "string" ? row.source_kind : undefined,
    sourceRef: typeof row.source_ref === "string" ? row.source_ref : undefined,
    confidence: Number(row.confidence),
    promotedTo: typeof row.promoted_to === "string" ? row.promoted_to : undefined,
    deprecatedBy: typeof row.deprecated_by === "string" ? row.deprecated_by : undefined,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : undefined,
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

function readOptionalString(value: unknown, columnName: string) {
  if (value === null || typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${columnName} to be a string.`);
  }
  return value;
}

function readOptionalNoteSourceConversation(value: unknown) {
  if (value === null || typeof value === "undefined") {
    return undefined;
  }
  return noteSourceConversationSchema.parse(value);
}

function createReviewQueueMemoryQuery(options: ReviewQueueMemoryListOptions) {
  const conditions = ["e.acceptance_state = 'candidate'"];
  const values: unknown[] = [];

  if (options.captureKind) {
    values.push(options.captureKind);
    conditions.push(`e.metadata->>'capture_kind' = $${values.length}`);
  }
  if (options.reviewState) {
    values.push(options.reviewState);
    conditions.push(`e.review_state = $${values.length}`);
  }
  if (options.search) {
    values.push(`%${escapeLikePattern(options.search)}%`);
    conditions.push(`(
      e.title ILIKE $${values.length} ESCAPE '!'
      OR EXISTS (
        SELECT 1
        FROM memory_chunks c
        WHERE c.entry_id = e.id
          AND c.content ILIKE $${values.length} ESCAPE '!'
      )
    )`);
  }

  return { conditions, values };
}

function createMemoryCatalogQuery(options: MemoryCatalogPageOptions) {
  const conditions = ["TRUE"];
  const values: unknown[] = [];

  if (options.status === "current") {
    conditions.push("e.acceptance_state <> 'deprecated'");
  } else if (options.status === "deprecated") {
    conditions.push("e.acceptance_state = 'deprecated'");
  }

  if (options.search) {
    values.push(`%${escapeLikePattern(options.search)}%`);
    conditions.push(`(
      e.title ILIKE $${values.length} ESCAPE '!'
      OR EXISTS (
        SELECT 1
        FROM memory_chunks c
        WHERE c.entry_id = e.id
          AND c.content ILIKE $${values.length} ESCAPE '!'
      )
    )`);
  }

  return { conditions, values };
}

function memoryCatalogOrderBy(sortMode: MemoryCatalogSortMode) {
  if (sortMode === "last_used") {
    return "e.last_used_at DESC NULLS LAST, e.created_at DESC, e.id ASC";
  }
  if (sortMode === "uses") {
    return "e.use_count DESC, e.created_at DESC, e.id ASC";
  }
  return "e.created_at DESC, e.id ASC";
}

function escapeLikePattern(value: string) {
  return value.replace(/[!%_]/g, "!$&");
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

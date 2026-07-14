import type pg from "pg";
import { z } from "zod";
import {
  countNewDigestNotes,
  digestLayerSchema,
  digestOperationSchema,
  digestProseSchema
} from "./digestService.js";

const digestStateId = "singleton";

const digestViewStateRowSchema = z.object({
  id: z.literal(digestStateId),
  note_cursor: z.string().nullable(),
  note_cursor_id: z.string().nullable(),
  prose: digestProseSchema,
  synthesized_at: z.coerce.date().nullable()
});

const digestViewClaimRowSchema = z.object({
  id: z.string(),
  layer: digestLayerSchema,
  text: z.string(),
  evidence_count: z.coerce.number().int().nonnegative(),
  sample_note_ids: z.array(z.string()),
  first_observed_at: z.coerce.date().nullable(),
  last_observed_at: z.coerce.date().nullable(),
  observed_days: z.coerce.number().int().nonnegative(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  deferred_target_layer: z.enum(["longterm", "about"]).nullable(),
  deferred_requested_at: z.coerce.date().nullable()
});

const digestSkippedOperationSchema = z.object({
  operation: digestOperationSchema,
  reason: z.string()
}).strict();

const digestDeferredEventSchema = z.object({
  action: z.enum(["queued", "applied", "removed", "retained"]),
  claimId: z.string(),
  targetLayer: z.enum(["longterm", "about"]),
  reason: z.string()
}).strict();

const digestRunRowSchema = z.object({
  id: z.string(),
  run_at: z.coerce.date(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().nullable(),
  new_note_count: z.coerce.number().int().nonnegative(),
  ops: z.array(digestOperationSchema),
  skipped_operations: z.array(digestSkippedOperationSchema),
  deferred_events: z.array(digestDeferredEventSchema),
  // run 시점 문구 스냅샷(claimId → text). 스냅샷 도입 이전 run은 빈 객체다.
  claim_texts: z.record(z.string()),
  prose_snapshot: digestProseSchema,
  run_kind: z.enum(["synthesis", "maintenance"])
});

export class DigestViewService {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async getDigest() {
    const [stateResult, claimsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, note_cursor::text AS note_cursor, note_cursor_id, prose, synthesized_at
        FROM digest_state
        WHERE id = $1`,
        [digestStateId]
      ),
      this.pool.query(
        `SELECT
          claims.id,
          claims.layer,
          claims.text,
          COUNT(evidence.note_id)::int AS evidence_count,
          COALESCE(
            (array_agg(evidence.note_id ORDER BY evidence.observed_at DESC, evidence.note_id DESC)
              FILTER (WHERE evidence.note_id IS NOT NULL))[1:5],
            '{}'::text[]
          ) AS sample_note_ids,
          MIN(evidence.observed_at) AS first_observed_at,
          MAX(evidence.observed_at) AS last_observed_at,
          COUNT(DISTINCT (evidence.observed_at AT TIME ZONE 'Asia/Seoul')::date)::int AS observed_days,
          claims.created_at,
          claims.updated_at,
          deferred.target_layer AS deferred_target_layer,
          deferred.requested_at AS deferred_requested_at
        FROM digest_claims AS claims
        LEFT JOIN digest_claim_evidence AS evidence ON evidence.claim_id = claims.id
        LEFT JOIN digest_deferred_promotions AS deferred ON deferred.claim_id = claims.id
        WHERE claims.retired_at IS NULL
        GROUP BY claims.id, deferred.target_layer, deferred.requested_at
        ORDER BY CASE claims.layer
          WHEN 'now' THEN 1
          WHEN 'recent' THEN 2
          WHEN 'longterm' THEN 3
          WHEN 'about' THEN 4
        END, MAX(evidence.observed_at) DESC NULLS LAST, claims.id ASC`
      )
    ]);

    const stateRow = stateResult.rows[0];
    if (!stateRow) {
      throw new Error("Digest state row is missing. Run migrations before viewing digest.");
    }
    const parsedState = digestViewStateRowSchema.parse(stateRow);
    if ((parsedState.note_cursor === null) !== (parsedState.note_cursor_id === null)) {
      throw new Error("Digest cursor timestamp and id must both be null or both be present.");
    }
    const claims = claimsResult.rows.map(mapDigestViewClaimRow);
    if (!parsedState.synthesized_at) {
      return { state: null, claims };
    }

    const newNoteCount = await countNewDigestNotes(
      this.pool,
      parsedState.note_cursor,
      parsedState.note_cursor_id
    );
    return {
      state: {
        synthesizedAt: parsedState.synthesized_at.toISOString(),
        newNoteCount,
        prose: parsedState.prose
      },
      claims
    };
  }

  async listRuns(limit: number) {
    // LIMIT 이전에 전체 히스토리를 조인·집계하지 않도록 run별 상관 서브쿼리로 스냅샷을 모은다.
    const result = await this.pool.query(
      `SELECT
        runs.id, runs.run_at, runs.status, runs.error, runs.new_note_count, runs.ops,
        runs.skipped_operations, runs.deferred_events, runs.prose_snapshot, runs.run_kind,
        COALESCE((
          SELECT jsonb_object_agg(texts.claim_id, texts.text)
          FROM digest_run_claim_texts AS texts
          WHERE texts.run_id = runs.id
        ), '{}'::jsonb) AS claim_texts
      FROM digest_runs AS runs
      ORDER BY runs.run_at DESC, runs.id DESC
      LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapDigestRunRow);
  }
}

function mapDigestViewClaimRow(row: pg.QueryResultRow) {
  const claim = digestViewClaimRowSchema.parse(row);
  if ((claim.deferred_target_layer === null) !== (claim.deferred_requested_at === null)) {
    throw new Error("Deferred promotion row must have both target layer and requested time.");
  }
  return {
    id: claim.id,
    layer: claim.layer,
    text: claim.text,
    evidenceCount: claim.evidence_count,
    sampleNoteIds: claim.sample_note_ids,
    firstObservedAt: claim.first_observed_at?.toISOString() ?? null,
    lastObservedAt: claim.last_observed_at?.toISOString() ?? null,
    observedDays: claim.observed_days,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
    deferred: claim.deferred_target_layer === null || claim.deferred_requested_at === null
      ? null
      : {
        targetLayer: claim.deferred_target_layer,
        requestedAt: claim.deferred_requested_at.toISOString()
      }
  };
}

function mapDigestRunRow(row: pg.QueryResultRow) {
  const run = digestRunRowSchema.parse(row);
  return {
    id: run.id,
    runAt: run.run_at.toISOString(),
    status: run.status,
    error: run.error,
    newNoteCount: run.new_note_count,
    ops: run.ops,
    skippedOperations: run.skipped_operations,
    deferredEvents: run.deferred_events,
    claimTexts: run.claim_texts,
    proseSnapshot: run.prose_snapshot,
    runKind: run.run_kind
  };
}

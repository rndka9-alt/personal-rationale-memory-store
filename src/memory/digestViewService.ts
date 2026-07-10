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
  prose: digestProseSchema,
  synthesized_at: z.coerce.date().nullable()
});

const digestViewClaimRowSchema = z.object({
  id: z.string(),
  layer: digestLayerSchema,
  text: z.string(),
  evidence_count: z.coerce.number().int().positive(),
  sample_note_ids: z.array(z.string()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date()
});

const digestRunRowSchema = z.object({
  id: z.string(),
  run_at: z.coerce.date(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().nullable(),
  new_note_count: z.coerce.number().int().nonnegative(),
  ops: z.array(digestOperationSchema),
  prose_snapshot: digestProseSchema
});

export class DigestViewService {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async getDigest() {
    const [stateResult, claimsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, note_cursor::text AS note_cursor, prose, synthesized_at
        FROM digest_state
        WHERE id = $1`,
        [digestStateId]
      ),
      this.pool.query(
        `SELECT id, layer, text, evidence_count, sample_note_ids, created_at, updated_at
        FROM digest_claims
        WHERE retired_at IS NULL
        ORDER BY CASE layer
          WHEN 'now' THEN 1
          WHEN 'recent' THEN 2
          WHEN 'longterm' THEN 3
          WHEN 'about' THEN 4
        END, updated_at DESC, id ASC`
      )
    ]);

    const stateRow = stateResult.rows[0];
    if (!stateRow) {
      throw new Error("Digest state row is missing. Run migrations before viewing digest.");
    }
    const parsedState = digestViewStateRowSchema.parse(stateRow);
    const claims = claimsResult.rows.map(mapDigestViewClaimRow);
    if (!parsedState.synthesized_at) {
      return { state: null, claims };
    }

    const newNoteCount = await countNewDigestNotes(this.pool, parsedState.note_cursor);
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
    const result = await this.pool.query(
      `SELECT id, run_at, status, error, new_note_count, ops, prose_snapshot
      FROM digest_runs
      ORDER BY run_at DESC, id DESC
      LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapDigestRunRow);
  }
}

function mapDigestViewClaimRow(row: pg.QueryResultRow) {
  const claim = digestViewClaimRowSchema.parse(row);
  return {
    id: claim.id,
    layer: claim.layer,
    text: claim.text,
    evidenceCount: claim.evidence_count,
    sampleNoteIds: claim.sample_note_ids,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString()
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
    proseSnapshot: run.prose_snapshot
  };
}

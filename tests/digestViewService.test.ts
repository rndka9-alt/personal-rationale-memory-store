import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DigestViewService } from "../src/memory/digestViewService.js";

describe("digest view service", () => {
  it("returns evidence aggregates and counts new notes from the tuple cursor", async () => {
    const pool = createPoolMock([
      [{
        id: "singleton",
        note_cursor: "2026-07-10T08:00:00.000Z",
        note_cursor_id: "note-2",
        prose: createProse("current"),
        synthesized_at: new Date("2026-07-10T09:00:00.000Z")
      }],
      [{
        id: "claim-now",
        layer: "now",
        text: "요즘 claim",
        evidence_count: 4,
        sample_note_ids: ["note-4", "note-3", "note-2", "note-1"],
        first_observed_at: new Date("2026-07-01T09:00:00.000Z"),
        last_observed_at: new Date("2026-07-10T09:00:00.000Z"),
        observed_days: 3,
        created_at: new Date("2026-07-01T09:00:00.000Z"),
        updated_at: new Date("2026-07-10T09:00:00.000Z"),
        deferred_target_layer: null,
        deferred_requested_at: null
      }, {
        id: "claim-waiting",
        layer: "recent",
        text: "승격 대기 claim",
        evidence_count: 2,
        sample_note_ids: ["note-6", "note-5"],
        first_observed_at: new Date("2026-07-05T09:00:00.000Z"),
        last_observed_at: new Date("2026-07-09T09:00:00.000Z"),
        observed_days: 2,
        created_at: new Date("2026-07-05T09:00:00.000Z"),
        updated_at: new Date("2026-07-09T09:00:00.000Z"),
        deferred_target_layer: "about",
        deferred_requested_at: new Date("2026-07-10T09:30:00.000Z")
      }],
      [{ new_note_count: 3 }]
    ]);
    const service = new DigestViewService(pool);

    await expect(service.getDigest()).resolves.toEqual({
      state: {
        synthesizedAt: "2026-07-10T09:00:00.000Z",
        newNoteCount: 3,
        prose: createProse("current")
      },
      claims: [{
        id: "claim-now",
        layer: "now",
        text: "요즘 claim",
        evidenceCount: 4,
        sampleNoteIds: ["note-4", "note-3", "note-2", "note-1"],
        firstObservedAt: "2026-07-01T09:00:00.000Z",
        lastObservedAt: "2026-07-10T09:00:00.000Z",
        observedDays: 3,
        createdAt: "2026-07-01T09:00:00.000Z",
        updatedAt: "2026-07-10T09:00:00.000Z",
        deferred: null
      }, {
        id: "claim-waiting",
        layer: "recent",
        text: "승격 대기 claim",
        evidenceCount: 2,
        sampleNoteIds: ["note-6", "note-5"],
        firstObservedAt: "2026-07-05T09:00:00.000Z",
        lastObservedAt: "2026-07-09T09:00:00.000Z",
        observedDays: 2,
        createdAt: "2026-07-05T09:00:00.000Z",
        updatedAt: "2026-07-09T09:00:00.000Z",
        deferred: {
          targetLayer: "about",
          requestedAt: "2026-07-10T09:30:00.000Z"
        }
      }]
    });

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("(created_at, id) > ($1::timestamptz, $2::text)"),
      ["2026-07-10T08:00:00.000Z", "note-2"]
    );
  });

  it("returns an empty state before the first synthesis", async () => {
    const pool = createPoolMock([
      [{
        id: "singleton",
        note_cursor: null,
        note_cursor_id: null,
        prose: createProse(""),
        synthesized_at: null
      }],
      []
    ]);
    const service = new DigestViewService(pool);

    await expect(service.getDigest()).resolves.toEqual({ state: null, claims: [] });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("returns promote, merge, skipped, and deferred audit records", async () => {
    const operations = [
      { type: "promote", claimId: "claim-now", layer: "about" },
      { type: "merge", parentClaimId: "parent", childClaimIds: ["child"], text: "병합 claim" }
    ];
    const pool = createPoolMock([[{
      id: "run-1",
      run_at: new Date("2026-07-10T10:00:00.000Z"),
      status: "succeeded",
      error: null,
      new_note_count: 2,
      ops: operations,
      skipped_operations: [{
        operation: { type: "promote", claimId: "short", layer: "longterm" },
        reason: "observation_span_below_7_days"
      }],
      deferred_events: [{
        action: "queued",
        claimId: "short",
        targetLayer: "longterm",
        reason: "observation_span_below_7_days"
      }],
      prose_snapshot: createProse("snapshot"),
      run_kind: "synthesis"
    }]]);
    const service = new DigestViewService(pool);

    await expect(service.listRuns(20)).resolves.toEqual([{
      id: "run-1",
      runAt: "2026-07-10T10:00:00.000Z",
      status: "succeeded",
      error: null,
      newNoteCount: 2,
      ops: operations,
      skippedOperations: [{
        operation: { type: "promote", claimId: "short", layer: "longterm" },
        reason: "observation_span_below_7_days"
      }],
      deferredEvents: [{
        action: "queued",
        claimId: "short",
        targetLayer: "longterm",
        reason: "observation_span_below_7_days"
      }],
      proseSnapshot: createProse("snapshot"),
      runKind: "synthesis"
    }]);
  });
});

function createPoolMock(rowSets: pg.QueryResultRow[][]) {
  const query = vi.fn(async () => {
    const rows = rowSets.shift();
    if (!rows) {
      throw new Error("Unexpected digest view query.");
    }
    return createQueryResult(rows);
  });
  return { query };
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

function createProse(prefix: string) {
  return {
    now: `${prefix} now`,
    recent: `${prefix} recent`,
    longterm: `${prefix} longterm`,
    about: `${prefix} about`
  };
}

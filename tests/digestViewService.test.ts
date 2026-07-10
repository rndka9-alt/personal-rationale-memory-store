import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DigestViewService } from "../src/memory/digestViewService.js";

describe("digest view service", () => {
  it("returns synthesized state with the shared new-note count and ordered active claims", async () => {
    const pool = createPoolMock([
      [{
        id: "singleton",
        note_cursor: "2026-07-10T08:00:00.000Z",
        prose: createProse("current"),
        synthesized_at: new Date("2026-07-10T09:00:00.000Z")
      }],
      [{
        id: "claim-now",
        layer: "now",
        text: "요즘 claim",
        evidence_count: 4,
        sample_note_ids: ["note-1", "note-2"],
        created_at: new Date("2026-07-09T09:00:00.000Z"),
        updated_at: new Date("2026-07-10T09:00:00.000Z")
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
        sampleNoteIds: ["note-1", "note-2"],
        createdAt: "2026-07-09T09:00:00.000Z",
        updatedAt: "2026-07-10T09:00:00.000Z"
      }]
    });

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/retired_at IS NULL[\s\S]+WHEN 'now'[\s\S]+WHEN 'recent'[\s\S]+WHEN 'longterm'[\s\S]+WHEN 'about'[\s\S]+updated_at DESC/)
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("archived = FALSE"),
      ["2026-07-10T08:00:00.000Z"]
    );
  });

  it("returns an empty state without counting notes before the first synthesis", async () => {
    const pool = createPoolMock([
      [{
        id: "singleton",
        note_cursor: null,
        prose: createProse(""),
        synthesized_at: null
      }],
      []
    ]);
    const service = new DigestViewService(pool);

    await expect(service.getDigest()).resolves.toEqual({ state: null, claims: [] });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("parses digest run JSON while preserving its operations", async () => {
    const operations = [
      { type: "add", layer: "recent", text: "새 claim", noteIds: ["note-3"] },
      { type: "strengthen", claimId: "claim-now", noteIds: ["note-4", "note-5"] }
    ];
    const pool = createPoolMock([[{
        id: "run-1",
        run_at: new Date("2026-07-10T10:00:00.000Z"),
        status: "succeeded",
        error: null,
        new_note_count: 2,
        ops: operations,
        prose_snapshot: createProse("snapshot")
    }]]);
    const service = new DigestViewService(pool);

    await expect(service.listRuns(20)).resolves.toEqual([{
      id: "run-1",
      runAt: "2026-07-10T10:00:00.000Z",
      status: "succeeded",
      error: null,
      newNoteCount: 2,
      ops: operations,
      proseSnapshot: createProse("snapshot")
    }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY run_at DESC"), [20]);
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

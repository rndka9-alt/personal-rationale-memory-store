import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("digest evidence migration", () => {
  it("guards every replay-sensitive schema and backfill operation", async () => {
    const migration = await readFile(
      path.resolve(process.cwd(), "migrations/017_digest_evidence_pipeline.sql"),
      "utf8"
    );

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS digest_claim_evidence");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS digest_deferred_promotions");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS note_cursor_id");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS judgment_at");
    expect(migration).toContain("column_name = 'sample_note_ids'");
    expect(migration).toContain("ON CONFLICT (claim_id, note_id) DO NOTHING");
    expect(migration).toContain("DROP COLUMN IF EXISTS sample_note_ids");
    expect(migration).toContain("DROP COLUMN IF EXISTS evidence_count");
  });
});

import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  capChapterNotes,
  isMondayDateString,
  isoWeekNumber,
  NoteDiaryService,
  shiftDiaryDate,
  validateEpisodeAssignment,
  validateProseAssignment,
  type DiaryChapterNote
} from "../src/memory/noteDiaryService.js";

const enabledDigestConfig = (() => {
  const config = loadConfig({
    DIGEST_ENABLED: "true",
    DIGEST_LLM_PROVIDER: "vercel",
    DIGEST_LLM_MODEL: "openai/gpt-test",
    DIGEST_LLM_API_KEY: "test-key"
  }).digest;
  if (!config.enabled) {
    throw new Error("Expected digest config to be enabled.");
  }
  return config;
})();

describe("diary refresh guards", () => {
  it("reuses the snapshot when one already exists for the same week", async () => {
    const query = vi.fn().mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes("AS today")) {
        return Promise.resolve({ rows: [{ today: "2026-08-06" }] });
      }
      if (text.includes("FROM note_diary_snapshots")) {
        return Promise.resolve({ rows: [{ id: "snapshot-1" }] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const service = new NoteDiaryService({ query }, enabledDigestConfig, { generate: vi.fn() });

    await expect(service.requestRefresh("2026-07-27")).resolves.toEqual({
      status: "exists",
      snapshotId: "snapshot-1"
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO note_diary_runs"))).toBe(false);
  });

  it("rejects synthesis when no LLM configuration is available", async () => {
    const service = new NoteDiaryService({ query: vi.fn() }, null);

    expect(service.synthesisEnabled).toBe(false);
    await expect(service.requestRefresh("2026-07-27")).rejects.toThrow("DIGEST_ENABLED");
  });

  it("rejects a weekStart that is not a Monday", async () => {
    const query = vi.fn();
    const service = new NoteDiaryService({ query }, enabledDigestConfig, { generate: vi.fn() });

    // 2026-07-29는 수요일.
    await expect(service.requestRefresh("2026-07-29")).rejects.toThrow("Monday");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a week that is still in progress", async () => {
    const query = vi.fn().mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes("AS today")) {
        return Promise.resolve({ rows: [{ today: "2026-08-06" }] });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const service = new NoteDiaryService({ query }, enabledDigestConfig, { generate: vi.fn() });

    // 2026-08-03(월)의 주는 2026-08-10에 완결되므로 08-06 시점에는 아직 진행 중이다.
    await expect(service.requestRefresh("2026-08-03")).rejects.toThrow("still in progress");
  });
});

describe("diary week helpers", () => {
  it("identifies Mondays in the KST calendar date string", () => {
    expect(isMondayDateString("2026-08-03")).toBe(true);
    expect(isMondayDateString("2026-08-04")).toBe(false);
    expect(() => isMondayDateString("2026-8-3")).toThrow("Invalid diary date");
  });

  it("shifts date strings across month boundaries", () => {
    expect(shiftDiaryDate("2026-07-27", 7)).toBe("2026-08-03");
    expect(shiftDiaryDate("2026-08-03", -1)).toBe("2026-08-02");
  });

  it("computes ISO week numbers for issue labels", () => {
    expect(isoWeekNumber("2026-07-27")).toBe(31);
    expect(isoWeekNumber("2026-06-15")).toBe(25);
    // 2026-01-01은 목요일이라 그 주가 ISO 1주다.
    expect(isoWeekNumber("2025-12-29")).toBe(1);
  });
});

describe("episode assignment validation", () => {
  it("accepts a disjoint assignment over known note ids", () => {
    const parsed = {
      episodes: [
        { title: "첫째", noteIds: ["n0", "n2"] },
        { title: "둘째", noteIds: ["n1"] }
      ],
      journalNoteIds: ["n3"]
    };
    expect(validateEpisodeAssignment(parsed, ["n0", "n1", "n2", "n3"])).toBeNull();
  });

  it("flags unknown and duplicated note ids", () => {
    expect(validateEpisodeAssignment(
      { episodes: [{ title: "첫째", noteIds: ["n9"] }], journalNoteIds: [] },
      ["n0"]
    )).toContain("unknown note id");
    expect(validateEpisodeAssignment(
      { episodes: [{ title: "첫째", noteIds: ["n0"] }, { title: "둘째", noteIds: ["n0"] }], journalNoteIds: [] },
      ["n0"]
    )).toContain("assigned twice");
  });

  it("keeps journal picks disjoint from episode picks", () => {
    expect(validateEpisodeAssignment(
      { episodes: [{ title: "첫째", noteIds: ["n0"] }], journalNoteIds: ["n0"] },
      ["n0", "n1"]
    )).toContain("assigned twice");
    expect(validateEpisodeAssignment(
      { episodes: [{ title: "첫째", noteIds: ["n0"] }], journalNoteIds: ["n9"] },
      ["n0", "n1"]
    )).toContain("unknown note id");
  });

  it("requires prose output to cover every episode exactly once", () => {
    const prose = (episodeIds: string[]) => ({
      intro: "서문",
      episodes: episodeIds.map((episodeId) => ({ episodeId, title: "헤드라인", caption: "소개", comment: "한마디" })),
      journal: null,
      closing: "마무리"
    });
    expect(validateProseAssignment(prose(["e0", "e1"]), ["e0", "e1"])).toBeNull();
    expect(validateProseAssignment(prose(["e0"]), ["e0", "e1"])).toContain("missing");
    expect(validateProseAssignment(prose(["e0", "e0"]), ["e0"])).toContain("described twice");
    expect(validateProseAssignment(prose(["e9"]), ["e0"])).toContain("unknown episode id");
  });
});

describe("capChapterNotes", () => {
  const note = (id: string, upvotes: number): DiaryChapterNote => ({
    id,
    content: `note ${id}`,
    topic: null,
    upvotes,
    downvotes: 0,
    day: "2026-07-27"
  });

  it("keeps every note when under the cap", () => {
    const notes = [note("a", 0), note("b", 1)];
    expect(capChapterNotes(notes, 5)).toEqual({ notes, droppedNoteCount: 0 });
  });

  it("drops the lowest scored notes but preserves chronological order", () => {
    const notes = [note("a", 0), note("b", 5), note("c", 1), note("d", 3), note("e", 0)];
    const capped = capChapterNotes(notes, 3);
    expect(capped.notes.map((kept) => kept.id)).toEqual(["b", "c", "d"]);
    expect(capped.droppedNoteCount).toBe(2);
  });

  it("breaks score ties by keeping earlier notes", () => {
    const notes = [note("a", 1), note("b", 1), note("c", 1)];
    const capped = capChapterNotes(notes, 2);
    expect(capped.notes.map((kept) => kept.id)).toEqual(["a", "b"]);
  });
});

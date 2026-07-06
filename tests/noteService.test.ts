import { describe, expect, it } from "vitest";
import {
  calculateNoteRandomWeight,
  calculateNoteScore,
  formatNotesContext,
  NoteSlotCache,
  selectNotesForContext
} from "../src/memory/noteService.js";
import type { NoteRecord } from "../src/memory/schema.js";

describe("note context selection", () => {
  it("uses upvote minus downvote as the score", () => {
    expect(calculateNoteScore(createNote("note-1", "plain", 3, 1))).toBe(2);
  });

  it("keeps upvotes weak in random selection while downvotes reduce exposure", () => {
    expect(calculateNoteRandomWeight(createNote("new", "new note", 0, 0))).toBe(3);
    expect(calculateNoteRandomWeight(createNote("liked", "liked note", 1, 0))).toBe(4);
    expect(calculateNoteRandomWeight(createNote("very-liked", "very liked note", 100, 0))).toBe(4);
    expect(calculateNoteRandomWeight(createNote("downvoted", "downvoted note", 0, 2))).toBe(1);
    expect(calculateNoteRandomWeight(createNote("very-downvoted", "very downvoted note", 0, 100))).toBe(1);
  });

  it("fills the random budget first, then uses score ordering for the remaining budget", () => {
    const notes = [
      createNote("random-1", "r".repeat(1000), 0, 0, "2026-06-12T00:00:06.000Z"),
      createNote("random-2", "r".repeat(1000), 0, 0, "2026-06-12T00:00:05.000Z"),
      createNote("random-3", "r".repeat(1000), 0, 0, "2026-06-12T00:00:04.000Z"),
      createNote("score-1", "s".repeat(1000), 10, 0, "2026-06-12T00:00:03.000Z"),
      createNote("score-2", "s".repeat(1000), 9, 0, "2026-06-12T00:00:02.000Z"),
      createNote("score-3", "s".repeat(1000), 8, 0, "2026-06-12T00:00:01.000Z")
    ];

    const selection = selectNotesForContext(notes, {
      maxLength: 5000,
      maxNoteLength: 1000,
      randomRatio: 0.6
    }, () => 0);

    expect(selection.selectedNotes.map((selectedNote) => selectedNote.note.id)).toEqual([
      "random-1",
      "random-2",
      "random-3",
      "score-1",
      "score-2"
    ]);
    expect(selection.randomSelectedNotes).toBe(3);
    expect(selection.scoreSelectedNotes).toBe(2);
    expect(selection.omittedNotes).toBe(1);
  });

  it("excludes long notes instead of truncating them", () => {
    const notes = [
      createNote("short", "s".repeat(1000)),
      createNote("long", "l".repeat(1001))
    ];

    const selection = selectNotesForContext(notes, {
      maxLength: 5000,
      maxNoteLength: 1000,
      randomRatio: 0.6
    }, () => 0);

    expect(selection.selectedNotes.map((selectedNote) => selectedNote.note.id)).toEqual(["short"]);
    expect(selection.excludedLongNotes).toBe(1);
  });

  it("heads each note with its own slot line so ratings can target it", () => {
    const context = formatNotesContext([
      { slot: "00", content: "first line\nsecond line" },
      { slot: "01", content: "another note" }
    ]);

    expect(context).toContain("━━━ 00 ━━━\nfirst line\nsecond line\n\n━━━ 01 ━━━\nanother note");
  });

  it("appends a rating nudge so clients have an in-context trigger for rate_note", () => {
    const context = formatNotesContext([
      { slot: "00", content: "a note" }
    ]);

    // 유도 문구는 노트 본문 뒤 마지막 단락으로 온다(본문이 먼저).
    expect(context.startsWith("━━━ 00 ━━━")).toBe(true);
    expect(context).toContain("rate_note");
  });

  it("formats an empty note selection as empty text", () => {
    expect(formatNotesContext([])).toBe("");
  });
});

describe("note slot cache", () => {
  it("assigns short distinct slots and resolves them back to note ids", () => {
    const cache = new NoteSlotCache();
    const slotA = cache.assign("note-a");
    const slotB = cache.assign("note-b");

    expect(slotA).not.toBe(slotB);
    expect(cache.resolve(slotA)).toBe("note-a");
    expect(cache.resolve(slotB)).toBe("note-b");
  });

  it("reuses the same slot for a repeated note instead of allocating a new one", () => {
    const cache = new NoteSlotCache();
    const first = cache.assign("note-a");
    cache.assign("note-b");

    expect(cache.assign("note-a")).toBe(first);
  });

  it("evicts the oldest slot once capacity is exceeded", () => {
    const cache = new NoteSlotCache(2);
    const slotA = cache.assign("note-a");
    const slotB = cache.assign("note-b");
    const slotC = cache.assign("note-c");

    expect(cache.resolve(slotA)).toBeUndefined();
    expect(cache.resolve(slotB)).toBe("note-b");
    expect(cache.resolve(slotC)).toBe("note-c");
  });

  it("keeps a re-touched slot fresh so it survives later eviction", () => {
    const cache = new NoteSlotCache(2);
    const slotA = cache.assign("note-a");
    cache.assign("note-b");
    // note-a를 다시 만지면 가장 최근으로 갱신되어, 다음 발급 때 note-b가 먼저 밀려난다.
    cache.assign("note-a");
    cache.assign("note-c");

    expect(cache.resolve(slotA)).toBe("note-a");
  });

  it("resolves an unknown slot to undefined", () => {
    const cache = new NoteSlotCache();
    expect(cache.resolve("zz")).toBeUndefined();
  });
});

function createNote(
  id: string,
  content: string,
  upvotes = 0,
  downvotes = 0,
  createdAt = "2026-06-12T00:00:00.000Z"
): NoteRecord {
  return {
    id,
    content,
    upvotes,
    downvotes,
    archived: false,
    createdAt,
    updatedAt: createdAt
  };
}

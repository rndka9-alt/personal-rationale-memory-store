import { describe, expect, it } from "vitest";
import {
  calculateNoteRandomWeight,
  calculateNoteScore,
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

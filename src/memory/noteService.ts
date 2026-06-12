import type pg from "pg";
import {
  archiveNoteRecord,
  incrementNoteRating,
  insertNote,
  listActiveNotes
} from "../db/queries.js";
import { logInfo } from "../diagnostics/index.js";
import {
  archiveNoteInputSchema,
  composeNotesContextInputSchema,
  rateNoteInputSchema,
  recordNoteInputSchema,
  type ComposeNotesContextInput,
  type NoteRecord,
  type RecordNoteInput
} from "./schema.js";

const defaultNoteContextMaxLength = 5000;
const noteContentMaxLength = 1000;
const randomContextRatio = 0.6;
const randomBaseWeight = 3;

type SelectedNote = {
  note: NoteRecord;
  source: "random" | "score";
};

export type NoteContextSelection = {
  selectedNotes: SelectedNote[];
  totalActiveNotes: number;
  eligibleNotes: number;
  excludedLongNotes: number;
  omittedNotes: number;
  randomSelectedNotes: number;
  scoreSelectedNotes: number;
  selectedContentLength: number;
  maxLength: number;
};

type SelectNotesOptions = {
  maxLength: number;
  maxNoteLength: number;
  randomRatio: number;
};

export class NoteService {
  constructor(private readonly pool: pg.Pool) {}

  async recordNote(input: RecordNoteInput) {
    const validatedInput = recordNoteInputSchema.parse(input);
    const note = await insertNote(this.pool, {
      id: createNoteId(),
      content: validatedInput.content
    });
    logInfo("Note recorded.", {
      noteId: note.id,
      contentLength: note.content.length
    });
    return note;
  }

  async rateNote(input: unknown) {
    const validatedInput = rateNoteInputSchema.parse(input);
    return incrementNoteRating(this.pool, validatedInput.noteId, validatedInput.rating);
  }

  async archiveNote(input: unknown) {
    const validatedInput = archiveNoteInputSchema.parse(input);
    return archiveNoteRecord(this.pool, validatedInput.noteId);
  }

  async composeNotesContext(input: ComposeNotesContextInput = {}) {
    const validatedInput = composeNotesContextInputSchema.parse(input);
    const maxLength = validatedInput.maxLength ?? defaultNoteContextMaxLength;
    const notes = await listActiveNotes(this.pool);
    const selection = selectNotesForContext(notes, {
      maxLength,
      maxNoteLength: noteContentMaxLength,
      randomRatio: randomContextRatio
    });
    return formatNotesContext(selection);
  }
}

export function selectNotesForContext(
  notes: NoteRecord[],
  options: SelectNotesOptions,
  random = Math.random
): NoteContextSelection {
  const eligibleNotes = notes.filter((note) => note.content.length <= options.maxNoteLength);
  const excludedLongNotes = notes.length - eligibleNotes.length;
  const randomTargetLength = Math.floor(options.maxLength * options.randomRatio);
  const selectedNotes: SelectedNote[] = [];
  let selectedContentLength = 0;
  let remainingNotes = [...eligibleNotes];

  while (selectedContentLength < randomTargetLength && remainingNotes.length > 0) {
    const candidate = pickWeightedRandomNote(remainingNotes, random);
    remainingNotes = remainingNotes.filter((note) => note.id !== candidate.id);
    if (selectedContentLength + candidate.content.length <= options.maxLength) {
      selectedNotes.push({ note: candidate, source: "random" });
      selectedContentLength += candidate.content.length;
    }
  }

  const scoreSortedNotes = [...remainingNotes].sort(compareNotesByScoreThenDate);
  for (const note of scoreSortedNotes) {
    if (selectedContentLength + note.content.length <= options.maxLength) {
      selectedNotes.push({ note, source: "score" });
      selectedContentLength += note.content.length;
    }
  }

  const randomSelectedNotes = selectedNotes.filter((selectedNote) => selectedNote.source === "random").length;
  const scoreSelectedNotes = selectedNotes.filter((selectedNote) => selectedNote.source === "score").length;

  return {
    selectedNotes,
    totalActiveNotes: notes.length,
    eligibleNotes: eligibleNotes.length,
    excludedLongNotes,
    omittedNotes: eligibleNotes.length - selectedNotes.length,
    randomSelectedNotes,
    scoreSelectedNotes,
    selectedContentLength,
    maxLength: options.maxLength
  };
}

export function calculateNoteScore(note: Pick<NoteRecord, "upvotes" | "downvotes">) {
  return note.upvotes - note.downvotes;
}

export function calculateNoteRandomWeight(note: Pick<NoteRecord, "upvotes" | "downvotes">) {
  const likedBonus = note.upvotes > 0 ? 1 : 0;
  return Math.max(1, randomBaseWeight + likedBonus - note.downvotes);
}

function pickWeightedRandomNote(notes: NoteRecord[], random: () => number) {
  if (notes.length === 0) {
    throw new Error("Cannot pick a note from an empty list.");
  }

  const totalWeight = notes.reduce(
    (sum, note) => sum + calculateNoteRandomWeight(note),
    0
  );
  const threshold = random() * totalWeight;
  let cumulativeWeight = 0;
  for (const note of notes) {
    cumulativeWeight += calculateNoteRandomWeight(note);
    if (threshold < cumulativeWeight) {
      return note;
    }
  }

  const fallbackNote = notes.at(-1);
  if (!fallbackNote) {
    throw new Error("Cannot pick a note from an empty list.");
  }
  return fallbackNote;
}

function compareNotesByScoreThenDate(left: NoteRecord, right: NoteRecord) {
  const scoreDifference = calculateNoteScore(right) - calculateNoteScore(left);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function formatNotesContext(selection: NoteContextSelection) {
  const lines = ["## Notes"];
  if (selection.selectedNotes.length === 0) {
    lines.push("- No notes selected.");
  } else {
    for (const selectedNote of selection.selectedNotes) {
      lines.push(formatNoteContent(selectedNote.note.content));
    }
  }

  lines.push(
    "",
    `Selected notes: ${selection.selectedNotes.length}`,
    `Random notes: ${selection.randomSelectedNotes}`,
    `Score notes: ${selection.scoreSelectedNotes}`,
    `Omitted notes: ${selection.omittedNotes}`,
    `Excluded long notes: ${selection.excludedLongNotes}`,
    `Selected content length: ${selection.selectedContentLength}/${selection.maxLength}`
  );
  return lines.join("\n");
}

function formatNoteContent(content: string) {
  return content
    .split("\n")
    .map((line, index) => index === 0 ? `- ${line}` : `  ${line}`)
    .join("\n");
}

function createNoteId() {
  const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `N${timestamp}-${randomPart}`;
}

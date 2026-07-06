import type pg from "pg";
import {
  archiveNoteRecord,
  incrementNoteRating,
  insertNote,
  listActiveNotes,
  listNotes as listNoteRecords,
  restoreNoteRecord
} from "../db/queries.js";
import { logInfo } from "../diagnostics/index.js";
import {
  archiveNoteInputSchema,
  composeNotesContextInputSchema,
  rateNoteInputSchema,
  recordNoteInputSchema,
  type ComposeNotesContextInput,
  type NoteRating,
  type NoteRecord,
  type RecordNoteInput
} from "./schema.js";

const defaultNoteContextMaxLength = 5000;
const noteContentMaxLength = 1000;
const randomContextRatio = 0.6;
const randomBaseWeight = 3;

// compose_notes_context가 노트마다 발급하는 임시 슬롯 캐시의 용량.
// 한 번에 내려가는 노트 수보다 넉넉하되, 슬롯 번호 공간보다는 충분히 작아야 한다(아래 불변식 참고).
const noteSlotCacheCapacity = 40;
// 슬롯 문자열은 base36 2글자(=1296가지)로 짧게 유지한다. 컨텍스트 비용 최소화가 목적.
const noteSlotRadix = 36;
const noteSlotWidth = 2;
const noteSlotSpace = noteSlotRadix ** noteSlotWidth;

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
  // 슬롯 캐시는 NoteService 수명 동안 유지되어야 compose에서 발급한 슬롯을 rate에서 되찾을 수 있다.
  private readonly slotCache = new NoteSlotCache();

  constructor(private readonly pool: pg.Pool) {}

  async recordNote(input: RecordNoteInput) {
    const validatedInput = recordNoteInputSchema.parse(input);
    const note = await insertNote(this.pool, {
      id: createNoteId(),
      content: validatedInput.content,
      topic: validatedInput.topic,
      sourceConversation: validatedInput.sourceConversation
    });
    logInfo("Note recorded.", {
      noteId: note.id,
      contentLength: note.content.length
    });
    return note;
  }

  async rateNote(input: unknown) {
    const validatedInput = rateNoteInputSchema.parse(input);
    const noteId = this.slotCache.resolve(validatedInput.slot);
    if (!noteId) {
      // 슬롯은 휘발성(LRU)이라 오래되면 사라진다. 트랜스포트 오류가 아니라 정상적인 '만료' 결과로
      // 내려주어, 모델이 사용자에게 부드럽게 다시 꺼내달라고 전할 수 있게 한다.
      logInfo("Note rating slot expired.", { slot: validatedInput.slot });
      return {
        ok: false as const,
        httpStatus: 410,
        reason: "앗.. 그 쪽지는 이미 날아가버렷어요! 쪽지를 다시 꺼낸 다음 평가해 주세요"
      };
    }

    const note = await incrementNoteRating(this.pool, noteId, validatedInput.rating);
    logInfo("Note rated.", {
      slot: validatedInput.slot,
      noteId,
      rating: validatedInput.rating
    });
    return {
      ok: true as const,
      slot: validatedInput.slot,
      rating: validatedInput.rating,
      upvotes: note.upvotes,
      downvotes: note.downvotes,
      feedback: noteRatingFeedback(validatedInput.rating)
    };
  }

  async archiveNote(input: unknown) {
    const validatedInput = archiveNoteInputSchema.parse(input);
    return archiveNoteRecord(this.pool, validatedInput.noteId);
  }

  async restoreNote(input: unknown) {
    const validatedInput = archiveNoteInputSchema.parse(input);
    return restoreNoteRecord(this.pool, validatedInput.noteId);
  }

  async listNotes(includeArchived = false) {
    return listNoteRecords(this.pool, includeArchived);
  }

  async composeNotesContext(input: ComposeNotesContextInput = {}) {
    composeNotesContextInputSchema.parse(input);
    const notes = await listActiveNotes(this.pool);
    const selection = selectNotesForContext(notes, {
      maxLength: defaultNoteContextMaxLength,
      maxNoteLength: noteContentMaxLength,
      randomRatio: randomContextRatio
    });
    // 내려가는 노트마다 슬롯을 발급(같은 노트면 기존 슬롯 재사용)해, rate_note가 그 슬롯으로 평가할 수 있게 한다.
    const slottedNotes = selection.selectedNotes.map((selectedNote) => ({
      slot: this.slotCache.assign(selectedNote.note.id),
      content: selectedNote.note.content
    }));
    return formatNotesContext(slottedNotes);
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

// 노트마다 슬롯 헤더(━━━ <slot> ━━━)를 자체 라인으로 올려 내려준다. 모델은 이 슬롯을 rate_note의 slot으로 사용한다.
// 헤더를 별도 라인 + 흔치 않은 구분선으로 둔 이유: 노트 원문이 '[태그]'로 시작하거나 내부에 빈 줄을 포함해도
// 노트 경계와 슬롯이 모호해지지 않게 하려는 것(원문과 충돌하지 않는 마커가 필요).
export type SlottedNote = {
  slot: string;
  content: string;
};

// 평가 유도 문구를 컨텍스트 자체에 싣는다: rate_note는 서버에 배선만 되어 있으면 불리지 않는다는 걸
// 운영 데이터로 확인함(노트 167개 중 평가 1건). 컨텍스트 안에 계기가 있어야 피드백 루프가 돈다.
const noteRatingNudge =
  "도움이 됐거나 별로였던 쪽지는 rate_note로 평가해 주세요 (slot: 각 ━━━ 헤더의 값, rating: \"up\" 또는 \"down\").";

export function formatNotesContext(notes: SlottedNote[]) {
  if (notes.length === 0) {
    return "";
  }

  const body = notes.map((note) => `━━━ ${note.slot} ━━━\n${note.content}`).join("\n\n");
  return `${body}\n\n${noteRatingNudge}`;
}

function noteRatingFeedback(rating: NoteRating) {
  return rating === "up"
    ? "추천 도장 쾅! 좋은 쪽지로 기억해 둘게요 ✨"
    : "에구.. 별로엿군요. 다음엔 더 잘 골라볼게요!";
}

// 슬롯은 긴 노트 id(N…)를 모델 컨텍스트에 다시 싣지 않으려고 두는 짧은 임시 핸들이다.
// 단순 LRU: 같은 노트가 다시 내려가면 슬롯을 재사용하며 가장 최근으로 갱신하고, 용량을 넘으면 가장 오래된 슬롯을 밀어낸다.
export class NoteSlotCache {
  // Map의 삽입 순서를 LRU 순서로 활용한다(맨 앞 = 가장 오래됨, 맨 뒤 = 가장 최근).
  private readonly slotToNote = new Map<string, string>();
  private readonly noteToSlot = new Map<string, string>();
  private counter = 0;

  constructor(private readonly capacity = noteSlotCacheCapacity) {}

  assign(noteId: string): string {
    const existingSlot = this.noteToSlot.get(noteId);
    if (existingSlot) {
      this.freshen(existingSlot, noteId);
      return existingSlot;
    }

    const slot = this.nextSlot();
    this.slotToNote.set(slot, noteId);
    this.noteToSlot.set(noteId, slot);
    this.evictOverflow();
    return slot;
  }

  resolve(slot: string): string | undefined {
    return this.slotToNote.get(slot);
  }

  private nextSlot(): string {
    // 핵심 불변식: capacity < noteSlotSpace. monotonic 카운터를 슬롯 공간으로 wrap하므로,
    // 같은 슬롯이 다시 발급될 시점이면 그 옛 슬롯은 이미 용량 초과로 evict되어 '만료'로 잡힌다.
    // 이 불변식이 깨지면 만료가 아니라 옛 슬롯이 다른 노트로 재할당되는 '조용한 오배정'이 생긴다.
    const slot = (this.counter % noteSlotSpace).toString(noteSlotRadix).padStart(noteSlotWidth, "0");
    this.counter += 1;

    // 방어적 처리: 불변식상 도달하지 않지만, 살아있는 슬롯과 겹치면 옛 매핑을 먼저 비운다.
    const staleNote = this.slotToNote.get(slot);
    if (staleNote !== undefined) {
      this.slotToNote.delete(slot);
      this.noteToSlot.delete(staleNote);
    }
    return slot;
  }

  private freshen(slot: string, noteId: string) {
    // 재삽입으로 Map 순서상 맨 뒤(가장 최근)로 옮긴다.
    this.slotToNote.delete(slot);
    this.noteToSlot.delete(noteId);
    this.slotToNote.set(slot, noteId);
    this.noteToSlot.set(noteId, slot);
  }

  private evictOverflow() {
    while (this.slotToNote.size > this.capacity) {
      const oldestSlot = this.slotToNote.keys().next().value;
      if (oldestSlot === undefined) {
        break;
      }
      const oldestNote = this.slotToNote.get(oldestSlot);
      this.slotToNote.delete(oldestSlot);
      if (oldestNote !== undefined) {
        this.noteToSlot.delete(oldestNote);
      }
    }
  }
}

function createNoteId() {
  const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `N${timestamp}-${randomPart}`;
}

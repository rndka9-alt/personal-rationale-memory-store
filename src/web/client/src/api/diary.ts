import { requestJson } from "./http";

export type DiaryChapter = {
  weekStart: string;
  weekEnd: string;
  noteCount: number;
  completed: boolean;
  snapshot: { id: string; generatedAt: string } | null;
};

export type DiaryChaptersResponse = {
  chapters: DiaryChapter[];
  synthesisEnabled: boolean;
};

export type DiaryEpisodeNote = {
  id: string;
  day: string;
  topic: string | null;
  content: string;
};

export type DiaryEpisode = {
  title: string;
  caption: string;
  comment: string;
  notes: DiaryEpisodeNote[];
};

export type DiaryJournal = {
  notes: DiaryEpisodeNote[];
  comment: string;
};

export type DiarySnapshotResult = {
  intro: string;
  episodes: DiaryEpisode[];
  journal: DiaryJournal | null;
  closing: string;
  stats: {
    noteCount: number;
    activeDayCount: number;
    curatedNoteCount: number;
    droppedNoteCount: number;
  };
};

export type DiarySnapshot = {
  id: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  result: DiarySnapshotResult;
};

export type DiarySnapshotResponse = {
  snapshot: DiarySnapshot | null;
  // 이 주에 지금 돌고 있는 생성 run. 새로고침 후에도 클라이언트가 폴링을 이어붙이는 데 쓴다.
  runningRunId: string | null;
  synthesisEnabled: boolean;
};

export type DiaryRefreshResponse =
  | { status: "exists"; snapshotId: string }
  | { status: "already_running" | "started"; runId: string };

export type DiaryRun = {
  id: string;
  status: "running" | "succeeded" | "failed";
  weekStart: string;
  requestedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
};

export async function fetchDiaryChapters(): Promise<DiaryChaptersResponse> {
  const data = await requestJson("/api/diary/chapters");
  if (!isRecord(data) || !Array.isArray(data.chapters) || typeof data.synthesisEnabled !== "boolean") {
    throw new Error("Invalid diary chapters response.");
  }
  return {
    chapters: data.chapters.map(parseChapter),
    synthesisEnabled: data.synthesisEnabled
  };
}

export async function fetchDiarySnapshot(weekStart: string): Promise<DiarySnapshotResponse> {
  const params = new URLSearchParams({ weekStart });
  const data = await requestJson(`/api/diary/snapshot?${params.toString()}`);
  if (!isRecord(data) || typeof data.synthesisEnabled !== "boolean") {
    throw new Error("Invalid diary snapshot response.");
  }
  return {
    snapshot: data.snapshot === null ? null : parseSnapshot(data.snapshot),
    runningRunId: readNullableString(data, "runningRunId"),
    synthesisEnabled: data.synthesisEnabled
  };
}

export async function requestDiaryRefresh(weekStart: string, force = false): Promise<DiaryRefreshResponse> {
  const data = await requestJson("/api/diary/refresh", { method: "POST", body: { weekStart, force } });
  if (!isRecord(data)) {
    throw new Error("Invalid diary refresh response.");
  }
  if (data.status === "exists") {
    return { status: "exists", snapshotId: readString(data, "snapshotId") };
  }
  if (data.status === "already_running" || data.status === "started") {
    return { status: data.status, runId: readString(data, "runId") };
  }
  throw new Error("Invalid diary refresh status.");
}

export async function fetchDiaryRun(runId: string): Promise<DiaryRun> {
  const data = await requestJson(`/api/diary/runs/${encodeURIComponent(runId)}`);
  if (!isRecord(data)) {
    throw new Error("Invalid diary run response.");
  }
  const status = data.status;
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new Error("Invalid diary run status.");
  }
  return {
    id: readString(data, "id"),
    status,
    weekStart: readString(data, "weekStart"),
    requestedAt: readString(data, "requestedAt"),
    finishedAt: readNullableString(data, "finishedAt"),
    error: readNullableString(data, "error"),
    snapshotId: readNullableString(data, "snapshotId")
  };
}

function parseChapter(value: unknown): DiaryChapter {
  const record = readRecordValue(value, "diary chapter");
  const snapshot = record.snapshot;
  if (typeof record.completed !== "boolean") {
    throw new Error("Invalid diary chapter completed flag.");
  }
  return {
    weekStart: readString(record, "weekStart"),
    weekEnd: readString(record, "weekEnd"),
    noteCount: readNumber(record, "noteCount"),
    completed: record.completed,
    snapshot: snapshot === null
      ? null
      : {
        id: readString(readRecordValue(snapshot, "diary chapter snapshot"), "id"),
        generatedAt: readString(readRecordValue(snapshot, "diary chapter snapshot"), "generatedAt")
      }
  };
}

function parseSnapshot(value: unknown): DiarySnapshot {
  const record = readRecordValue(value, "diary snapshot");
  return {
    id: readString(record, "id"),
    weekStart: readString(record, "weekStart"),
    weekEnd: readString(record, "weekEnd"),
    generatedAt: readString(record, "generatedAt"),
    result: parseSnapshotResult(record.result)
  };
}

function parseSnapshotResult(value: unknown): DiarySnapshotResult {
  const record = readRecordValue(value, "diary snapshot result");
  if (!Array.isArray(record.episodes)) {
    throw new Error("Invalid diary snapshot episodes.");
  }
  const stats = readRecordValue(record.stats, "diary snapshot stats");
  return {
    intro: readString(record, "intro"),
    episodes: record.episodes.map(parseEpisode),
    // schema v1 스냅샷에는 journal 필드가 없다. 없음과 null 모두 "수첩 없는 호"로 읽는다.
    journal: record.journal === null || record.journal === undefined ? null : parseJournal(record.journal),
    closing: readString(record, "closing"),
    stats: {
      noteCount: readNumber(stats, "noteCount"),
      activeDayCount: readNumber(stats, "activeDayCount"),
      curatedNoteCount: readNumber(stats, "curatedNoteCount"),
      droppedNoteCount: readNumber(stats, "droppedNoteCount")
    }
  };
}

function parseJournal(value: unknown): DiaryJournal {
  const record = readRecordValue(value, "diary journal");
  if (!Array.isArray(record.notes)) {
    throw new Error("Invalid diary journal notes.");
  }
  return {
    notes: record.notes.map(parseEpisodeNote),
    comment: readString(record, "comment")
  };
}

function parseEpisode(value: unknown): DiaryEpisode {
  const record = readRecordValue(value, "diary episode");
  if (!Array.isArray(record.notes)) {
    throw new Error("Invalid diary episode notes.");
  }
  return {
    title: readString(record, "title"),
    caption: readString(record, "caption"),
    comment: readString(record, "comment"),
    notes: record.notes.map(parseEpisodeNote)
  };
}

function parseEpisodeNote(value: unknown): DiaryEpisodeNote {
  const noteRecord = readRecordValue(value, "diary episode note");
  return {
    id: readString(noteRecord, "id"),
    day: readString(noteRecord, "day"),
    topic: readNullableString(noteRecord, "topic"),
    content: readString(noteRecord, "content")
  };
}

function readRecordValue(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return field;
}

function readNullableString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (field === null) {
    return null;
  }
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string or null.`);
  }
  return field;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

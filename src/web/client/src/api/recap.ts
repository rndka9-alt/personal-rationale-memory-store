import { requestJson } from "./http";

export type RecapTotals = {
  noteCount: number;
  retrievalCount: number;
  usageEventCount: number;
  rationaleRevisionCount: number;
  activeDayCount: number;
};

export type RecapDailyPoint = {
  date: string;
  noteCount: number;
  retrievalCount: number;
  usageEventCount: number;
  rationaleRevisionCount: number;
};

export type RecapReport = {
  periodDays: number;
  timeZone: string;
  totals: RecapTotals;
  daily: RecapDailyPoint[];
  byWeekday: Array<{ weekday: number; eventCount: number }>;
  byHour: Array<{ hour: number; eventCount: number }>;
  topics: Array<{ topic: string | null; noteCount: number }>;
  retrieval: {
    queryCount: number;
    zeroHitCount: number;
    averageTopScore: number | null;
    byClient: Array<{ clientName: string | null; queryCount: number }>;
    byProject: Array<{ projectName: string | null; queryCount: number }>;
    recentQueries: Array<{
      query: string;
      sourceKind: string;
      projectName: string | null;
      resultCount: number;
      createdAt: string;
    }>;
  };
  rationales: {
    capturedCount: number;
    revisedCount: number;
    byProject: Array<{ projectName: string | null; revisionCount: number }>;
  };
  usageByEventType: Array<{ eventType: string; eventCount: number }>;
  llm: {
    requestCount: number;
    costUsd: number;
    totalTokens: number;
  };
};

export async function fetchRecap(days: number): Promise<RecapReport> {
  const params = new URLSearchParams({ days: String(days) });
  const data = await requestJson(`/api/recap?${params.toString()}`);
  if (
    !isRecord(data)
    || !isRecord(data.totals)
    || !Array.isArray(data.daily)
    || !Array.isArray(data.byWeekday)
    || !Array.isArray(data.byHour)
    || !Array.isArray(data.topics)
    || !isRecord(data.retrieval)
    || !isRecord(data.rationales)
    || !Array.isArray(data.usageByEventType)
    || !isRecord(data.llm)
  ) {
    throw new Error("Invalid recap response.");
  }
  const retrieval = data.retrieval;
  const rationales = data.rationales;
  if (
    !Array.isArray(retrieval.byClient)
    || !Array.isArray(retrieval.byProject)
    || !Array.isArray(retrieval.recentQueries)
    || !Array.isArray(rationales.byProject)
  ) {
    throw new Error("Invalid recap response.");
  }

  return {
    periodDays: readNumber(data, "periodDays"),
    timeZone: readString(data, "timeZone"),
    totals: {
      noteCount: readNumber(data.totals, "noteCount"),
      retrievalCount: readNumber(data.totals, "retrievalCount"),
      usageEventCount: readNumber(data.totals, "usageEventCount"),
      rationaleRevisionCount: readNumber(data.totals, "rationaleRevisionCount"),
      activeDayCount: readNumber(data.totals, "activeDayCount")
    },
    daily: data.daily.map(parseDailyPoint),
    byWeekday: data.byWeekday.map((value) => {
      const record = readRecordValue(value, "recap weekday entry");
      return { weekday: readNumber(record, "weekday"), eventCount: readNumber(record, "eventCount") };
    }),
    byHour: data.byHour.map((value) => {
      const record = readRecordValue(value, "recap hour entry");
      return { hour: readNumber(record, "hour"), eventCount: readNumber(record, "eventCount") };
    }),
    topics: data.topics.map((value) => {
      const record = readRecordValue(value, "recap topic entry");
      return { topic: readNullableString(record, "topic"), noteCount: readNumber(record, "noteCount") };
    }),
    retrieval: {
      queryCount: readNumber(retrieval, "queryCount"),
      zeroHitCount: readNumber(retrieval, "zeroHitCount"),
      averageTopScore: readNullableNumber(retrieval, "averageTopScore"),
      byClient: retrieval.byClient.map((value) => {
        const record = readRecordValue(value, "recap client entry");
        return { clientName: readNullableString(record, "clientName"), queryCount: readNumber(record, "queryCount") };
      }),
      byProject: retrieval.byProject.map((value) => {
        const record = readRecordValue(value, "recap query project entry");
        return { projectName: readNullableString(record, "projectName"), queryCount: readNumber(record, "queryCount") };
      }),
      recentQueries: retrieval.recentQueries.map((value) => {
        const record = readRecordValue(value, "recap recent query entry");
        return {
          query: readString(record, "query"),
          sourceKind: readString(record, "sourceKind"),
          projectName: readNullableString(record, "projectName"),
          resultCount: readNumber(record, "resultCount"),
          createdAt: readString(record, "createdAt")
        };
      })
    },
    rationales: {
      capturedCount: readNumber(rationales, "capturedCount"),
      revisedCount: readNumber(rationales, "revisedCount"),
      byProject: rationales.byProject.map((value) => {
        const record = readRecordValue(value, "recap rationale project entry");
        return {
          projectName: readNullableString(record, "projectName"),
          revisionCount: readNumber(record, "revisionCount")
        };
      })
    },
    usageByEventType: data.usageByEventType.map((value) => {
      const record = readRecordValue(value, "recap usage event entry");
      return { eventType: readString(record, "eventType"), eventCount: readNumber(record, "eventCount") };
    }),
    llm: {
      requestCount: readNumber(data.llm, "requestCount"),
      costUsd: readNumber(data.llm, "costUsd"),
      totalTokens: readNumber(data.llm, "totalTokens")
    }
  };
}

export type RecapCardEvidence = {
  type: "note" | "query" | "rationale";
  text: string;
  date: string;
  detail: string | null;
};

export type RecapCard = {
  kind: string;
  title: string;
  body: string;
  stat: { label: string; value: string; comparison: string | null };
  reason: string;
  evidence: RecapCardEvidence[];
};

export type RecapSnapshotResult = {
  opening: string;
  cards: RecapCard[];
  themes: Array<{ name: string; currentCount: number; comparisonCount: number; topics: string[] }>;
};

export type RecapSnapshot = {
  id: string;
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  comparisonStart: string;
  comparisonEnd: string;
  generatedAt: string;
  result: RecapSnapshotResult;
};

export type RecapFreshness = {
  isStale: boolean;
  newPeriodAvailable: boolean;
  newNoteEvents: number;
  newRetrievalEvents: number;
  newUsageEvents: number;
  newRevisionEvents: number;
};

export type RecapSnapshotResponse = {
  snapshot: RecapSnapshot | null;
  freshness: RecapFreshness | null;
  synthesisEnabled: boolean;
};

export type RecapRefreshResponse =
  | { status: "exists"; snapshotId: string }
  | { status: "already_running" | "started"; runId: string };

export type RecapRun = {
  id: string;
  status: "running" | "succeeded" | "failed";
  periodDays: number;
  requestedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
};

export async function fetchRecapSnapshot(days: number): Promise<RecapSnapshotResponse> {
  const params = new URLSearchParams({ days: String(days) });
  const data = await requestJson(`/api/recap/snapshot?${params.toString()}`);
  if (!isRecord(data) || typeof data.synthesisEnabled !== "boolean") {
    throw new Error("Invalid recap snapshot response.");
  }
  return {
    snapshot: data.snapshot === null ? null : parseSnapshot(data.snapshot),
    freshness: data.freshness === null ? null : parseFreshness(data.freshness),
    synthesisEnabled: data.synthesisEnabled
  };
}

export async function requestRecapRefresh(days: number): Promise<RecapRefreshResponse> {
  const data = await requestJson("/api/recap/refresh", { method: "POST", body: { days } });
  if (!isRecord(data)) {
    throw new Error("Invalid recap refresh response.");
  }
  if (data.status === "exists") {
    return { status: "exists", snapshotId: readString(data, "snapshotId") };
  }
  if (data.status === "already_running" || data.status === "started") {
    return { status: data.status, runId: readString(data, "runId") };
  }
  throw new Error("Invalid recap refresh status.");
}

export async function fetchRecapRun(runId: string): Promise<RecapRun> {
  const data = await requestJson(`/api/recap/runs/${encodeURIComponent(runId)}`);
  if (!isRecord(data)) {
    throw new Error("Invalid recap run response.");
  }
  const status = data.status;
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new Error("Invalid recap run status.");
  }
  return {
    id: readString(data, "id"),
    status,
    periodDays: readNumber(data, "periodDays"),
    requestedAt: readString(data, "requestedAt"),
    finishedAt: readNullableString(data, "finishedAt"),
    error: readNullableString(data, "error"),
    snapshotId: readNullableString(data, "snapshotId")
  };
}

function parseSnapshot(value: unknown): RecapSnapshot {
  const record = readRecordValue(value, "recap snapshot");
  return {
    id: readString(record, "id"),
    periodDays: readNumber(record, "periodDays"),
    periodStart: readString(record, "periodStart"),
    periodEnd: readString(record, "periodEnd"),
    comparisonStart: readString(record, "comparisonStart"),
    comparisonEnd: readString(record, "comparisonEnd"),
    generatedAt: readString(record, "generatedAt"),
    result: parseSnapshotResult(record.result)
  };
}

function parseSnapshotResult(value: unknown): RecapSnapshotResult {
  const record = readRecordValue(value, "recap snapshot result");
  if (!Array.isArray(record.cards) || !Array.isArray(record.themes)) {
    throw new Error("Invalid recap snapshot result.");
  }
  return {
    opening: readString(record, "opening"),
    cards: record.cards.map(parseCard),
    themes: record.themes.map((theme) => {
      const themeRecord = readRecordValue(theme, "recap theme");
      if (!Array.isArray(themeRecord.topics)) {
        throw new Error("Invalid recap theme topics.");
      }
      return {
        name: readString(themeRecord, "name"),
        currentCount: readNumber(themeRecord, "currentCount"),
        comparisonCount: readNumber(themeRecord, "comparisonCount"),
        topics: themeRecord.topics.map((topic) => {
          if (typeof topic !== "string") {
            throw new Error("Invalid recap theme topic.");
          }
          return topic;
        })
      };
    })
  };
}

function parseCard(value: unknown): RecapCard {
  const record = readRecordValue(value, "recap card");
  const statRecord = readRecordValue(record.stat, "recap card stat");
  if (!Array.isArray(record.evidence)) {
    throw new Error("Invalid recap card evidence.");
  }
  return {
    kind: readString(record, "kind"),
    title: readString(record, "title"),
    body: readString(record, "body"),
    stat: {
      label: readString(statRecord, "label"),
      value: readString(statRecord, "value"),
      comparison: readNullableString(statRecord, "comparison")
    },
    reason: readString(record, "reason"),
    evidence: record.evidence.map((item) => {
      const evidenceRecord = readRecordValue(item, "recap card evidence");
      const type = evidenceRecord.type;
      if (type !== "note" && type !== "query" && type !== "rationale") {
        throw new Error("Invalid recap evidence type.");
      }
      return {
        type,
        text: readString(evidenceRecord, "text"),
        date: readString(evidenceRecord, "date"),
        detail: readNullableString(evidenceRecord, "detail")
      };
    })
  };
}

function parseFreshness(value: unknown): RecapFreshness {
  const record = readRecordValue(value, "recap freshness");
  if (typeof record.isStale !== "boolean" || typeof record.newPeriodAvailable !== "boolean") {
    throw new Error("Invalid recap freshness response.");
  }
  return {
    isStale: record.isStale,
    newPeriodAvailable: record.newPeriodAvailable,
    newNoteEvents: readNumber(record, "newNoteEvents"),
    newRetrievalEvents: readNumber(record, "newRetrievalEvents"),
    newUsageEvents: readNumber(record, "newUsageEvents"),
    newRevisionEvents: readNumber(record, "newRevisionEvents")
  };
}

function parseDailyPoint(value: unknown): RecapDailyPoint {
  const record = readRecordValue(value, "recap daily entry");
  return {
    date: readString(record, "date"),
    noteCount: readNumber(record, "noteCount"),
    retrievalCount: readNumber(record, "retrievalCount"),
    usageEventCount: readNumber(record, "usageEventCount"),
    rationaleRevisionCount: readNumber(record, "rationaleRevisionCount")
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

function readNullableNumber(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return field === null ? null : readNumber(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

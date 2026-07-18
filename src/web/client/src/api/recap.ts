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

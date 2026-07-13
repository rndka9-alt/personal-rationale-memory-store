import { requestJson } from "./http";
import type { Pagination } from "../types/pagination";

export type LlmRequestAggregate = {
  costUsd: number;
  requestCount: number;
  failedCount: number;
};

export type LlmRequestRecord = {
  id: string;
  requestedAt: string;
  purpose: string;
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  error: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
  runId: string | null;
};

export type LlmRequestSummary = {
  total: LlmRequestAggregate;
  thisMonth: LlmRequestAggregate;
  last7Days: LlmRequestAggregate;
  daily: Array<{ date: string; costUsd: number; requestCount: number }>;
  byPurpose: Array<{ purpose: string; costUsd: number; requestCount: number }>;
  byModel: Array<{ model: string; costUsd: number; requestCount: number }>;
};

export async function fetchLlmRequests(page: number, pageSize: number) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize)
  });
  const data = await requestJson(`/api/llm-requests?${params.toString()}`);
  if (!isRecord(data) || !Array.isArray(data.requests) || !isRecord(data.pagination)) {
    throw new Error("Invalid LLM request list response.");
  }
  return {
    requests: data.requests.map(parseLlmRequestRecord),
    pagination: parsePagination(data.pagination)
  };
}

export async function fetchLlmRequestSummary(): Promise<LlmRequestSummary> {
  const data = await requestJson("/api/llm-requests/summary");
  if (
    !isRecord(data)
    || !isRecord(data.total)
    || !isRecord(data.thisMonth)
    || !isRecord(data.last7Days)
    || !Array.isArray(data.daily)
    || !Array.isArray(data.byPurpose)
    || !Array.isArray(data.byModel)
  ) {
    throw new Error("Invalid LLM request summary response.");
  }

  return {
    total: parseAggregate(data.total),
    thisMonth: parseAggregate(data.thisMonth),
    last7Days: parseAggregate(data.last7Days),
    daily: data.daily.map((value) => parseDaily(value)),
    byPurpose: data.byPurpose.map(parsePurposeGroup),
    byModel: data.byModel.map(parseModelGroup)
  };
}

function parseLlmRequestRecord(value: unknown): LlmRequestRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid LLM request record.");
  }
  const status = value.status;
  if (status !== "succeeded" && status !== "failed") {
    throw new Error("Invalid LLM request status.");
  }
  return {
    id: readString(value, "id"),
    requestedAt: readString(value, "requestedAt"),
    purpose: readString(value, "purpose"),
    provider: readString(value, "provider"),
    model: readString(value, "model"),
    status,
    error: readNullableString(value, "error"),
    durationMs: readNumber(value, "durationMs"),
    inputTokens: readNullableNumber(value, "inputTokens"),
    outputTokens: readNullableNumber(value, "outputTokens"),
    totalTokens: readNullableNumber(value, "totalTokens"),
    cachedInputTokens: readNullableNumber(value, "cachedInputTokens"),
    cacheCreationInputTokens: readNullableNumber(value, "cacheCreationInputTokens"),
    costUsd: readNullableNumber(value, "costUsd"),
    runId: readNullableString(value, "runId")
  };
}

function parseAggregate(value: Record<string, unknown>): LlmRequestAggregate {
  return {
    costUsd: readNumber(value, "costUsd"),
    requestCount: readNumber(value, "requestCount"),
    failedCount: readNumber(value, "failedCount")
  };
}

function parsePagination(value: Record<string, unknown>): Pagination {
  return {
    page: readNumber(value, "page"),
    pageSize: readNumber(value, "pageSize"),
    totalItems: readNumber(value, "totalItems"),
    totalPages: readNumber(value, "totalPages")
  };
}

function parseDaily(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid daily LLM request summary.");
  }
  return {
    date: readString(value, "date"),
    costUsd: readNumber(value, "costUsd"),
    requestCount: readNumber(value, "requestCount")
  };
}

function parsePurposeGroup(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid LLM request purpose summary.");
  }
  return {
    purpose: readString(value, "purpose"),
    costUsd: readNumber(value, "costUsd"),
    requestCount: readNumber(value, "requestCount")
  };
}

function parseModelGroup(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid LLM request model summary.");
  }
  return {
    model: readString(value, "model"),
    costUsd: readNumber(value, "costUsd"),
    requestCount: readNumber(value, "requestCount")
  };
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

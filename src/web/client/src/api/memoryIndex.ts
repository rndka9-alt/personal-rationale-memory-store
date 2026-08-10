import { requestJson } from "./http";
import type { Pagination } from "../types/pagination";

export type MemoryIndexStatusFilter = "active" | "retired" | "all";

export type MemoryIndexLineStatus = "active" | "retired";

/** 색인 줄 한 개. 트리거 문구는 compose_context 상단에 그대로 실리는 인출 단서다. */
export type MemoryIndexLine = {
  id: string;
  triggerPhrase: string;
  projectName: string | null;
  status: MemoryIndexLineStatus;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

/** 색인 줄을 떠받치는 메모리 한 건. addedAt이 그 문서가 이 줄로 수집된 시각이다. */
export type MemoryIndexLineMember = {
  entryId: string;
  title: string;
  projectName: string | null;
  isAnchor: boolean;
  deprecated: boolean;
  addedAt: string;
  capturedAt: string;
};

export type MemoryIndexLineDetail = {
  line: MemoryIndexLine;
  members: MemoryIndexLineMember[];
};

export type MemoryIndexFilters = {
  status: MemoryIndexStatusFilter;
  search?: string;
  page: number;
  pageSize: number;
};

export async function fetchMemoryIndexLines(filters: MemoryIndexFilters) {
  const params = new URLSearchParams({
    status: filters.status,
    page: String(filters.page),
    pageSize: String(filters.pageSize)
  });
  if (filters.search) {
    params.set("search", filters.search);
  }
  const data = await requestJson(`/api/memory-index?${params.toString()}`);
  return parseMemoryIndexLinesResponse(data);
}

export async function fetchMemoryIndexComposePreview() {
  const data = await requestJson("/api/memory-index/compose-preview");
  if (!isRecord(data)) {
    throw new Error("Invalid memory index compose preview.");
  }
  return readRequiredString(data, "text");
}

export async function fetchMemoryIndexLineDetail(id: string) {
  const data = await requestJson(`/api/memory-index/${encodeURIComponent(id)}`);
  return parseMemoryIndexLineDetail(data);
}

export async function updateMemoryIndexLineStatus(id: string, status: MemoryIndexLineStatus) {
  const data = await requestJson(`/api/memory-index/${encodeURIComponent(id)}/status`, {
    method: "POST",
    body: { status }
  });
  return parseMemoryIndexLineDetail(data);
}

function parseMemoryIndexLinesResponse(value: unknown): {
  lines: MemoryIndexLine[];
  pagination: Pagination;
} {
  if (!isRecord(value) || !Array.isArray(value.lines) || !isRecord(value.pagination)) {
    throw new Error("Invalid memory index response.");
  }

  return {
    lines: value.lines.map(parseMemoryIndexLine),
    pagination: parsePagination(value.pagination)
  };
}

function parseMemoryIndexLineDetail(value: unknown): MemoryIndexLineDetail {
  if (!isRecord(value) || !Array.isArray(value.members)) {
    throw new Error("Invalid memory index line detail.");
  }

  return {
    line: parseMemoryIndexLine(value.line),
    members: value.members.map(parseMemoryIndexLineMember)
  };
}

function parseMemoryIndexLine(value: unknown): MemoryIndexLine {
  if (!isRecord(value)) {
    throw new Error("Invalid memory index line.");
  }

  return {
    id: readRequiredString(value, "id"),
    triggerPhrase: readRequiredString(value, "triggerPhrase"),
    projectName: readNullableString(value, "projectName"),
    status: readLineStatus(value, "status"),
    memberCount: readNumber(value, "memberCount"),
    createdAt: readRequiredString(value, "createdAt"),
    updatedAt: readRequiredString(value, "updatedAt")
  };
}

function parseMemoryIndexLineMember(value: unknown): MemoryIndexLineMember {
  if (!isRecord(value)) {
    throw new Error("Invalid memory index line member.");
  }

  return {
    entryId: readRequiredString(value, "entryId"),
    title: readRequiredString(value, "title"),
    projectName: readNullableString(value, "projectName"),
    isAnchor: readBoolean(value, "isAnchor"),
    deprecated: readBoolean(value, "deprecated"),
    addedAt: readRequiredString(value, "addedAt"),
    capturedAt: readRequiredString(value, "capturedAt")
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

function readLineStatus(value: Record<string, unknown>, key: string): MemoryIndexLineStatus {
  const propertyValue = value[key];
  if (propertyValue !== "active" && propertyValue !== "retired") {
    throw new Error(`Expected ${key} to be a memory index line status.`);
  }
  return propertyValue;
}

function readRequiredString(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return propertyValue;
}

function readNullableString(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (propertyValue === null) {
    return null;
  }
  if (typeof propertyValue !== "string") {
    throw new Error(`Expected ${key} to be a string or null.`);
  }
  return propertyValue;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "number") {
    throw new Error(`Expected ${key} to be a number.`);
  }
  return propertyValue;
}

function readBoolean(value: Record<string, unknown>, key: string) {
  const propertyValue = value[key];
  if (typeof propertyValue !== "boolean") {
    throw new Error(`Expected ${key} to be a boolean.`);
  }
  return propertyValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

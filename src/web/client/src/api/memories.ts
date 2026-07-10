import { requestJson } from "./http";
import type { Pagination } from "../types/pagination";
import type { ProjectContext } from "../types/review";

export type MemoryCatalogStatus = "current" | "deprecated" | "all";

export type MemoryCatalogSortMode = "created" | "last_used" | "uses";

export type MemoryCatalogFilters = {
  status: MemoryCatalogStatus;
  search?: string;
  sortMode: MemoryCatalogSortMode;
  page: number;
  pageSize: number;
};

export type MemoryCatalogItem = {
  id: string;
  type: string;
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
  title: string;
  summary?: string;
  sourceKind?: string;
  sourceRef?: string;
  project?: ProjectContext;
  confidence: number;
  useCount: number;
  lastUsedAt?: string;
  createdAt?: string;
  metadata: Record<string, unknown>;
};

export async function fetchMemories(filters: MemoryCatalogFilters) {
  const params = new URLSearchParams({
    status: filters.status,
    sortMode: filters.sortMode,
    page: String(filters.page),
    pageSize: String(filters.pageSize)
  });
  if (filters.search) {
    params.set("search", filters.search);
  }

  const data = await requestJson(`/api/memories?${params.toString()}`);
  return parseMemoryCatalogResponse(data);
}

function parseMemoryCatalogResponse(value: unknown): {
  entries: MemoryCatalogItem[];
  pagination: Pagination;
} {
  if (!isRecord(value) || !Array.isArray(value.entries) || !isRecord(value.pagination)) {
    throw new Error("Invalid memory catalog response.");
  }

  return {
    entries: value.entries.map(parseMemoryCatalogItem),
    pagination: {
      page: readNumber(value.pagination, "page"),
      pageSize: readNumber(value.pagination, "pageSize"),
      totalItems: readNumber(value.pagination, "totalItems"),
      totalPages: readNumber(value.pagination, "totalPages")
    }
  };
}

function parseMemoryCatalogItem(value: unknown): MemoryCatalogItem {
  if (!isRecord(value)) {
    throw new Error("Invalid memory catalog item.");
  }

  return {
    id: readRequiredString(value, "id"),
    type: readRequiredString(value, "type"),
    acceptanceState: readRequiredString(value, "acceptanceState"),
    reviewState: readRequiredString(value, "reviewState"),
    decisionState: readRequiredString(value, "decisionState"),
    title: readRequiredString(value, "title"),
    summary: readOptionalString(value, "summary"),
    sourceKind: readOptionalString(value, "sourceKind"),
    sourceRef: readOptionalString(value, "sourceRef"),
    project: parseProject(value.project),
    confidence: readNumber(value, "confidence"),
    useCount: readNumber(value, "useCount"),
    lastUsedAt: readOptionalString(value, "lastUsedAt"),
    createdAt: readOptionalString(value, "createdAt"),
    metadata: readRecord(value, "metadata")
  };
}

function parseProject(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  const project: ProjectContext = { name: readRequiredString(value, "name") };
  const repo = readOptionalString(value, "repo");
  const root = readOptionalString(value, "root");
  if (repo) {
    project.repo = repo;
  }
  if (root) {
    project.root = root;
  }
  return project;
}

function readRequiredString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }
  return field;
}

function readOptionalString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (field === undefined || field === null) {
    return undefined;
  }
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
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

function readRecord(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (!isRecord(field)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

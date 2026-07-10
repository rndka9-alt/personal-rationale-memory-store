import { requestJson } from "./http";
import type {
  ProjectContext,
  ReviewAction,
  ReviewQueueDetail,
  ReviewQueueItem,
  UsageFeedbackCounts
} from "../types/review";
import type { Pagination } from "../types/pagination";

export type ReviewQueueSortMode =
  | "priority"
  | "created"
  | "last_used"
  | "positive_feedback"
  | "negative_feedback"
  | "uses";

export type ReviewQueueSignalFilter =
  | "all"
  | "repair_attention"
  | "with_negative_feedback"
  | "with_positive_feedback"
  | "recently_used";

export type ReviewQueueFilters = {
  captureKind?: string;
  reviewState: string;
  search?: string;
  sortMode: ReviewQueueSortMode;
  signalFilter: ReviewQueueSignalFilter;
  page: number;
  pageSize: number;
};

export async function fetchReviewQueue(filters: ReviewQueueFilters) {
  const params = new URLSearchParams({
    reviewState: filters.reviewState,
    sortMode: filters.sortMode,
    signalFilter: filters.signalFilter,
    page: String(filters.page),
    pageSize: String(filters.pageSize)
  });

  if (filters.captureKind) {
    params.set("captureKind", filters.captureKind);
  }
  if (filters.search) {
    params.set("search", filters.search);
  }

  const data = await requestJson(`/api/review-queue?${params.toString()}`);
  return parseReviewQueueResponse(data);
}

export async function fetchReviewQueueDetail(id: string) {
  const data = await requestJson(`/api/review-queue/${encodeURIComponent(id)}`);
  return parseReviewQueueDetail(data);
}

export async function submitReviewAction(input: {
  id: string;
  action: ReviewAction;
  notes?: string;
  reason?: string;
}) {
  await requestJson(`/api/review-queue/${encodeURIComponent(input.id)}/review`, {
    method: "POST",
    body: {
      action: input.action,
      notes: input.notes,
      reason: input.reason
    }
  });
}

function parseReviewQueueResponse(value: unknown): {
  items: ReviewQueueItem[];
  pagination: Pagination;
} {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.pagination)) {
    throw new Error("Invalid review queue response.");
  }

  return {
    items: value.items.map(parseReviewQueueItem),
    pagination: parsePagination(value.pagination)
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

function parseReviewQueueItem(value: unknown): ReviewQueueItem {
  if (!isRecord(value)) {
    throw new Error("Invalid review queue item.");
  }

  const id = readRequiredString(value, "id");
  const title = readRequiredString(value, "title");
  const type = readRequiredString(value, "type");
  const acceptanceState = readRequiredString(value, "acceptanceState");
  const reviewState = readRequiredString(value, "reviewState");
  const decisionState = readRequiredString(value, "decisionState");
  const status = readRequiredString(value, "status");
  const canonicalPath = readRequiredString(value, "canonicalPath");
  const scope = readRequiredString(value, "scope");
  const confidence = readNumber(value, "confidence");

  return {
    id,
    title,
    type,
    acceptanceState,
    reviewState,
    decisionState,
    status,
    canonicalPath,
    scope,
    confidence,
    summary: readOptionalString(value, "summary"),
    sourceKind: readOptionalString(value, "sourceKind"),
    sourceRef: readOptionalString(value, "sourceRef"),
    project: parseProject(value.project),
    useCount: readNumber(value, "useCount"),
    lastUsedAt: readOptionalString(value, "lastUsedAt"),
    createdAt: readOptionalString(value, "createdAt"),
    usageFeedback: parseUsageFeedback(value.usageFeedback),
    reviewPriorityScore: readNumber(value, "reviewPriorityScore"),
    reviewPriorityReasons: readStringArray(value, "reviewPriorityReasons"),
    metadata: readRecord(value, "metadata")
  };
}

function parseReviewQueueDetail(value: unknown): ReviewQueueDetail {
  if (!isRecord(value) || !isRecord(value.entry) || !isRecord(value.review)) {
    throw new Error("Invalid review queue detail response.");
  }

  return {
    entry: parseRationaleEntry(value.entry),
    review: {
      id: readRequiredString(value.review, "id"),
      title: readRequiredString(value.review, "title"),
      strengths: readStringArray(value.review, "strengths"),
      cautions: readStringArray(value.review, "cautions")
    },
    usage: parseUsage(value.usage)
  };
}

function parseUsage(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid usage facts.");
  }

  return {
    useCount: readNumber(value, "useCount"),
    lastUsedAt: readOptionalString(value, "lastUsedAt"),
    feedback: parseUsageFeedback(value.feedback)
  };
}

function parseUsageFeedback(value: unknown): UsageFeedbackCounts {
  if (!isRecord(value)) {
    throw new Error("Invalid usage feedback counts.");
  }

  return {
    appliedCount: readNumber(value, "appliedCount"),
    helpfulCount: readNumber(value, "helpfulCount"),
    unhelpfulCount: readNumber(value, "unhelpfulCount"),
    dismissedCount: readNumber(value, "dismissedCount"),
    positiveCount: readNumber(value, "positiveCount"),
    negativeCount: readNumber(value, "negativeCount")
  };
}

function parseRationaleEntry(value: Record<string, unknown>) {
  const frontmatterValue = value.frontmatter;
  if (!isRecord(frontmatterValue)) {
    throw new Error("Invalid rationale frontmatter.");
  }

  return {
    frontmatter: {
      id: readRequiredString(frontmatterValue, "id"),
      type: readRequiredString(frontmatterValue, "type"),
      acceptanceState: readRequiredString(frontmatterValue, "acceptanceState"),
      reviewState: readRequiredString(frontmatterValue, "reviewState"),
      decisionState: readRequiredString(frontmatterValue, "decisionState"),
      status: readRequiredString(frontmatterValue, "status"),
      scope: readRequiredString(frontmatterValue, "scope"),
      domains: readStringArray(frontmatterValue, "domains"),
      intents: readStringArray(frontmatterValue, "intents"),
      modes: readStringArray(frontmatterValue, "modes"),
      confidence: readNumber(frontmatterValue, "confidence"),
      project: parseProject(frontmatterValue.project),
      metadata: readRecord(frontmatterValue, "metadata"),
      source: parseSource(frontmatterValue.source)
    },
    title: readRequiredString(value, "title"),
    body: readRequiredString(value, "body"),
    rawMarkdown: readRequiredString(value, "rawMarkdown")
  };
}

function parseSource(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    kind: readRequiredString(value, "kind"),
    ref: readRequiredString(value, "ref")
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
  const fieldValue = value[key];
  if (typeof fieldValue !== "string") {
    throw new Error(`Missing string field: ${key}`);
  }
  return fieldValue;
}

function readOptionalString(value: Record<string, unknown>, key: string) {
  const fieldValue = value[key];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function readNumber(value: Record<string, unknown>, key: string) {
  const fieldValue = value[key];
  if (typeof fieldValue !== "number") {
    throw new Error(`Missing number field: ${key}`);
  }
  return fieldValue;
}

function readStringArray(value: Record<string, unknown>, key: string) {
  const fieldValue = value[key];
  if (!Array.isArray(fieldValue)) {
    return [];
  }
  return fieldValue.filter((item): item is string => typeof item === "string");
}

function readRecord(value: Record<string, unknown>, key: string) {
  const fieldValue = value[key];
  return isRecord(fieldValue) ? fieldValue : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

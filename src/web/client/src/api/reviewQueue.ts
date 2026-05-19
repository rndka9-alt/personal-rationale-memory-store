import { requestJson } from "./http";
import type {
  ProjectContext,
  RefinementOpinionAction,
  RefinementOpinion,
  ReviewAction,
  ReviewQueueDetail,
  ReviewQueueItem
} from "../types/review";

export type ReviewQueueFilters = {
  captureKind?: string;
  reviewState: string;
};

export async function fetchReviewQueue(filters: ReviewQueueFilters) {
  const params = new URLSearchParams({
    reviewState: filters.reviewState
  });

  if (filters.captureKind) {
    params.set("captureKind", filters.captureKind);
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

export async function submitRefinementOpinionAction(input: {
  id: string;
  action: RefinementOpinionAction;
  note?: string;
}) {
  await requestJson(`/api/refinement-opinions/${encodeURIComponent(input.id)}/action`, {
    method: "POST",
    body: {
      action: input.action,
      note: input.note
    }
  });
}

function parseReviewQueueResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Invalid review queue response.");
  }

  return value.items.map(parseReviewQueueItem);
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
    openRefinementOpinionCount: readNumber(value, "openRefinementOpinionCount"),
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
      score: readNumber(value.review, "score"),
      recommendation: parseRecommendation(readRequiredString(value.review, "recommendation")),
      missingSections: readStringArray(value.review, "missingSections"),
      strengths: readStringArray(value.review, "strengths"),
      cautions: readStringArray(value.review, "cautions")
    },
    usage: parseUsage(value.usage),
    refinementOpinions: readRefinementOpinions(value.refinementOpinions)
  };
}

function parseUsage(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid usage facts.");
  }

  return {
    useCount: readNumber(value, "useCount"),
    lastUsedAt: readOptionalString(value, "lastUsedAt")
  };
}

function readRefinementOpinions(value: unknown): RefinementOpinion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((item) => ({
    id: readRequiredString(item, "id"),
    entryId: readRequiredString(item, "entryId"),
    opinionType: readRequiredString(item, "opinionType"),
    status: readRequiredString(item, "status"),
    body: readRequiredString(item, "body"),
    suggestedPatch: readOptionalRecord(item, "suggestedPatch"),
    sourceKind: readRequiredString(item, "sourceKind"),
    sourceRef: readOptionalString(item, "sourceRef"),
    metadata: readRecord(item, "metadata"),
    createdAt: readRequiredString(item, "createdAt"),
    updatedAt: readRequiredString(item, "updatedAt")
  }));
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
    situation: readOptionalString(value, "situation"),
    goal: readOptionalString(value, "goal"),
    constraints: readStringArray(value, "constraints"),
    decision: readOptionalString(value, "decision"),
    rationale: readRequiredString(value, "rationale"),
    rejectedAlternatives: readRejectedAlternatives(value.rejectedAlternatives),
    tradeoff: readOptionalString(value, "tradeoff"),
    reuseWhen: readStringArray(value, "reuseWhen"),
    avoidWhen: readStringArray(value, "avoidWhen"),
    rawMarkdown: readRequiredString(value, "rawMarkdown")
  };
}

function readRejectedAlternatives(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      option: readRequiredString(item, "option"),
      reason: readRequiredString(item, "reason")
    }));
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

function parseRecommendation(value: string) {
  if (value === "accept" || value === "revise" || value === "deprecate") {
    return value;
  }

  throw new Error("Invalid recommendation.");
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

function readOptionalRecord(value: Record<string, unknown>, key: string) {
  const fieldValue = value[key];
  return isRecord(fieldValue) ? fieldValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

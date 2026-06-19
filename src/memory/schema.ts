import { z } from "zod";

export const rejectedAlternativeSchema = z.object({
  option: z.string().min(1),
  reason: z.string().min(1)
});

export const sourceMetadataSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1)
});

export const projectContextSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
  root: z.string().min(1).optional()
});

export const acceptanceStateSchema = z.enum(["candidate", "accepted", "deprecated"]);
export const reviewStateSchema = z.enum(["unreviewed", "reviewed", "needs_revision"]);
export const decisionStateSchema = z.enum(["proposed", "decided", "superseded", "unknown"]);
export const memoryUsageEventTypeSchema = z.enum([
  "retrieved",
  "composed",
  "applied",
  "dismissed",
  "user_helpful",
  "user_unhelpful"
]);
export const usageFeedbackEventTypeSchema = z.enum([
  "applied",
  "dismissed",
  "user_helpful",
  "user_unhelpful"
]);
export const refinementOpinionTypeSchema = z.enum(["opinion", "patch_request", "correction", "question"]);
export const refinementOpinionStatusSchema = z.enum(["open", "resolved", "rejected"]);

export const rationaleFrontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).default("rationale"),
  // Deprecated compatibility field. Use acceptanceState, reviewState, and decisionState for lifecycle logic.
  status: z.string().min(1).default("candidate"),
  acceptanceState: acceptanceStateSchema.default("candidate"),
  reviewState: reviewStateSchema.default("unreviewed"),
  decisionState: decisionStateSchema.default("unknown"),
  scope: z.string().min(1).default("general"),
  domains: z.array(z.string()).default([]),
  intents: z.array(z.string()).default([]),
  modes: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  source: sourceMetadataSchema.optional(),
  project: projectContextSchema.optional(),
  promotedTo: z.string().optional(),
  deprecatedBy: z.string().optional(),
  metadata: z.record(z.unknown()).default({})
});

export const rationaleEntrySchema = z.object({
  frontmatter: rationaleFrontmatterSchema,
  title: z.string().min(1),
  situation: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  decision: z.string().optional(),
  rationale: z.string().min(1),
  rejectedAlternatives: z.array(rejectedAlternativeSchema).default([]),
  tradeoff: z.string().optional(),
  reuseWhen: z.array(z.string()).default([]),
  avoidWhen: z.array(z.string()).default([]),
  rawMarkdown: z.string().default("")
});

// Principle is excluded on purpose: principles are created only by promoting
// accepted rationale, so capture inputs cannot mint them directly.
export const capturedMemoryTypeSchema = z.enum([
  "rationale",
  "known_failure",
  "preference",
  "convention",
  "constraint"
]);

export const recordCandidateInputSchema = z.object({
  title: z.string().min(1),
  type: capturedMemoryTypeSchema.optional(),
  situation: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  decision: z.string().optional(),
  rationale: z.string().min(1),
  rejectedAlternatives: z.array(rejectedAlternativeSchema).optional(),
  tradeoff: z.string().optional(),
  reuseWhen: z.array(z.string()).optional(),
  avoidWhen: z.array(z.string()).optional(),
  source: sourceMetadataSchema.optional(),
  project: projectContextSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

export const autoCaptureRationaleInputSchema = z.object({
  title: recordCandidateInputSchema.shape.title,
  type: recordCandidateInputSchema.shape.type,
  situation: recordCandidateInputSchema.shape.situation,
  goal: recordCandidateInputSchema.shape.goal,
  constraints: recordCandidateInputSchema.shape.constraints,
  decision: recordCandidateInputSchema.shape.decision,
  rationale: recordCandidateInputSchema.shape.rationale,
  rejectedAlternatives: recordCandidateInputSchema.shape.rejectedAlternatives,
  tradeoff: recordCandidateInputSchema.shape.tradeoff,
  reuseWhen: recordCandidateInputSchema.shape.reuseWhen,
  avoidWhen: recordCandidateInputSchema.shape.avoidWhen,
  source: sourceMetadataSchema.optional(),
  project: projectContextSchema.optional(),
  captureReason: z.string().min(1).optional(),
  sessionRef: z.string().optional(),
  metadata: recordCandidateInputSchema.shape.metadata
});

export const recordRefinementOpinionInputSchema = z.object({
  entryId: z.string().min(1),
  opinionType: refinementOpinionTypeSchema.default("opinion"),
  body: z.string().min(1).max(2000),
  suggestedPatch: z.record(z.unknown()).optional(),
  source: sourceMetadataSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

export const recordUsageFeedbackInputSchema = z.object({
  entryId: z.string().min(1),
  eventType: usageFeedbackEventTypeSchema,
  task: z.string().min(1).optional(),
  source: sourceMetadataSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

export const noteContentSchema = z.string()
  .min(1)
  .max(1000)
  .refine((value) => value.trim().length > 0, "Note content cannot be blank.");

export const noteSourceConversationRoleSchema = z.enum(["user", "assistant"]);

export const noteSourceConversationMessageSchema = z.object({
  role: noteSourceConversationRoleSchema,
  text: z.string()
    .min(1)
    .max(1500)
    .refine((value) => value.trim().length > 0, "Source conversation text cannot be blank.")
});

export const noteSourceConversationSchema = z.object({
  messages: z.array(noteSourceConversationMessageSchema).min(1).max(4)
});

export const recordNoteInputSchema = z.object({
  content: noteContentSchema,
  topic: z.string().min(1).max(120).optional(),
  sourceConversation: noteSourceConversationSchema.optional()
});

export const noteRatingSchema = z.enum(["up", "down"]);

export const rateNoteInputSchema = z.object({
  noteId: z.string().min(1),
  rating: noteRatingSchema
});

export const archiveNoteInputSchema = z.object({
  noteId: z.string().min(1)
});

export const composeNotesContextInputSchema = z.object({
  maxLength: z.number().int().positive().max(20000).optional()
});

// Ranking-only signal: boosts matching-project entries without filtering or
// penalizing other projects, so cross-project rationale stays discoverable.
export const searchProjectFilterSchema = z.object({
  name: projectContextSchema.shape.name,
  repo: projectContextSchema.shape.repo
});

export const searchInputSchema = z.object({
  query: z.string().min(1),
  domains: z.array(z.string()).optional(),
  intents: z.array(z.string()).optional(),
  modes: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  excludeTypes: z.array(z.string()).optional(),
  project: searchProjectFilterSchema.optional(),
  acceptanceStates: z.array(acceptanceStateSchema).optional(),
  reviewStates: z.array(reviewStateSchema).optional(),
  decisionStates: z.array(decisionStateSchema).optional(),
  // Deprecated compatibility filter. Prefer acceptanceStates.
  status: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).default(10),
  includeDeprecated: z.boolean().default(false)
});

export type RationaleEntry = z.infer<typeof rationaleEntrySchema>;
export type CapturedMemoryType = z.infer<typeof capturedMemoryTypeSchema>;
export type RecordCandidateInput = z.infer<typeof recordCandidateInputSchema>;
export type AutoCaptureRationaleInput = z.infer<typeof autoCaptureRationaleInputSchema>;
export type ProjectContext = z.infer<typeof projectContextSchema>;
export type SearchProjectFilter = z.infer<typeof searchProjectFilterSchema>;
export type MemorySearchFilters = Omit<z.infer<typeof searchInputSchema>, "query">;
export type MemoryUsageEventType = z.infer<typeof memoryUsageEventTypeSchema>;
export type UsageFeedbackEventType = z.infer<typeof usageFeedbackEventTypeSchema>;
export type RefinementOpinionType = z.infer<typeof refinementOpinionTypeSchema>;
export type RefinementOpinionStatus = z.infer<typeof refinementOpinionStatusSchema>;
export type RecordRefinementOpinionInput = z.infer<typeof recordRefinementOpinionInputSchema>;
export type RecordUsageFeedbackInput = z.infer<typeof recordUsageFeedbackInputSchema>;
export type NoteSourceConversation = z.infer<typeof noteSourceConversationSchema>;
export type RecordNoteInput = z.infer<typeof recordNoteInputSchema>;
export type NoteRating = z.infer<typeof noteRatingSchema>;
export type RateNoteInput = z.infer<typeof rateNoteInputSchema>;
export type ArchiveNoteInput = z.infer<typeof archiveNoteInputSchema>;
export type ComposeNotesContextInput = z.infer<typeof composeNotesContextInputSchema>;

export type NoteRecord = {
  id: string;
  content: string;
  topic?: string;
  sourceConversation?: NoteSourceConversation;
  upvotes: number;
  downvotes: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryRefinementOpinionRecord = {
  id: string;
  entryId: string;
  opinionType: RefinementOpinionType;
  status: RefinementOpinionStatus;
  body: string;
  suggestedPatch?: Record<string, unknown>;
  sourceKind: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryEntryRecord = {
  id: string;
  type: string;
  /**
   * Deprecated compatibility field. Use acceptanceState/reviewState/decisionState
   * for lifecycle behavior.
   */
  status: string;
  acceptanceState: z.infer<typeof acceptanceStateSchema>;
  reviewState: z.infer<typeof reviewStateSchema>;
  decisionState: z.infer<typeof decisionStateSchema>;
  title: string;
  summary?: string;
  canonicalPath: string;
  scope: string;
  sourceKind?: string;
  sourceRef?: string;
  project?: z.infer<typeof projectContextSchema>;
  confidence: number;
  promotedTo?: string;
  deprecatedBy?: string;
  useCount: number;
  lastUsedAt?: string;
  metadata: Record<string, unknown>;
  lexicalRank?: number;
  vectorScore?: number;
  searchScore?: number;
  searchReasons?: string[];
};

export function toMemoryEntryRecord(entry: RationaleEntry, canonicalPath: string): MemoryEntryRecord {
  const metadata: Record<string, unknown> = {
    ...entry.frontmatter.metadata,
    domains: entry.frontmatter.domains,
    intents: entry.frontmatter.intents,
    modes: entry.frontmatter.modes
  };

  if (entry.frontmatter.project) {
    metadata.project = entry.frontmatter.project;
  }

  return {
    id: entry.frontmatter.id,
    type: entry.frontmatter.type,
    status: entry.frontmatter.status,
    acceptanceState: entry.frontmatter.acceptanceState,
    reviewState: entry.frontmatter.reviewState,
    decisionState: entry.frontmatter.decisionState,
    title: entry.title,
    summary: summarizeRationale(entry),
    canonicalPath,
    scope: entry.frontmatter.scope,
    sourceKind: entry.frontmatter.source?.kind,
    sourceRef: entry.frontmatter.source?.ref,
    project: entry.frontmatter.project,
    confidence: entry.frontmatter.confidence,
    promotedTo: entry.frontmatter.promotedTo,
    deprecatedBy: entry.frontmatter.deprecatedBy,
    useCount: 0,
    metadata
  };
}

export function summarizeRationale(entry: RationaleEntry) {
  const pieces = [entry.situation, entry.decision, entry.rationale].filter(isNonEmptyString);
  return pieces.join(" ").slice(0, 500);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

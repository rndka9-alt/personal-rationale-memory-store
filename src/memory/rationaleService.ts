import type pg from "pg";
import { z } from "zod";
import {
  findMemoryEntry,
  listAllMemoryEntriesByAcceptanceState,
  listMemoryEntriesByAcceptanceState,
  listRecentMemoryEntries,
  recordMemoryUsageEvents,
  searchMemoryEntriesLexical,
  searchMemoryEntriesVector,
  updateMemoryStatus
} from "../db/queries.js";
import type { AppConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../diagnostics/index.js";
import type { EmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { classifyTask } from "../ontology/taskClassifier.js";
import { MemoryFileStore } from "./fileStore.js";
import { IndexingService } from "./indexingService.js";
import {
  acceptanceStateSchema,
  autoCaptureRationaleInputSchema,
  memoryUsageEventTypeSchema,
  projectContextSchema,
  recordCandidateInputSchema,
  reviewStateSchema,
  searchInputSchema,
  type AutoCaptureRationaleInput,
  type MemoryEntryRecord,
  type MemoryUsageEventType,
  type ProjectContext,
  type RecordCandidateInput,
  type RationaleEntry
} from "./schema.js";

const rationalePatchSchema = z.object({
  title: z.string().optional(),
  situation: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  decision: z.string().optional(),
  rationale: z.string().optional(),
  rejectedAlternatives: z.array(z.object({
    option: z.string().min(1),
    reason: z.string().min(1)
  })).optional(),
  tradeoff: z.string().optional(),
  reuseWhen: z.array(z.string()).optional(),
  avoidWhen: z.array(z.string()).optional(),
  type: z.string().optional(),
  acceptanceState: z.enum(["candidate", "accepted", "deprecated"]).optional(),
  reviewState: z.enum(["unreviewed", "reviewed", "needs_revision"]).optional(),
  decisionState: z.enum(["proposed", "decided", "superseded", "unknown"]).optional(),
  // Deprecated compatibility field. Use acceptanceState.
  status: z.string().optional(),
  scope: z.string().optional(),
  domains: z.array(z.string()).optional(),
  intents: z.array(z.string()).optional(),
  modes: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.object({
    kind: z.string().min(1),
    ref: z.string().min(1)
  }).optional(),
  project: projectContextSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

const recordUsageEventInputSchema = z.object({
  entryId: z.string().min(1),
  eventType: memoryUsageEventTypeSchema,
  sourceKind: z.string().min(1),
  sourceRef: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).default({})
});

type RecordUsageEventInput = {
  entryId: string;
  eventType: MemoryUsageEventType;
  sourceKind: string;
  sourceRef?: string;
  task?: string;
  metadata?: Record<string, unknown>;
};

export class RationaleService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fileStore: MemoryFileStore,
    private readonly indexingService: IndexingService,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly config: AppConfig
  ) {}

  async recordCandidate(input: RecordCandidateInput) {
    const validatedInput = recordCandidateInputSchema.parse(input);
    const id = createRationaleId();
    const metadata = normalizeCandidateMetadata(validatedInput.metadata, "manual");
    const project = validatedInput.project ?? readProjectMetadata(validatedInput.metadata);
    const reviewState = readReviewStateMetadata(metadata, "unreviewed");
    const inferredTags = inferRationaleTags(validatedInput);
    const domains = mergeTagValues(getStringArray(validatedInput.metadata, "domains"), inferredTags.domains);
    const intents = mergeTagValues(getStringArray(validatedInput.metadata, "intents"), inferredTags.intents);
    const modes = mergeTagValues(getStringArray(validatedInput.metadata, "modes"), inferredTags.modes);
    logInfo("Recording rationale candidate started.", {
      entryId: id,
      title: validatedInput.title
    });
    const entry: RationaleEntry = {
      frontmatter: {
        id,
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState,
        decisionState: "unknown",
        scope: "general",
        domains,
        intents,
        modes,
        confidence: 0.5,
        source: validatedInput.source,
        project,
        metadata: {
          ...metadata,
          domains,
          intents,
          modes,
          tag_inference_reasons: inferredTags.reasons
        }
      },
      title: validatedInput.title,
      situation: validatedInput.situation,
      goal: validatedInput.goal,
      constraints: validatedInput.constraints ?? [],
      decision: validatedInput.decision,
      rationale: validatedInput.rationale,
      rejectedAlternatives: validatedInput.rejectedAlternatives ?? [],
      tradeoff: validatedInput.tradeoff,
      reuseWhen: validatedInput.reuseWhen ?? [],
      avoidWhen: validatedInput.avoidWhen ?? [],
      rawMarkdown: ""
    };

    const canonicalPath = await this.fileStore.writeEntry(entry);
    await this.indexingService.indexEntry(entry, canonicalPath);
    logInfo("Recording rationale candidate completed.", {
      entryId: id,
      canonicalPath
    });
    return { id, canonicalPath, entry };
  }

  async autoCaptureRationale(input: AutoCaptureRationaleInput) {
    const validatedInput = autoCaptureRationaleInputSchema.parse(input);
    logInfo("Auto-capturing rationale candidate started.", {
      title: validatedInput.title,
      sessionRef: validatedInput.sessionRef
    });

    const metadata = {
      ...validatedInput.metadata,
      capture_kind: "auto",
      review_state: "unreviewed",
      capture_reason: validatedInput.captureReason,
      session_ref: validatedInput.sessionRef,
      captured_at: new Date().toISOString()
    };

    const result = await this.recordCandidate({
      title: validatedInput.title,
      situation: validatedInput.situation,
      goal: validatedInput.goal,
      constraints: validatedInput.constraints,
      decision: validatedInput.decision,
      rationale: validatedInput.rationale,
      rejectedAlternatives: validatedInput.rejectedAlternatives,
      tradeoff: validatedInput.tradeoff,
      reuseWhen: validatedInput.reuseWhen,
      avoidWhen: validatedInput.avoidWhen,
      source: validatedInput.source ?? {
        kind: "auto_capture",
        ref: validatedInput.sessionRef ?? "llm-autonomous"
      },
      project: validatedInput.project,
      metadata
    });

    logInfo("Auto-capturing rationale candidate completed.", {
      entryId: result.id
    });
    return result;
  }

  async getRationale(id: string) {
    logInfo("Reading rationale started.", {
      entryId: id
    });
    const databaseEntry = await findMemoryEntry(this.pool, id);
    const canonicalPath = databaseEntry ? databaseEntry.canonicalPath : this.fileStore.pathForId(id);
    const entry = await this.fileStore.readEntry(canonicalPath);
    logInfo("Reading rationale completed.", {
      entryId: id,
      canonicalPath,
      foundInDatabase: Boolean(databaseEntry)
    });
    return entry;
  }

  async acceptCandidate(id: string) {
    logInfo("Accepting rationale candidate started.", {
      entryId: id
    });
    const entry = await this.getRationale(id);
    entry.frontmatter.acceptanceState = "accepted";
    entry.frontmatter.reviewState = "reviewed";
    entry.frontmatter.status = "accepted";
    entry.frontmatter.metadata = {
      ...entry.frontmatter.metadata,
      review_state: "reviewed"
    };
    const canonicalPath = await this.fileStore.writeEntry(entry);
    await this.indexingService.indexEntry(entry, canonicalPath);
    logInfo("Accepting rationale candidate completed.", {
      entryId: id,
      canonicalPath
    });
    return entry;
  }

  async updateRationale(id: string, patch: Record<string, unknown>) {
    logInfo("Updating rationale started.", {
      entryId: id,
      patchKeys: Object.keys(patch)
    });
    const entry = await this.getRationale(id);
    const updatedEntry = applyRationalePatch(entry, patch);
    const canonicalPath = await this.fileStore.writeEntry(updatedEntry);
    await this.indexingService.indexEntry(updatedEntry, canonicalPath);
    logInfo("Updating rationale completed.", {
      entryId: id,
      canonicalPath
    });
    return updatedEntry;
  }

  async deprecateRationale(id: string, reason: string, replacementId?: string) {
    logInfo("Deprecating rationale started.", {
      entryId: id,
      replacementId
    });
    const entry = await this.getRationale(id);
    entry.frontmatter.acceptanceState = "deprecated";
    entry.frontmatter.status = "deprecated";
    entry.frontmatter.deprecatedBy = replacementId ?? reason;
    entry.frontmatter.metadata = {
      ...entry.frontmatter.metadata,
      deprecation_reason: reason,
      replacement_id: replacementId
    };
    const canonicalPath = await this.fileStore.writeEntry(entry);
    await this.indexingService.indexEntry(entry, canonicalPath);
    await updateMemoryStatus(this.pool, id, "deprecated", { deprecatedBy: replacementId ?? reason });
    logInfo("Deprecating rationale completed.", {
      entryId: id,
      canonicalPath
    });
    return entry;
  }

  async promoteToPrinciple(id: string, title: string | undefined, reason: string) {
    logInfo("Promoting rationale to principle started.", {
      entryId: id,
      hasTitleOverride: typeof title === "string"
    });
    const entry = await this.getRationale(id);
    entry.frontmatter.type = "principle";
    entry.frontmatter.acceptanceState = "accepted";
    entry.frontmatter.reviewState = "reviewed";
    entry.frontmatter.status = "accepted";
    entry.title = title ?? entry.title;
    entry.frontmatter.metadata = {
      ...entry.frontmatter.metadata,
      review_state: "reviewed",
      promoted_reason: reason,
      promoted_from: id
    };
    const canonicalPath = await this.fileStore.writeEntry(entry);
    await this.indexingService.indexEntry(entry, canonicalPath);
    await updateMemoryStatus(this.pool, id, "accepted", { promotedTo: "principle" });
    logInfo("Promoting rationale to principle completed.", {
      entryId: id,
      canonicalPath
    });
    return entry;
  }

  async listRecent(limit: number) {
    logInfo("Listing recent rationales.", {
      limit
    });
    const entries = await listRecentMemoryEntries(this.pool, limit);
    logInfo("Listed recent rationales.", {
      limit,
      resultCount: entries.length
    });
    return entries;
  }

  async listCandidates(limit: number) {
    logInfo("Listing rationale candidates.", {
      limit
    });
    const entries = await listMemoryEntriesByAcceptanceState(this.pool, "candidate", limit);
    logInfo("Listed rationale candidates.", {
      limit,
      resultCount: entries.length
    });
    return entries;
  }

  async listReviewQueue(captureKind?: string, reviewState?: string) {
    logInfo("Listing rationale review queue.", {
      captureKind,
      reviewState
    });
    const entries = await listAllMemoryEntriesByAcceptanceState(this.pool, "candidate");
    const filteredEntries = entries.filter((entry) => {
      const metadataCaptureKind = readStringMetadata(entry.metadata, "capture_kind");
      const captureKindMatches = !captureKind || metadataCaptureKind === captureKind;
      const reviewStateMatches = !reviewState || entry.reviewState === reviewState;
      return captureKindMatches && reviewStateMatches;
    });
    logInfo("Listed rationale review queue.", {
      resultCount: filteredEntries.length
    });
    return filteredEntries;
  }

  async reviewCandidates(limit: number) {
    const candidates = await this.listCandidates(limit);
    const reviewedCandidates = [];

    for (const candidate of candidates) {
      const entry = await this.getRationale(candidate.id);
      reviewedCandidates.push(reviewCandidateEntry(entry));
    }

    return formatCandidateReview(reviewedCandidates);
  }

  async reviewQueue(limit: number, captureKind?: string, reviewState?: string) {
    const queueEntries = (await this.listReviewQueue(captureKind, reviewState)).slice(0, limit);
    const reviewedCandidates = [];

    for (const queueEntry of queueEntries) {
      const entry = await this.getRationale(queueEntry.id);
      reviewedCandidates.push(reviewCandidateEntry(entry));
    }

    return formatCandidateReview(reviewedCandidates);
  }

  async reviewRationale(id: string) {
    const entry = await this.getRationale(id);
    return reviewCandidateEntry(entry);
  }

  async markReviewQueueItem(
    id: string,
    action: "accept" | "keep_candidate" | "needs_revision" | "deprecate",
    options: { notes?: string; reason?: string; patch?: Record<string, unknown> } = {}
  ) {
    logInfo("Marking rationale review queue item started.", {
      entryId: id,
      action
    });

    if (options.patch) {
      await this.updateRationale(id, options.patch);
    }

    if (action === "accept") {
      return this.acceptCandidate(id);
    }

    if (action === "deprecate") {
      return this.deprecateRationale(id, options.reason ?? "Deprecated during rationale review.");
    }

    const reviewState = action === "needs_revision" ? "needs_revision" : "reviewed";
    const entry = await this.getRationale(id);
    entry.frontmatter.reviewState = reviewState;
    entry.frontmatter.metadata = {
      ...entry.frontmatter.metadata,
      review_state: reviewState,
      review_notes: options.notes,
      reviewed_at: new Date().toISOString()
    };
    const canonicalPath = await this.fileStore.writeEntry(entry);
    await this.indexingService.indexEntry(entry, canonicalPath);

    logInfo("Marking rationale review queue item completed.", {
      entryId: id,
      action,
      reviewState
    });
    return entry;
  }

  async bulkDeprecateReviewQueue(ids: string[], reason: string) {
    const deprecatedEntries = [];
    for (const id of ids) {
      deprecatedEntries.push(await this.deprecateRationale(id, reason));
    }
    return deprecatedEntries;
  }

  async search(input: unknown) {
    const parsedInput = searchInputSchema.parse(input);
    logInfo("Searching rationales started.", {
      query: parsedInput.query,
      limit: parsedInput.limit,
      domains: parsedInput.domains,
      intents: parsedInput.intents,
      modes: parsedInput.modes
    });
    const filters = {
      domains: parsedInput.domains,
      intents: parsedInput.intents,
      modes: parsedInput.modes,
      acceptanceStates: parsedInput.acceptanceStates,
      reviewStates: parsedInput.reviewStates,
      decisionStates: parsedInput.decisionStates,
      types: parsedInput.types,
      status: parsedInput.status,
      limit: parsedInput.limit,
      includeDeprecated: parsedInput.includeDeprecated
    };

    const lexicalResults = await searchMemoryEntriesLexical(this.pool, parsedInput.query, filters);
    logInfo("Lexical rationale search completed.", {
      query: parsedInput.query,
      resultCount: lexicalResults.length
    });
    let vectorResults: typeof lexicalResults = [];

    try {
      const queryEmbedding = await this.embeddingProvider.embedTexts([parsedInput.query], {
        inputType: "query",
        outputDimension: this.config.embedding.dimension,
        outputDtype: this.config.embedding.dtype
      });
      const firstEmbedding = queryEmbedding[0];
      if (firstEmbedding) {
        vectorResults = await searchMemoryEntriesVector(this.pool, firstEmbedding, filters);
        logInfo("Vector rationale search completed.", {
          query: parsedInput.query,
          resultCount: vectorResults.length
        });
      } else {
        logWarn("Vector rationale search skipped because embedding response was empty.", {
          query: parsedInput.query
        });
      }
    } catch (error) {
      if (lexicalResults.length === 0) {
        logError("Vector rationale search failed without lexical fallback results.", error, {
          query: parsedInput.query
        });
        throw error;
      }
      logError("Vector rationale search failed; returning lexical fallback results.", error, {
        query: parsedInput.query,
        lexicalResultCount: lexicalResults.length
      });
    }

    const results = rankSearchResults(
      mergeSearchResults(vectorResults, lexicalResults),
      filters
    ).slice(0, parsedInput.limit);
    logInfo("Searching rationales completed.", {
      query: parsedInput.query,
      resultCount: results.length
    });
    return results;
  }

  async recordUsageEvents(events: RecordUsageEventInput[]) {
    const parsedEvents = z.array(recordUsageEventInputSchema).parse(events);
    if (parsedEvents.length === 0) {
      return 0;
    }

    logInfo("Recording rationale usage events started.", {
      eventCount: parsedEvents.length
    });
    const recordedCount = await recordMemoryUsageEvents(this.pool, parsedEvents);
    logInfo("Recording rationale usage events completed.", {
      recordedCount
    });
    return recordedCount;
  }

  async reindexMemory(scope: "all" | "changed" | "untagged" = "all", ids?: string[]) {
    logInfo("Rationale reindex requested.", {
      scope,
      ids
    });
    if (ids && ids.length > 0) {
      for (const id of ids) {
        const entry = await this.fileStore.readById(id);
        await this.indexingService.indexEntry(entry, this.fileStore.pathForId(id));
      }
      logInfo("Rationale reindex completed for explicit ids.", {
        count: ids.length
      });
      return ids.length;
    }

    if (scope === "changed") {
      return this.indexingService.reindexChanged();
    }

    if (scope === "untagged") {
      return this.repairUntaggedMemory();
    }

    return this.indexingService.reindexAll();
  }

  private async repairUntaggedMemory() {
    const entries = await this.fileStore.listEntries();
    let repairedCount = 0;

    logInfo("Repairing untagged rationale memory started.", {
      entryCount: entries.length
    });

    for (const { canonicalPath, entry } of entries) {
      const inferredEntry = inferMissingRationaleTags(entry);
      if (!inferredEntry.changed) {
        continue;
      }

      const updatedCanonicalPath = await this.fileStore.writeEntry(inferredEntry.entry);
      await this.indexingService.indexEntry(inferredEntry.entry, updatedCanonicalPath);
      repairedCount += 1;

      logInfo("Repaired untagged rationale memory.", {
        entryId: entry.frontmatter.id,
        canonicalPath
      });
    }

    logInfo("Repairing untagged rationale memory completed.", {
      repairedCount
    });
    return repairedCount;
  }
}

function applyRationalePatch(entry: RationaleEntry, patch: Record<string, unknown>) {
  const parsedPatch = rationalePatchSchema.parse(patch);
  const updatedEntry: RationaleEntry = { ...entry, frontmatter: { ...entry.frontmatter } };

  if (typeof parsedPatch.title === "string") {
    updatedEntry.title = parsedPatch.title;
  }
  if (typeof parsedPatch.situation === "string") {
    updatedEntry.situation = parsedPatch.situation;
  }
  if (typeof parsedPatch.goal === "string") {
    updatedEntry.goal = parsedPatch.goal;
  }
  if (parsedPatch.constraints) {
    updatedEntry.constraints = parsedPatch.constraints;
  }
  if (typeof parsedPatch.decision === "string") {
    updatedEntry.decision = parsedPatch.decision;
  }
  if (typeof parsedPatch.rationale === "string") {
    updatedEntry.rationale = parsedPatch.rationale;
  }
  if (parsedPatch.rejectedAlternatives) {
    updatedEntry.rejectedAlternatives = parsedPatch.rejectedAlternatives;
  }
  if (typeof parsedPatch.tradeoff === "string") {
    updatedEntry.tradeoff = parsedPatch.tradeoff;
  }
  if (parsedPatch.reuseWhen) {
    updatedEntry.reuseWhen = parsedPatch.reuseWhen;
  }
  if (parsedPatch.avoidWhen) {
    updatedEntry.avoidWhen = parsedPatch.avoidWhen;
  }
  if (typeof parsedPatch.type === "string") {
    updatedEntry.frontmatter.type = parsedPatch.type;
  }
  if (typeof parsedPatch.status === "string") {
    updatedEntry.frontmatter.status = parsedPatch.status;
    const acceptanceState = readAcceptanceStateValue(parsedPatch.status);
    if (acceptanceState) {
      updatedEntry.frontmatter.acceptanceState = acceptanceState;
    }
  }
  if (parsedPatch.acceptanceState) {
    updatedEntry.frontmatter.acceptanceState = parsedPatch.acceptanceState;
    updatedEntry.frontmatter.status = parsedPatch.acceptanceState;
  }
  if (parsedPatch.reviewState) {
    updatedEntry.frontmatter.reviewState = parsedPatch.reviewState;
    updatedEntry.frontmatter.metadata = {
      ...updatedEntry.frontmatter.metadata,
      review_state: parsedPatch.reviewState
    };
  }
  if (parsedPatch.decisionState) {
    updatedEntry.frontmatter.decisionState = parsedPatch.decisionState;
  }
  if (typeof parsedPatch.scope === "string") {
    updatedEntry.frontmatter.scope = parsedPatch.scope;
  }
  if (typeof parsedPatch.confidence === "number") {
    updatedEntry.frontmatter.confidence = parsedPatch.confidence;
  }
  if (parsedPatch.domains) {
    updatedEntry.frontmatter.domains = parsedPatch.domains;
  }
  if (parsedPatch.intents) {
    updatedEntry.frontmatter.intents = parsedPatch.intents;
  }
  if (parsedPatch.modes) {
    updatedEntry.frontmatter.modes = parsedPatch.modes;
  }
  if (parsedPatch.source) {
    updatedEntry.frontmatter.source = parsedPatch.source;
  }
  if (parsedPatch.project) {
    updatedEntry.frontmatter.project = parsedPatch.project;
  }
  if (parsedPatch.metadata) {
    updatedEntry.frontmatter.metadata = {
      ...updatedEntry.frontmatter.metadata,
      ...parsedPatch.metadata
    };
    updatedEntry.frontmatter.reviewState = readReviewStateMetadata(
      updatedEntry.frontmatter.metadata,
      updatedEntry.frontmatter.reviewState
    );
  }

  return updatedEntry;
}

export function inferRationaleTags(input: Pick<
  RecordCandidateInput,
  "title" | "situation" | "goal" | "constraints" | "decision" | "rationale" | "tradeoff" | "reuseWhen" | "avoidWhen"
>) {
  const classification = classifyTask(formatRationaleForClassification(input));
  return {
    domains: classification.domains,
    intents: classification.intents,
    modes: classification.modes,
    reasons: classification.reasons
  };
}

function inferMissingRationaleTags(entry: RationaleEntry) {
  const inferredTags = inferRationaleTags(entry);
  const domains = mergeTagValues(entry.frontmatter.domains, inferredTags.domains);
  const intents = mergeTagValues(entry.frontmatter.intents, inferredTags.intents);
  const modes = mergeTagValues(entry.frontmatter.modes, inferredTags.modes);
  const changed = domains.length !== entry.frontmatter.domains.length
    || intents.length !== entry.frontmatter.intents.length
    || modes.length !== entry.frontmatter.modes.length;

  if (!changed) {
    return { changed, entry };
  }

  const updatedEntry: RationaleEntry = {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      domains,
      intents,
      modes,
      metadata: {
        ...entry.frontmatter.metadata,
        domains,
        intents,
        modes,
        tag_inference_reasons: inferredTags.reasons
      }
    }
  };
  return { changed, entry: updatedEntry };
}

function formatRationaleForClassification(input: Pick<
  RecordCandidateInput,
  "title" | "situation" | "goal" | "constraints" | "decision" | "rationale" | "tradeoff" | "reuseWhen" | "avoidWhen"
>) {
  return [
    input.title,
    input.situation,
    input.goal,
    input.decision,
    input.rationale,
    input.tradeoff,
    ...(input.constraints ?? []),
    ...(input.reuseWhen ?? []),
    ...(input.avoidWhen ?? [])
  ].filter(isNonEmptyString).join("\n");
}

type CandidateReview = {
  id: string;
  title: string;
  score: number;
  recommendation: "accept" | "revise" | "deprecate";
  missingSections: string[];
  strengths: string[];
  cautions: string[];
};

function reviewCandidateEntry(entry: RationaleEntry): CandidateReview {
  const missingSections = findMissingSections(entry);
  const strengths = findStrengths(entry);
  const cautions = findCautions(entry);
  const score = Math.max(0, Math.min(100, 100 - missingSections.length * 12 - cautions.length * 6 + strengths.length * 4));
  const recommendation = score >= 78
    ? "accept"
    : score >= 45
      ? "revise"
      : "deprecate";

  return {
    id: entry.frontmatter.id,
    title: entry.title,
    score,
    recommendation,
    missingSections,
    strengths,
    cautions
  };
}

function findMissingSections(entry: RationaleEntry) {
  const missingSections: string[] = [];
  if (!entry.situation) {
    missingSections.push("situation");
  }
  if (!entry.goal) {
    missingSections.push("goal");
  }
  if (entry.constraints.length === 0) {
    missingSections.push("constraints");
  }
  if (!entry.decision) {
    missingSections.push("decision");
  }
  if (entry.rejectedAlternatives.length === 0) {
    missingSections.push("rejectedAlternatives");
  }
  if (!entry.tradeoff) {
    missingSections.push("tradeoff");
  }
  if (entry.reuseWhen.length === 0) {
    missingSections.push("reuseWhen");
  }
  if (entry.avoidWhen.length === 0) {
    missingSections.push("avoidWhen");
  }
  return missingSections;
}

function findStrengths(entry: RationaleEntry) {
  const strengths: string[] = [];
  if (entry.rationale.length > 120) {
    strengths.push("substantive rationale");
  }
  if (entry.constraints.length > 0) {
    strengths.push("captures constraints");
  }
  if (entry.rejectedAlternatives.length > 0) {
    strengths.push("captures rejected alternatives");
  }
  if (entry.reuseWhen.length > 0 && entry.avoidWhen.length > 0) {
    strengths.push("has reuse and avoid boundaries");
  }
  return strengths;
}

function findCautions(entry: RationaleEntry) {
  const cautions: string[] = [];
  if (entry.frontmatter.domains.length === 0) {
    cautions.push("no domains tagged");
  }
  if (entry.frontmatter.intents.length === 0) {
    cautions.push("no intents tagged");
  }
  if (entry.frontmatter.modes.length === 0) {
    cautions.push("no modes tagged");
  }
  if (entry.rationale.length < 80) {
    cautions.push("rationale is short");
  }
  return cautions;
}

function formatCandidateReview(reviews: CandidateReview[]) {
  const lines = [
    "# Rationale Candidate Review",
    "",
    `- candidate count: ${reviews.length}`,
    ""
  ];

  for (const review of reviews) {
    lines.push(
      `## ${review.title}`,
      `- id: ${review.id}`,
      `- score: ${review.score}`,
      `- recommendation: ${review.recommendation}`,
      `- missing sections: ${review.missingSections.length > 0 ? review.missingSections.join(", ") : "none"}`,
      `- strengths: ${review.strengths.length > 0 ? review.strengths.join(", ") : "none"}`,
      `- cautions: ${review.cautions.length > 0 ? review.cautions.join(", ") : "none"}`,
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function mergeSearchResults<TEntry extends { id: string }>(primary: TEntry[], secondary: TEntry[]) {
  const results: TEntry[] = [];
  const seen = new Set<string>();

  for (const entry of [...primary, ...secondary]) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    results.push(entry);
  }

  return results;
}

function rankSearchResults<TEntry extends {
  confidence: number;
  acceptanceState: MemoryEntryRecord["acceptanceState"];
  reviewState: MemoryEntryRecord["reviewState"];
  type: string;
  metadata: Record<string, unknown>;
  useCount: number;
  lastUsedAt?: string;
  lexicalRank?: number;
  vectorScore?: number;
  searchScore?: number;
  searchReasons?: string[];
}>(entries: TEntry[], filters: {
  domains?: string[];
  intents?: string[];
  modes?: string[];
  types?: string[];
}) {
  return entries
    .map((entry) => {
      const ranking = calculateSearchRanking(entry, filters);
      entry.searchScore = ranking.score;
      entry.searchReasons = ranking.reasons;
      return entry;
    })
    .sort((left, right) => (right.searchScore ?? 0) - (left.searchScore ?? 0));
}

function calculateSearchRanking(entry: {
  confidence: number;
  acceptanceState: MemoryEntryRecord["acceptanceState"];
  reviewState: MemoryEntryRecord["reviewState"];
  type: string;
  metadata: Record<string, unknown>;
  useCount: number;
  lastUsedAt?: string;
  lexicalRank?: number;
  vectorScore?: number;
}, filters: {
  domains?: string[];
  intents?: string[];
  modes?: string[];
  types?: string[];
}) {
  let score = 0;
  const reasons: string[] = [];

  if (typeof entry.vectorScore === "number") {
    score += entry.vectorScore * 5;
    reasons.push(`vector:${entry.vectorScore.toFixed(3)}`);
  }

  if (typeof entry.lexicalRank === "number") {
    score += entry.lexicalRank;
    reasons.push(`lexical:${entry.lexicalRank}`);
  }

  if (entry.acceptanceState === "accepted") {
    score += 1.5;
    reasons.push("accepted");
  } else if (entry.acceptanceState === "candidate") {
    score += 0.5;
    reasons.push("candidate");
  }

  if (isAutoCapturedUnreviewedCandidate(entry)) {
    score -= 0.75;
    reasons.push("auto-unreviewed-penalty");
  }

  if (entry.confidence > 0) {
    score += Math.min(entry.confidence, 1);
    reasons.push(`confidence:${entry.confidence.toFixed(2)}`);
  }

  if (entry.useCount > 0) {
    const usageScore = Math.min(Math.log1p(entry.useCount) * 0.25, 1.5);
    score += usageScore;
    reasons.push(`usage:${entry.useCount}`);
  }

  const recentUsageScore = calculateRecentUsageScore(entry.lastUsedAt);
  if (recentUsageScore > 0) {
    score += recentUsageScore;
    reasons.push(`recent-usage:${recentUsageScore.toFixed(2)}`);
  }

  if (filters.types && filters.types.includes(entry.type)) {
    score += 1;
    reasons.push("type-match");
  }

  const domainMatches = countMetadataMatches(entry.metadata, "domains", filters.domains);
  if (domainMatches > 0) {
    score += domainMatches * 2;
    reasons.push(`domain-match:${domainMatches}`);
  }

  const intentMatches = countMetadataMatches(entry.metadata, "intents", filters.intents);
  if (intentMatches > 0) {
    score += intentMatches * 1.5;
    reasons.push(`intent-match:${intentMatches}`);
  }

  const modeMatches = countMetadataMatches(entry.metadata, "modes", filters.modes);
  if (modeMatches > 0) {
    score += modeMatches * 1.5;
    reasons.push(`mode-match:${modeMatches}`);
  }

  return { score, reasons };
}

function calculateRecentUsageScore(lastUsedAt: string | undefined) {
  if (!lastUsedAt) {
    return 0;
  }

  const lastUsedTime = Date.parse(lastUsedAt);
  if (!Number.isFinite(lastUsedTime)) {
    return 0;
  }

  const ageDays = (Date.now() - lastUsedTime) / (1000 * 60 * 60 * 24);
  if (ageDays < 0 || ageDays > 30) {
    return 0;
  }

  return Math.max(0, 0.5 * (1 - ageDays / 30));
}

function isAutoCapturedUnreviewedCandidate(entry: Pick<MemoryEntryRecord, "acceptanceState" | "reviewState" | "metadata">) {
  return entry.acceptanceState === "candidate"
    && readStringMetadata(entry.metadata, "capture_kind") === "auto"
    && entry.reviewState === "unreviewed";
}

function countMetadataMatches(metadata: Record<string, unknown>, key: string, expectedValues: string[] | undefined) {
  if (!expectedValues || expectedValues.length === 0) {
    return 0;
  }

  const value = metadata[key];
  if (!Array.isArray(value)) {
    return 0;
  }

  return value.filter((item): item is string => typeof item === "string" && expectedValues.includes(item)).length;
}

function getStringArray(metadata: Record<string, unknown> | undefined, key: string) {
  if (!metadata) {
    return [];
  }

  const value = metadata[key];
  return Array.isArray(value) && value.every(isString) ? value : [];
}

function mergeTagValues(explicitValues: string[], inferredValues: string[]) {
  return [...new Set([...explicitValues, ...inferredValues])];
}

function readStringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function readAcceptanceStateValue(value: unknown): MemoryEntryRecord["acceptanceState"] | undefined {
  const result = acceptanceStateSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function readReviewStateMetadata(
  metadata: Record<string, unknown>,
  defaultValue: MemoryEntryRecord["reviewState"]
) {
  const result = reviewStateSchema.safeParse(metadata.review_state);
  return result.success ? result.data : defaultValue;
}

function readProjectMetadata(metadata: Record<string, unknown> | undefined): ProjectContext | undefined {
  if (!metadata) {
    return undefined;
  }

  const value = metadata.project;
  if (typeof value === "string" && value.length > 0) {
    return { name: value };
  }

  if (isRecord(value) && typeof value.name === "string" && value.name.length > 0) {
    const project: ProjectContext = { name: value.name };
    if (typeof value.repo === "string" && value.repo.length > 0) {
      project.repo = value.repo;
    }
    if (typeof value.root === "string" && value.root.length > 0) {
      project.root = value.root;
    }
    return project;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCandidateMetadata(metadata: Record<string, unknown> | undefined, defaultCaptureKind: string) {
  const baseMetadata = metadata ?? {};
  return {
    ...baseMetadata,
    capture_kind: readStringMetadata(baseMetadata, "capture_kind") ?? defaultCaptureKind,
    review_state: readStringMetadata(baseMetadata, "review_state") ?? "unreviewed"
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createRationaleId() {
  const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `R${timestamp}-${randomPart}`;
}

import type pg from "pg";
import { z } from "zod";
import {
  claimRationaleContentFingerprint,
  completeRationaleContentFingerprint,
  countOpenMemoryRefinementOpinions,
  countMemoryUsageFeedback,
  failRationaleContentFingerprint,
  findMemoryEntry,
  findMemoryRefinementOpinion,
  findMemoryRevision,
  findLatestMemoryRevision,
  insertMemoryRevision,
  listAllMemoryEntriesByAcceptanceState,
  listMemoryEntriesByAcceptanceState,
  listOpenMemoryRefinementOpinions,
  listRecentMemoryEntries,
  lockMemoryEntryForUpdate,
  recordMemoryRefinementOpinion,
  recordMemoryUsageEvents,
  recordRetrievalQueryEvent,
  searchMemoryEntriesLexical,
  searchMemoryEntriesVector,
  setMemoryEntryCurrentRevision,
  updateMemoryRefinementOpinionStatus,
  updateMemoryStatus
} from "../db/queries.js";
import type { MemoryUsageFeedbackCounts, RetrievalQuerySourceKind } from "../db/queries.js";
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
  recordRefinementOpinionInputSchema,
  recordUsageFeedbackInputSchema,
  reviewStateSchema,
  searchInputSchema,
  updateRationaleInputSchema,
  type AutoCaptureRationaleInput,
  type MemoryEntryRecord,
  type MemoryRefinementOpinionRecord,
  type MemoryUsageEventType,
  type ProjectContext,
  type RecordCandidateInput,
  type RecordRefinementOpinionInput,
  type RecordUsageFeedbackInput,
  type RationaleEntry,
  type SearchProjectFilter
} from "./schema.js";
import { fingerprintRationaleContent } from "./rationaleContentFingerprint.js";
import { parseRationaleMarkdown, serializeRationaleEntry } from "./fileStore.js";

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

export type RationaleSearchWarning = {
  kind: "query_embedding_empty" | "vector_search_failed";
  severity: "warning";
  message: string;
  details: Record<string, unknown>;
};

export type ReviewQueueEntry = MemoryEntryRecord & {
  usageFeedback: MemoryUsageFeedbackCounts;
  reviewPriorityScore: number;
  reviewPriorityReasons: string[];
};

export type RationaleWriteResult = {
  id: string;
  canonicalPath: string;
  entry?: RationaleEntry;
  status?: "duplicate" | "processing";
  existingId?: string;
};

export type MemoryRevisionBackfillResult = {
  scanned: number;
  indexed: number;
  backfilled: number;
  linked: number;
  skipped: number;
};

const refinementOpinionLimitSchema = z.number().int().positive().max(5);
const refinementOpinionActionSchema = z.enum(["resolve", "reject", "apply_patch"]);
type RefinementOpinionAction = z.infer<typeof refinementOpinionActionSchema>;

// Vector similarity stays the dominant term on purpose: it is the only relevance
// signal, while every other weight is a trust/affinity signal. The compose-side
// similarity floor guarantees boosts only reorder already-relevant candidates,
// which is what makes the positive-feedback cap (4 events × weight) safe to give
// more reach than a single project match.
const searchRankingWeights = {
  vector: 5,
  lexical: 1,
  accepted: 2,
  reviewed: 0.5,
  candidate: 0.25,
  needsRevision: -1,
  feedbackPositive: 0.5,
  feedbackNegative: 0.75,
  projectMatch: 1.5
};

const reviewPriorityWeights = {
  needsRevision: 4,
  usageMultiplier: 1.5,
  usageMax: 6,
  recentUsageMultiplier: 4,
  feedbackPositive: 0.75,
  feedbackPositiveMax: 3,
  feedbackNegativeAttention: 1.5,
  feedbackNegativeAttentionMax: 6
};

export class RationaleService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fileStore: MemoryFileStore,
    private readonly indexingService: IndexingService,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly config: AppConfig
  ) {}

  async recordCandidate(input: RecordCandidateInput): Promise<RationaleWriteResult> {
    const validatedInput = recordCandidateInputSchema.parse(input);
    const id = createRationaleId();
    const contentFingerprint = fingerprintRationaleContent(validatedInput);
    const fingerprintClaim = await claimRationaleContentFingerprint(this.pool, contentFingerprint, id);

    if (fingerprintClaim.status === "completed") {
      logInfo("Recording rationale candidate skipped duplicate content.", {
        entryId: fingerprintClaim.entry.id,
        title: validatedInput.title
      });
      return {
        id: fingerprintClaim.entry.id,
        canonicalPath: fingerprintClaim.entry.canonicalPath,
        entry: await this.getRationale(fingerprintClaim.entry.id),
        status: "duplicate",
        existingId: fingerprintClaim.entry.id
      };
    }

    if (fingerprintClaim.status === "processing") {
      logInfo("Recording rationale candidate skipped processing duplicate content.", {
        entryId: fingerprintClaim.entryId,
        title: validatedInput.title
      });
      return {
        id: fingerprintClaim.entryId,
        canonicalPath: this.fileStore.pathForId(fingerprintClaim.entryId),
        status: "processing",
        existingId: fingerprintClaim.entryId
      };
    }

    if (fingerprintClaim.status === "failed") {
      throw new Error(`Rationale content fingerprint is still failed for ${fingerprintClaim.entryId}.`);
    }

    const metadata = normalizeCandidateMetadata(validatedInput.metadata, "manual");
    const captureTier = readStringMetadata(metadata, "capture_tier") ?? deriveCaptureTier(validatedInput);
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
        type: validatedInput.type ?? "rationale",
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
          capture_tier: captureTier,
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

    try {
      const canonicalPath = await this.fileStore.writeEntry(entry);
      await this.indexingService.indexEntry(entry, canonicalPath);
      const revision = await insertMemoryRevision(this.pool, {
        id: createRevisionId(),
        entryId: id,
        revisionNumber: 0,
        content: serializeRationaleRevisionContent(entry),
        reason: "Initial memory capture",
        metadata: {
          source_kind: validatedInput.source?.kind,
          source_ref: validatedInput.source?.ref
        }
      });
      await setMemoryEntryCurrentRevision(this.pool, id, revision.id);
      await completeRationaleContentFingerprint(this.pool, contentFingerprint, id);
      logInfo("Recording rationale candidate completed.", {
        entryId: id,
        canonicalPath
      });
      return { id, canonicalPath, entry };
    } catch (error) {
      await failRationaleContentFingerprint(this.pool, contentFingerprint, id, formatErrorMessage(error));
      throw error;
    }
  }

  async autoCaptureRationale(input: AutoCaptureRationaleInput): Promise<RationaleWriteResult> {
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
      type: validatedInput.type,
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
    if (!databaseEntry) {
      const canonicalPath = this.fileStore.pathForId(id);
      const fileEntry = await this.fileStore.readEntry(canonicalPath);
      logInfo("Reading rationale completed.", {
        entryId: id,
        canonicalPath,
        foundInDatabase: false
      });
      return fileEntry;
    }

    if (!databaseEntry.currentRevisionId) {
      throw new Error(`Memory entry has no current revision. Run backfill-revisions before reading ${id}.`);
    }

    const currentRevision = await findMemoryRevision(this.pool, databaseEntry.currentRevisionId);
    if (!currentRevision) {
      throw new Error(`Current memory revision not found: ${databaseEntry.currentRevisionId}`);
    }
    const entry = parseRationaleMarkdown(currentRevision.content);
    logInfo("Reading rationale completed.", {
      entryId: id,
      canonicalPath: databaseEntry.canonicalPath,
      foundInDatabase: true
    });
    return entry;
  }

  async getMemoryEntryRecord(id: string) {
    const entry = await findMemoryEntry(this.pool, id);
    if (!entry) {
      throw new Error(`Memory entry not found in index: ${id}`);
    }
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
    const databaseEntry = await findMemoryEntry(this.pool, id);
    if (!databaseEntry) {
      throw new Error(`Memory entry not found in index: ${id}`);
    }
    if (!databaseEntry.currentRevisionId) {
      throw new Error(`Memory entry has no current revision. Run backfill-revisions before updating ${id}.`);
    }
    const result = await this.updateRationaleFromRevision({
      revisionId: databaseEntry.currentRevisionId,
      reason: "Legacy rationale patch",
      patch
    });
    if (!result.ok) {
      throw new Error(`Rationale update conflicted for ${id}: latest revision is ${result.latestRevisionId}`);
    }
    const updatedEntry = await this.getRationale(id);
    logInfo("Updating rationale completed.", {
      entryId: id,
      revisionId: result.revisionId
    });
    return updatedEntry;
  }

  async updateRationaleFromRevision(input: unknown) {
    const parsedInput = updateRationaleInputSchema.parse(input);
    logInfo("Updating rationale from revision started.", {
      revisionId: parsedInput.revisionId,
      patchKeys: Object.keys(parsedInput.patch)
    });
    const baseRevision = await findMemoryRevision(this.pool, parsedInput.revisionId);
    if (!baseRevision) {
      throw new Error(`Memory revision not found: ${parsedInput.revisionId}`);
    }
    const databaseEntry = await findMemoryEntry(this.pool, baseRevision.entryId);
    if (!databaseEntry) {
      throw new Error(`Memory entry not found for revision: ${baseRevision.entryId}`);
    }
    if (databaseEntry.currentRevisionId !== baseRevision.id) {
      const latestRevision = databaseEntry.currentRevisionId
        ? databaseEntry.currentRevisionId
        : (await findLatestMemoryRevision(this.pool, baseRevision.entryId))?.id;
      if (!latestRevision) {
        throw new Error(`Memory entry has no latest revision: ${baseRevision.entryId}`);
      }
      return {
        ok: false as const,
        latestRevisionId: latestRevision
      };
    }

    const baseEntry = parseRationaleMarkdown(baseRevision.content);
    const updatedEntry = applyRationalePatch(baseEntry, parsedInput.patch);
    const canonicalPath = databaseEntry.canonicalPath;
    const revisionId = createRevisionId();
    const preparedIndex = await this.indexingService.prepareEntryIndex(updatedEntry, canonicalPath, {
      fingerprintFile: false
    });
    preparedIndex.entryRecord.currentRevisionId = revisionId;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lockedEntry = await lockMemoryEntryForUpdate(client, baseRevision.entryId);
      if (!lockedEntry) {
        throw new Error(`Memory entry disappeared during update: ${baseRevision.entryId}`);
      }
      if (!lockedEntry.currentRevisionId) {
        throw new Error(`Memory entry has no current revision. Run backfill-revisions before updating ${baseRevision.entryId}.`);
      }
      if (lockedEntry.currentRevisionId !== baseRevision.id) {
        await client.query("ROLLBACK");
        return {
          ok: false as const,
          latestRevisionId: lockedEntry.currentRevisionId
        };
      }

      const revision = await insertMemoryRevision(client, {
        id: revisionId,
        entryId: baseRevision.entryId,
        revisionNumber: baseRevision.revisionNumber + 1,
        content: serializeRationaleRevisionContent(updatedEntry),
        reason: parsedInput.reason,
        metadata: {
          base_revision_id: baseRevision.id
        }
      });
      await this.indexingService.writePreparedIndex(client, preparedIndex);
      await setMemoryEntryCurrentRevision(client, baseRevision.entryId, revision.id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    try {
      await this.fileStore.writeEntry(updatedEntry);
    } catch (error) {
      logError("Writing rationale file cache after revision update failed.", error, {
        entryId: baseRevision.entryId,
        revisionId
      });
    }
    logInfo("Updating rationale from revision completed.", {
      entryId: baseRevision.entryId,
      revisionId
    });
    return {
      ok: true as const,
      revisionId
    };
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
    const usageFeedbackCounts = await this.countUsageFeedback(filteredEntries.map((entry) => entry.id));
    const prioritizedEntries = prioritizeReviewQueueEntries(filteredEntries, usageFeedbackCounts);
    logInfo("Listed rationale review queue.", {
      resultCount: prioritizedEntries.length
    });
    return prioritizedEntries;
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
    const result = await this.searchWithDiagnostics(input);
    return result.results;
  }

  async searchWithDiagnostics(input: unknown, sourceKind: RetrievalQuerySourceKind = "search") {
    const parsedInput = searchInputSchema.parse(input);
    logInfo("Searching rationales started.", {
      query: parsedInput.query,
      limit: parsedInput.limit,
      domains: parsedInput.domains,
      intents: parsedInput.intents,
      modes: parsedInput.modes,
      project: parsedInput.project
    });
    const filters = {
      domains: parsedInput.domains,
      intents: parsedInput.intents,
      modes: parsedInput.modes,
      project: parsedInput.project,
      acceptanceStates: parsedInput.acceptanceStates,
      reviewStates: parsedInput.reviewStates,
      decisionStates: parsedInput.decisionStates,
      types: parsedInput.types,
      excludeTypes: parsedInput.excludeTypes,
      status: parsedInput.status,
      limit: parsedInput.limit,
      includeDeprecated: parsedInput.includeDeprecated
    };

    const warnings: RationaleSearchWarning[] = [];
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
        warnings.push({
          kind: "query_embedding_empty",
          severity: "warning",
          message: "Vector search was skipped because the query embedding response was empty.",
          details: {
            query: parsedInput.query,
            provider: this.config.embedding.provider,
            model: this.config.embedding.model
          }
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
      warnings.push({
        kind: "vector_search_failed",
        severity: "warning",
        message: "Vector search failed; returning lexical fallback results.",
        details: {
          query: parsedInput.query,
          lexicalResultCount: lexicalResults.length,
          provider: this.config.embedding.provider,
          model: this.config.embedding.model,
          error: formatErrorMessage(error)
        }
      });
    }

    const mergedResults = mergeSearchResults(vectorResults, lexicalResults);
    const usageFeedbackCounts = await this.countUsageFeedback(mergedResults.map((entry) => entry.id));
    const results = rankSearchResults(
      mergedResults,
      filters,
      usageFeedbackCounts
    ).slice(0, parsedInput.limit);
    logInfo("Searching rationales completed.", {
      query: parsedInput.query,
      resultCount: results.length,
      warningCount: warnings.length
    });

    try {
      await recordRetrievalQueryEvent(this.pool, {
        sourceKind,
        query: parsedInput.query,
        resultCount: results.length,
        topScore: results[0]?.searchScore,
        warningKinds: warnings.map((warning) => warning.kind),
        projectName: parsedInput.project?.name
      });
    } catch (error) {
      // Query logging is observability-only; a lost event must not break retrieval.
      logError("Recording retrieval query event failed.", error, {
        query: parsedInput.query
      });
    }

    return { results, warnings };
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

  async recordUsageFeedback(input: RecordUsageFeedbackInput) {
    const parsedInput = recordUsageFeedbackInputSchema.parse(input);
    logInfo("Recording rationale usage feedback started.", {
      entryId: parsedInput.entryId,
      eventType: parsedInput.eventType
    });

    const databaseEntry = await findMemoryEntry(this.pool, parsedInput.entryId);
    if (!databaseEntry) {
      throw new Error(`Cannot record usage feedback for unknown memory entry: ${parsedInput.entryId}`);
    }

    await this.recordUsageEvents([{
      entryId: parsedInput.entryId,
      eventType: parsedInput.eventType,
      sourceKind: parsedInput.source?.kind ?? "llm_feedback",
      sourceRef: parsedInput.source?.ref,
      task: parsedInput.task,
      metadata: parsedInput.metadata
    }]);

    const updatedEntry = await findMemoryEntry(this.pool, parsedInput.entryId);
    if (!updatedEntry) {
      throw new Error(`Memory entry disappeared after usage feedback: ${parsedInput.entryId}`);
    }

    logInfo("Recording rationale usage feedback completed.", {
      entryId: parsedInput.entryId,
      eventType: parsedInput.eventType,
      useCount: updatedEntry.useCount
    });

    return {
      entryId: updatedEntry.id,
      eventType: parsedInput.eventType,
      useCount: updatedEntry.useCount,
      lastUsedAt: updatedEntry.lastUsedAt
    };
  }

  async recordRefinementOpinion(input: RecordRefinementOpinionInput) {
    const parsedInput = recordRefinementOpinionInputSchema.parse(input);
    logInfo("Recording rationale refinement opinion started.", {
      entryId: parsedInput.entryId,
      opinionType: parsedInput.opinionType
    });

    const databaseEntry = await findMemoryEntry(this.pool, parsedInput.entryId);
    if (!databaseEntry) {
      throw new Error(`Cannot attach refinement opinion to unknown memory entry: ${parsedInput.entryId}`);
    }

    const opinion = await recordMemoryRefinementOpinion(this.pool, {
      entryId: parsedInput.entryId,
      opinionType: parsedInput.opinionType,
      body: parsedInput.body,
      suggestedPatch: parsedInput.suggestedPatch,
      sourceKind: parsedInput.source?.kind ?? "llm_opinion",
      sourceRef: parsedInput.source?.ref,
      metadata: parsedInput.metadata ?? {}
    });

    logInfo("Recording rationale refinement opinion completed.", {
      entryId: parsedInput.entryId,
      opinionId: opinion.id
    });
    return opinion;
  }

  async listOpenRefinementOpinions(entryIds: string[], limitPerEntry = 3) {
    const parsedEntryIds = z.array(z.string().min(1)).parse(entryIds);
    const parsedLimit = refinementOpinionLimitSchema.parse(limitPerEntry);
    const opinions = await listOpenMemoryRefinementOpinions(this.pool, parsedEntryIds, parsedLimit);
    return groupRefinementOpinionsByEntryId(opinions);
  }

  async countOpenRefinementOpinions(entryIds: string[]) {
    const parsedEntryIds = z.array(z.string().min(1)).parse(entryIds);
    return countOpenMemoryRefinementOpinions(this.pool, parsedEntryIds);
  }

  async countUsageFeedback(entryIds: string[]) {
    const parsedEntryIds = z.array(z.string().min(1)).parse(entryIds);
    const counts = await countMemoryUsageFeedback(this.pool, parsedEntryIds);
    for (const entryId of parsedEntryIds) {
      if (!counts.has(entryId)) {
        counts.set(entryId, createEmptyUsageFeedbackCounts());
      }
    }
    return counts;
  }

  async markRefinementOpinion(id: string, action: RefinementOpinionAction, note?: string) {
    const parsedId = z.string().min(1).parse(id);
    const parsedAction = refinementOpinionActionSchema.parse(action);
    logInfo("Marking rationale refinement opinion started.", {
      opinionId: parsedId,
      action: parsedAction
    });

    const opinion = await findMemoryRefinementOpinion(this.pool, parsedId);
    if (!opinion) {
      throw new Error(`Memory refinement opinion not found: ${parsedId}`);
    }
    if (opinion.status !== "open") {
      throw new Error(`Memory refinement opinion is already ${opinion.status}: ${parsedId}`);
    }

    if (parsedAction === "apply_patch") {
      if (!opinion.suggestedPatch) {
        throw new Error(`Memory refinement opinion has no suggested patch: ${parsedId}`);
      }

      await this.updateRationale(opinion.entryId, opinion.suggestedPatch);
      const updatedOpinion = await updateMemoryRefinementOpinionStatus(this.pool, parsedId, "resolved", {
        resolved_by_action: parsedAction,
        resolved_at: new Date().toISOString(),
        resolution_note: note
      });
      logInfo("Marking rationale refinement opinion completed.", {
        opinionId: parsedId,
        action: parsedAction,
        status: updatedOpinion.status
      });
      return updatedOpinion;
    }

    const status = parsedAction === "resolve" ? "resolved" : "rejected";
    const updatedOpinion = await updateMemoryRefinementOpinionStatus(this.pool, parsedId, status, {
      resolved_by_action: parsedAction,
      resolved_at: new Date().toISOString(),
      resolution_note: note
    });
    logInfo("Marking rationale refinement opinion completed.", {
      opinionId: parsedId,
      action: parsedAction,
      status: updatedOpinion.status
    });
    return updatedOpinion;
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

  async backfillRationaleContentFingerprints() {
    const entries = await this.fileStore.listEntries();
    logInfo("Backfilling rationale content fingerprints started.", {
      entryCount: entries.length
    });

    for (const { entry } of entries) {
      await this.indexingService.syncContentFingerprint(entry);
    }

    logInfo("Backfilling rationale content fingerprints completed.", {
      entryCount: entries.length
    });
    return entries.length;
  }

  async backfillMemoryRevisions(): Promise<MemoryRevisionBackfillResult> {
    const entries = await this.fileStore.listEntries();
    const result: MemoryRevisionBackfillResult = {
      scanned: entries.length,
      indexed: 0,
      backfilled: 0,
      linked: 0,
      skipped: 0
    };
    logInfo("Backfilling memory revisions started.", {
      entryCount: entries.length
    });

    for (const { canonicalPath, entry } of entries) {
      let databaseEntry = await findMemoryEntry(this.pool, entry.frontmatter.id);
      if (!databaseEntry) {
        await this.indexingService.indexEntry(entry, canonicalPath);
        result.indexed += 1;
        databaseEntry = await findMemoryEntry(this.pool, entry.frontmatter.id);
      }

      if (!databaseEntry) {
        throw new Error(`Memory entry was not indexed during revision backfill: ${entry.frontmatter.id}`);
      }

      if (databaseEntry.currentRevisionId) {
        const currentRevision = await findMemoryRevision(this.pool, databaseEntry.currentRevisionId);
        if (currentRevision) {
          result.skipped += 1;
          continue;
        }
      }

      const latestRevision = await findLatestMemoryRevision(this.pool, entry.frontmatter.id);
      if (latestRevision) {
        await setMemoryEntryCurrentRevision(this.pool, entry.frontmatter.id, latestRevision.id);
        result.linked += 1;
        continue;
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const revision = await insertMemoryRevision(client, {
          id: createRevisionId(),
          entryId: entry.frontmatter.id,
          revisionNumber: 0,
          content: serializeRationaleRevisionContent(entry),
          reason: "Backfilled initial memory revision",
          metadata: {
            backfilled_from: "canonical_file"
          }
        });
        await setMemoryEntryCurrentRevision(client, entry.frontmatter.id, revision.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      result.backfilled += 1;
    }

    logInfo("Backfilling memory revisions completed.", result);
    return result;
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

function groupRefinementOpinionsByEntryId(opinions: MemoryRefinementOpinionRecord[]) {
  const groupedOpinions = new Map<string, MemoryRefinementOpinionRecord[]>();
  for (const opinion of opinions) {
    const existingOpinions = groupedOpinions.get(opinion.entryId);
    if (existingOpinions) {
      existingOpinions.push(opinion);
    } else {
      groupedOpinions.set(opinion.entryId, [opinion]);
    }
  }
  return groupedOpinions;
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

const decisionShapedSections = new Set(["constraints", "decision", "rejectedAlternatives", "tradeoff"]);

export function findMissingSections(entry: RationaleEntry) {
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
  if (expectsDecisionSections(entry.frontmatter.type)) {
    return missingSections;
  }
  return missingSections.filter((section) => !decisionShapedSections.has(section));
}

// Non-decision memory types (preference, convention, constraint, known_failure) describe
// standing knowledge rather than a choice, so decision-shaped sections are not gaps for them.
function expectsDecisionSections(type: string) {
  return type === "rationale" || type === "principle";
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
  id: string;
  acceptanceState: MemoryEntryRecord["acceptanceState"];
  reviewState: MemoryEntryRecord["reviewState"];
  project?: ProjectContext;
  lexicalRank?: number;
  vectorScore?: number;
  searchScore?: number;
  searchReasons?: string[];
}>(entries: TEntry[], filters: {
  project?: SearchProjectFilter;
}, usageFeedbackCounts: Map<string, MemoryUsageFeedbackCounts>) {
  return entries
    .map((entry) => {
      const ranking = calculateSearchRanking(entry, filters, usageFeedbackCounts.get(entry.id));
      entry.searchScore = ranking.score;
      entry.searchReasons = ranking.reasons;
      return entry;
    })
    .sort((left, right) => (right.searchScore ?? 0) - (left.searchScore ?? 0));
}

function prioritizeReviewQueueEntries(
  entries: MemoryEntryRecord[],
  usageFeedbackCounts: Map<string, MemoryUsageFeedbackCounts>
): ReviewQueueEntry[] {
  return entries
    .map((entry, originalIndex) => {
      const usageFeedback = usageFeedbackCounts.get(entry.id) ?? createEmptyUsageFeedbackCounts();
      const priority = calculateReviewPriority(entry, usageFeedback);
      return {
        ...entry,
        usageFeedback,
        reviewPriorityScore: priority.score,
        reviewPriorityReasons: priority.reasons,
        originalIndex
      };
    })
    .sort((left, right) => {
      const priorityDifference = right.reviewPriorityScore - left.reviewPriorityScore;
      return priorityDifference === 0 ? left.originalIndex - right.originalIndex : priorityDifference;
    })
    .map(({ originalIndex, ...entry }) => entry);
}

function createEmptyUsageFeedbackCounts(): MemoryUsageFeedbackCounts {
  return {
    appliedCount: 0,
    helpfulCount: 0,
    unhelpfulCount: 0,
    dismissedCount: 0,
    positiveCount: 0,
    negativeCount: 0
  };
}

function calculateBoundedSignalScore(count: number, weight: number, maxScore: number) {
  return Number(Math.min(count * weight, maxScore).toFixed(2));
}

function addScoreContribution(reasons: string[], label: string, score: number, detail?: string) {
  if (score === 0) {
    return 0;
  }

  reasons.push(formatScoreReason(label, score, detail));
  return score;
}

function formatScoreReason(label: string, score: number, detail?: string) {
  const signedScore = score > 0 ? `+${score.toFixed(2)}` : score.toFixed(2);
  return detail ? `${label}:${detail}:${signedScore}` : `${label}:${signedScore}`;
}

export function calculateReviewPriority(entry: {
  reviewState: MemoryEntryRecord["reviewState"];
  useCount: number;
  lastUsedAt?: string;
}, usageFeedback = createEmptyUsageFeedbackCounts()) {
  let score = 0;
  const reasons: string[] = [];

  if (entry.reviewState === "needs_revision") {
    score += addScoreContribution(reasons, "needs-revision", reviewPriorityWeights.needsRevision);
  }

  if (entry.useCount > 0) {
    score += addScoreContribution(
      reasons,
      "usage",
      Math.min(Math.log1p(entry.useCount) * reviewPriorityWeights.usageMultiplier, reviewPriorityWeights.usageMax),
      String(entry.useCount)
    );
  }

  const recentUsageScore = calculateRecentUsageScore(entry.lastUsedAt) * reviewPriorityWeights.recentUsageMultiplier;
  if (recentUsageScore > 0) {
    score += addScoreContribution(reasons, "recent-usage", recentUsageScore);
  }

  score += addScoreContribution(
    reasons,
    "positive-feedback",
    calculateBoundedSignalScore(
      usageFeedback.positiveCount,
      reviewPriorityWeights.feedbackPositive,
      reviewPriorityWeights.feedbackPositiveMax
    ),
    String(usageFeedback.positiveCount)
  );
  score += addScoreContribution(
    reasons,
    "negative-feedback",
    calculateBoundedSignalScore(
      usageFeedback.negativeCount,
      reviewPriorityWeights.feedbackNegativeAttention,
      reviewPriorityWeights.feedbackNegativeAttentionMax
    ),
    String(usageFeedback.negativeCount)
  );

  if (reasons.length === 0) {
    reasons.push("standard-candidate");
  }

  return { score: Number(score.toFixed(2)), reasons };
}

export function calculateSearchRanking(entry: {
  acceptanceState: MemoryEntryRecord["acceptanceState"];
  reviewState: MemoryEntryRecord["reviewState"];
  project?: ProjectContext;
  lexicalRank?: number;
  vectorScore?: number;
}, filters: {
  project?: SearchProjectFilter;
}, usageFeedback = createEmptyUsageFeedbackCounts()) {
  let score = 0;
  const reasons: string[] = [];

  if (typeof entry.vectorScore === "number") {
    score += addScoreContribution(
      reasons,
      "vector",
      entry.vectorScore * searchRankingWeights.vector,
      entry.vectorScore.toFixed(3)
    );
  }

  if (typeof entry.lexicalRank === "number") {
    score += addScoreContribution(
      reasons,
      "lexical",
      entry.lexicalRank * searchRankingWeights.lexical,
      entry.lexicalRank.toFixed(2)
    );
  }

  if (entry.acceptanceState === "accepted") {
    score += addScoreContribution(reasons, "accepted", searchRankingWeights.accepted);
  } else if (entry.acceptanceState === "candidate") {
    score += addScoreContribution(reasons, "candidate", searchRankingWeights.candidate);
  }

  if (entry.reviewState === "reviewed") {
    score += addScoreContribution(reasons, "reviewed", searchRankingWeights.reviewed);
  } else if (entry.reviewState === "needs_revision") {
    score += addScoreContribution(reasons, "needs-revision", searchRankingWeights.needsRevision);
  }

  score += addScoreContribution(
    reasons,
    "positive-feedback",
    calculateBoundedSignalScore(
      usageFeedback.positiveCount,
      searchRankingWeights.feedbackPositive,
      searchRankingWeights.feedbackPositive * 4
    ),
    String(usageFeedback.positiveCount)
  );
  score += addScoreContribution(
    reasons,
    "negative-feedback",
    -calculateBoundedSignalScore(
      usageFeedback.negativeCount,
      searchRankingWeights.feedbackNegative,
      searchRankingWeights.feedbackNegative * 4
    ),
    String(usageFeedback.negativeCount)
  );

  if (matchesProjectFilter(entry.project, filters.project)) {
    score += addScoreContribution(reasons, "project-match", searchRankingWeights.projectMatch);
  }

  return { score, reasons };
}

// Project context is provenance: matching the caller's current project boosts
// ranking, but other projects are never penalized so cross-project rationale
// stays discoverable (R20260514T070848652Z-j3uj1b). Names compare
// case-insensitively because the same project arrives as e.g. "RisuAI" and
// "Risuai" from different clients; genuinely distinct projects (forks,
// sidecars) differ beyond casing and stay separate.
function matchesProjectFilter(project: ProjectContext | undefined, filter: SearchProjectFilter | undefined) {
  if (!project || !filter) {
    return false;
  }

  if (equalsIgnoreCase(project.name, filter.name)) {
    return true;
  }

  return filter.repo !== undefined
    && project.repo !== undefined
    && equalsIgnoreCase(project.repo, filter.repo);
}

function equalsIgnoreCase(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
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

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function serializeRationaleRevisionContent(entry: RationaleEntry) {
  const content = serializeRationaleEntry(entry);
  if (!content.includes("\u0000")) {
    return content;
  }

  logWarn("Rationale revision content contained NUL bytes; removed before database storage.", {
    entryId: entry.frontmatter.id
  });
  return content.replaceAll("\u0000", "");
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

// Quick captures intentionally skip reuse boundaries; the tier lets review flows and
// batch enrichment target them for backfill without affecting search ranking.
export function deriveCaptureTier(input: Pick<RecordCandidateInput, "reuseWhen" | "avoidWhen">) {
  const hasBoundaries =
    input.reuseWhen !== undefined &&
    input.reuseWhen.length > 0 &&
    input.avoidWhen !== undefined &&
    input.avoidWhen.length > 0;
  return hasBoundaries ? "full" : "quick";
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

function createRevisionId() {
  const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `V${timestamp}-${randomPart}`;
}

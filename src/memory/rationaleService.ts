import type pg from "pg";
import { z } from "zod";
import { findMemoryEntry, listRecentMemoryEntries, searchMemoryEntriesLexical, searchMemoryEntriesVector, updateMemoryStatus } from "../db/queries.js";
import type { AppConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../diagnostics/index.js";
import type { EmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { MemoryFileStore } from "./fileStore.js";
import { IndexingService } from "./indexingService.js";
import { recordCandidateInputSchema, searchInputSchema, type RecordCandidateInput, type RationaleEntry } from "./schema.js";

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
  metadata: z.record(z.unknown()).optional()
});

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
    logInfo("Recording rationale candidate started.", {
      entryId: id,
      title: validatedInput.title
    });
    const entry: RationaleEntry = {
      frontmatter: {
        id,
        type: "rationale",
        status: "candidate",
        scope: "general",
        domains: getStringArray(validatedInput.metadata, "domains"),
        intents: getStringArray(validatedInput.metadata, "intents"),
        modes: getStringArray(validatedInput.metadata, "modes"),
        confidence: 0.5,
        source: validatedInput.source,
        metadata: validatedInput.metadata ?? {}
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
    entry.frontmatter.status = "accepted";
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
    entry.frontmatter.status = "accepted";
    entry.title = title ?? entry.title;
    entry.frontmatter.metadata = {
      ...entry.frontmatter.metadata,
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

  async reindexMemory(scope: "all" | "changed" = "all", ids?: string[]) {
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

    return this.indexingService.reindexAll();
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
  if (parsedPatch.metadata) {
    updatedEntry.frontmatter.metadata = {
      ...updatedEntry.frontmatter.metadata,
      ...parsedPatch.metadata
    };
  }

  return updatedEntry;
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
  status: string;
  type: string;
  metadata: Record<string, unknown>;
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
  status: string;
  type: string;
  metadata: Record<string, unknown>;
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

  if (entry.status === "accepted") {
    score += 1.5;
    reasons.push("accepted");
  } else if (entry.status === "candidate") {
    score += 0.5;
    reasons.push("candidate");
  }

  if (entry.confidence > 0) {
    score += Math.min(entry.confidence, 1);
    reasons.push(`confidence:${entry.confidence.toFixed(2)}`);
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function createRationaleId() {
  const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `R${timestamp}-${randomPart}`;
}

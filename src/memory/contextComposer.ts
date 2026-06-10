import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { logInfo } from "../diagnostics/index.js";
import { classifyTask } from "../ontology/taskClassifier.js";
import type { RationaleSearchWarning, RationaleService } from "./rationaleService.js";
import type { MemoryEntryRecord, MemoryRefinementOpinionRecord, SearchProjectFilter } from "./schema.js";

type UsageEventInput = Parameters<RationaleService["recordUsageEvents"]>[0][number];
const refinementOpinionLimitPerEntry = 3;

export type ComposeContextInput = {
  task: string;
  explicitMode?: string;
  explicitDomains?: string[];
  project?: SearchProjectFilter;
  tokenBudget?: number;
  includeFullTopK?: number;
  minScore?: number;
};

export type ContinueContextInput = {
  cursor: string;
  tokenBudget?: number;
  includeFullTopK?: number;
};

export class ContextComposer {
  private readonly continuationCache = new ContinuationCache(10);

  constructor(
    private readonly dataDirectory: string,
    private readonly rationaleService: RationaleService
  ) {}

  async compose(input: ComposeContextInput) {
    const tokenBudget = input.tokenBudget ?? 1200;
    const includeFullTopK = input.includeFullTopK ?? 2;
    const minScore = input.minScore ?? 0;
    logInfo("Composing rationale context started.", {
      task: input.task,
      explicitMode: input.explicitMode,
      explicitDomains: input.explicitDomains,
      project: input.project,
      tokenBudget,
      includeFullTopK,
      minScore
    });
    const classification = classifyTask(input.task, input.explicitMode, input.explicitDomains);
    logInfo("Rationale context task classified.", {
      intent: classification.intent,
      intents: classification.intents,
      domain: classification.domain,
      domains: classification.domains,
      mode: classification.mode,
      modes: classification.modes,
      riskLevel: classification.riskLevel,
      likelyArtifact: classification.likelyArtifact,
      trivial: classification.trivial,
      fileHints: classification.fileHints
    });
    const kernel = await this.loadKernel(tokenBudget);
    const searchResult = await this.rationaleService.searchWithDiagnostics({
      query: input.task,
      domains: input.explicitDomains,
      modes: input.explicitMode ? [input.explicitMode] : undefined,
      project: input.project,
      limit: 50,
      includeDeprecated: false
    });
    const searchResults = searchResult.results;
    const relevantResults = searchResults.filter((result) => (result.searchScore ?? 0) >= minScore);
    logInfo("Rationale context retrieval completed.", {
      resultCount: searchResults.length,
      relevantResultCount: relevantResults.length,
      warningCount: searchResult.warnings.length
    });
    const refinementOpinionsByEntryId = await this.rationaleService.listOpenRefinementOpinions(
      relevantResults.map((result) => result.id),
      refinementOpinionLimitPerEntry
    );

    const lines = [
      "# Rationale Context Pack",
      "",
      "## Task classification",
      `- intent: ${classification.intent}`,
      `- intents: ${classification.intents.join(", ")}`,
      `- domain: ${classification.domain}`,
      `- domains: ${classification.domains.join(", ")}`,
      `- mode: ${classification.mode}`,
      `- modes: ${classification.modes.join(", ")}`,
      `- risk level: ${classification.riskLevel}`,
      `- likely artifact: ${classification.likelyArtifact}`,
      `- substantial: ${classification.substantial}`,
      `- trivial: ${classification.trivial}`,
      classification.fileHints.length > 0 ? `- file hints: ${classification.fileHints.join(", ")}` : "- file hints: none",
      classification.reasons.length > 0 ? `- classification reasons: ${classification.reasons.join("; ")}` : "- classification reasons: default fallback",
      ...formatSearchWarnings(searchResult.warnings),
      "",
      "## Stable kernel",
      kernel,
      "",
      "## Retrieved rationales"
    ];

    let usedTokens = estimateTokens(lines.join("\n"));
    let index = 0;
    const usageEvents: UsageEventInput[] = [];

    for (const result of relevantResults) {
      const entry = await this.rationaleService.getRationale(result.id);
      const resultRefinementOpinions = refinementOpinionsByEntryId.get(result.id) ?? [];
      const includeKind = index < includeFullTopK ? "full" : "summary";
      const fullText = includeKind === "full"
        ? formatFullEntry(entry.rawMarkdown, result, resultRefinementOpinions)
        : formatSummary(result, resultRefinementOpinions);
      const nextTokens = estimateTokens(fullText);
      if (usedTokens + nextTokens > tokenBudget) {
        logInfo("Rationale context stopped at token budget.", {
          usedTokens,
          nextTokens,
          tokenBudget,
          includedCount: index
        });
        break;
      }

      lines.push(fullText);
      usedTokens += nextTokens;
      usageEvents.push(createComposedUsageEvent(result, {
        sourceKind: "compose_context",
        task: input.task,
        includeKind,
        retrievalRank: index + 1,
        tokenEstimate: nextTokens
      }));
      index += 1;
    }

    if (index < relevantResults.length) {
      const cursor = this.continuationCache.put({
        task: input.task,
        candidates: relevantResults,
        position: index
      });
      const manifest = formatContinuationManifest(cursor, relevantResults, index);
      lines.push("", manifest);
    }

    const contextWithManifest = lines.join("\n").trimEnd();
    await this.rationaleService.recordUsageEvents(usageEvents);
    logInfo("Composing rationale context completed.", {
      usedTokens,
      includedCount: index,
      omittedCount: Math.max(0, relevantResults.length - index),
      outputCharacters: contextWithManifest.length
    });
    return contextWithManifest;
  }

  async continueContext(input: ContinueContextInput) {
    const tokenBudget = input.tokenBudget ?? 1200;
    const includeFullTopK = input.includeFullTopK ?? 0;
    const snapshot = this.continuationCache.get(input.cursor);
    if (!snapshot) {
      throw new Error("Continuation cursor was evicted. Run compose_context again.");
    }

    logInfo("Continuing rationale context started.", {
      cursor: input.cursor,
      task: snapshot.task,
      tokenBudget,
      includeFullTopK,
      position: snapshot.position,
      candidateCount: snapshot.candidates.length
    });

    const lines = [
      "# Rationale Context Continuation",
      "",
      `- cursor: ${input.cursor}`,
      `- original task: ${snapshot.task}`,
      `- candidate position: ${snapshot.position} of ${snapshot.candidates.length}`,
      "",
      "## Retrieved rationales"
    ];

    let usedTokens = estimateTokens(lines.join("\n"));
    let includedCount = 0;
    let position = snapshot.position;
    const usageEvents: UsageEventInput[] = [];
    const remainingCandidates = snapshot.candidates.slice(snapshot.position);
    const refinementOpinionsByEntryId = await this.rationaleService.listOpenRefinementOpinions(
      remainingCandidates.map((candidate) => candidate.id),
      refinementOpinionLimitPerEntry
    );

    while (position < snapshot.candidates.length) {
      const result = snapshot.candidates[position];
      if (!result) {
        throw new Error(`Continuation snapshot position ${position} is invalid.`);
      }

      const entry = await this.rationaleService.getRationale(result.id);
      const resultRefinementOpinions = refinementOpinionsByEntryId.get(result.id) ?? [];
      const includeKind = includedCount < includeFullTopK ? "full" : "summary";
      const fullText = includeKind === "full"
        ? formatFullEntry(entry.rawMarkdown, result, resultRefinementOpinions)
        : formatSummary(result, resultRefinementOpinions);
      const nextTokens = estimateTokens(fullText);
      if (usedTokens + nextTokens > tokenBudget) {
        logInfo("Rationale context continuation stopped at token budget.", {
          cursor: input.cursor,
          usedTokens,
          nextTokens,
          tokenBudget,
          includedCount,
          position
        });
        break;
      }

      lines.push(fullText);
      usedTokens += nextTokens;
      usageEvents.push(createComposedUsageEvent(result, {
        sourceKind: "continue_context",
        sourceRef: input.cursor,
        task: snapshot.task,
        includeKind,
        retrievalRank: position + 1,
        tokenEstimate: nextTokens,
        continuationPosition: position
      }));
      includedCount += 1;
      position += 1;
    }

    if (includedCount === 0 && position < snapshot.candidates.length) {
      throw new Error("Token budget is too small to include the next rationale candidate.");
    }

    snapshot.position = position;
    if (position < snapshot.candidates.length) {
      lines.push("", formatContinuationManifest(input.cursor, snapshot.candidates, position));
    } else {
      this.continuationCache.delete(input.cursor);
      lines.push("", "## Retrieval continuation", "- has more: false");
    }

    const context = lines.join("\n").trimEnd();
    await this.rationaleService.recordUsageEvents(usageEvents);
    logInfo("Continuing rationale context completed.", {
      cursor: input.cursor,
      usedTokens,
      includedCount,
      nextPosition: position,
      hasMore: position < snapshot.candidates.length,
      outputCharacters: context.length
    });
    return context;
  }

  private async loadKernel(tokenBudget: number) {
    const kernelPath = path.join(this.dataDirectory, "kernel", "global-principles.md");
    logInfo("Loading rationale context kernel.", {
      kernelPath,
      tokenBudget
    });
    const text = await readFile(kernelPath, "utf8");
    return truncateToTokens(text.trim(), Math.min(250, Math.floor(tokenBudget / 4)));
  }
}

function formatSearchWarnings(warnings: RationaleSearchWarning[]) {
  if (warnings.length === 0) {
    return [];
  }

  return [
    "",
    "## Retrieval warnings",
    ...warnings.map((warning) => `- ${warning.kind}: ${warning.message}`)
  ];
}

function formatSummary(result: {
  id: string;
  title: string;
  summary?: string;
  type: string;
  status: string;
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
  searchScore?: number;
  searchReasons?: string[];
}, refinementOpinions: MemoryRefinementOpinionRecord[]) {
  return [
    `### ${result.title}`,
    `- id: ${result.id}`,
    `- type: ${result.type}`,
    `- acceptance state: ${result.acceptanceState}`,
    `- review state: ${result.reviewState}`,
    `- decision state: ${result.decisionState}`,
    `- legacy status: ${result.status}`,
    ...formatRankingLines(result),
    result.summary ? `- summary: ${result.summary}` : "- summary: none",
    ...formatRefinementOpinionLines(refinementOpinions)
  ].join("\n");
}

function formatContinuationManifest(cursor: string, candidates: MemoryEntryRecord[], position: number) {
  const omitted = candidates.slice(position);
  const preview = omitted.slice(0, 5);
  return [
    "## Retrieval continuation",
    "- has more: true",
    `- next cursor: ${cursor}`,
    `- omitted count: ${omitted.length}`,
    "- use continue_context with this cursor to inspect more retrieved rationale candidates",
    "",
    "### Omitted preview",
    ...preview.map(formatManifestItem)
  ].join("\n");
}

function formatManifestItem(result: MemoryEntryRecord) {
  const score = typeof result.searchScore === "number" ? result.searchScore.toFixed(3) : "unknown";
  const reasons = result.searchReasons && result.searchReasons.length > 0 ? result.searchReasons.join(", ") : "none";
  return `- ${result.id}: ${result.title} (score: ${score}; reasons: ${reasons})`;
}

function formatFullEntry(
  markdown: string,
  result: { searchScore?: number; searchReasons?: string[] },
  refinementOpinions: MemoryRefinementOpinionRecord[]
) {
  return [
    "### Retrieved full rationale",
    ...formatRankingLines(result),
    "",
    markdown.trim(),
    ...formatRefinementOpinionBlock(refinementOpinions)
  ].join("\n");
}

function formatRankingLines(result: { searchScore?: number; searchReasons?: string[] }) {
  const lines: string[] = [];
  if (typeof result.searchScore === "number") {
    lines.push(`- search score: ${result.searchScore.toFixed(3)}`);
  }
  if (result.searchReasons && result.searchReasons.length > 0) {
    lines.push(`- search reasons: ${result.searchReasons.join(", ")}`);
  }
  return lines;
}

function formatRefinementOpinionBlock(opinions: MemoryRefinementOpinionRecord[]) {
  if (opinions.length === 0) {
    return [];
  }

  return [
    "",
    "#### Open refinement opinions",
    ...opinions.flatMap(formatRefinementOpinion)
  ];
}

function formatRefinementOpinionLines(opinions: MemoryRefinementOpinionRecord[]) {
  if (opinions.length === 0) {
    return [];
  }

  return [
    `- open refinement opinions: ${opinions.length}`,
    ...opinions.map((opinion) =>
      `  - ${opinion.opinionType} ${opinion.id}: ${truncateToCharacters(opinion.body, 240)}`
    )
  ];
}

function formatRefinementOpinion(opinion: MemoryRefinementOpinionRecord) {
  const lines = [
    `- ${opinion.opinionType} ${opinion.id}`,
    `  - source: ${formatSource(opinion.sourceKind, opinion.sourceRef)}`,
    `  - body: ${truncateToCharacters(opinion.body, 500)}`
  ];

  if (opinion.suggestedPatch) {
    lines.push(`  - suggested patch: ${truncateToCharacters(JSON.stringify(opinion.suggestedPatch), 800)}`);
  }

  return lines;
}

function formatSource(sourceKind: string, sourceRef: string | undefined) {
  return sourceRef ? `${sourceKind}:${sourceRef}` : sourceKind;
}

function createComposedUsageEvent(
  result: MemoryEntryRecord,
  options: {
    sourceKind: string;
    sourceRef?: string;
    task: string;
    includeKind: "full" | "summary";
    retrievalRank: number;
    tokenEstimate: number;
    continuationPosition?: number;
  }
): UsageEventInput {
  return {
    entryId: result.id,
    eventType: "composed",
    sourceKind: options.sourceKind,
    sourceRef: options.sourceRef,
    task: options.task,
    metadata: {
      include_kind: options.includeKind,
      retrieval_rank: options.retrievalRank,
      token_estimate: options.tokenEstimate,
      continuation_position: options.continuationPosition,
      search_score: result.searchScore,
      search_reasons: result.searchReasons ?? []
    }
  };
}

function truncateToTokens(text: string, maxTokens: number) {
  const maxCharacters = maxTokens * 4;
  return text.length > maxCharacters ? text.slice(0, maxCharacters) : text;
}

function truncateToCharacters(text: string, maxCharacters: number) {
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}...` : text;
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

type ContinuationSnapshot = {
  task: string;
  candidates: MemoryEntryRecord[];
  position: number;
};

class ContinuationCache {
  private readonly snapshots = new Map<string, ContinuationSnapshot>();
  private readonly cursorQueue: string[] = [];

  constructor(private readonly maxSize: number) {}

  put(snapshot: ContinuationSnapshot) {
    const cursor = randomUUID();
    this.snapshots.set(cursor, snapshot);
    this.cursorQueue.push(cursor);

    while (this.cursorQueue.length > this.maxSize) {
      const oldestCursor = this.cursorQueue.shift();
      if (!oldestCursor) {
        throw new Error("Continuation cursor queue underflowed during eviction.");
      }
      this.snapshots.delete(oldestCursor);
    }

    return cursor;
  }

  get(cursor: string) {
    return this.snapshots.get(cursor);
  }

  delete(cursor: string) {
    this.snapshots.delete(cursor);
  }
}

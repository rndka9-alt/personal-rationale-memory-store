import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { logInfo } from "../diagnostics/index.js";
import type { RationaleSearchWarning, RationaleService } from "./rationaleService.js";
import type { MemoryEntryRecord, SearchProjectFilter } from "./schema.js";

type UsageEventInput = Parameters<RationaleService["recordUsageEvents"]>[0][number];
// Historical note-typed memory entries predate the separate plain note store.
// Keep them out of rationale context so notes and rationale memories stay distinct.
const legacyComposeExcludedTypes = ["note"];
// The relevance floor applies to vector similarity itself, not the composite
// searchScore: composite scores mix trust boosts (accepted/project/feedback),
// so a boosted-but-unrelated memory could pass any composite threshold.
// 0.4 drops roughly the bottom quarter of historical compose inclusions;
// recalibrate after reviewing what it excludes.
const vectorSimilarityFloor = 0.4;
// Feedback only flows if the context pack itself asks for it: the loop is fully
// wired server-side, but production data showed near-zero feedback because
// clients had no in-context trigger to call record_usage_feedback.
const feedbackFooter = [
  "## Feedback",
  "- After acting on this pack, call record_usage_feedback per memory id: eventType \"applied\" if it shaped your work, \"dismissed\" if it was retrieved but not useful."
].join("\n");

export type ComposeContextInput = {
  task: string;
  project?: SearchProjectFilter;
  tokenBudget?: number;
  includeFullTopK?: number;
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
    logInfo("Composing rationale context started.", {
      task: input.task,
      project: input.project,
      tokenBudget,
      includeFullTopK
    });
    const kernel = await this.loadKernel(tokenBudget);
    const searchResult = await this.rationaleService.searchWithDiagnostics({
      query: input.task,
      project: input.project,
      excludeTypes: legacyComposeExcludedTypes,
      limit: 50,
      includeDeprecated: false
    }, "compose");
    const searchResults = searchResult.results;
    // Lexical-only results (no vectorScore) pass the floor: they matched the task
    // text directly, and vector-failure fallback results must stay usable.
    const relevantResults = searchResults.filter((result) =>
      typeof result.vectorScore !== "number" || result.vectorScore >= vectorSimilarityFloor
    );
    logInfo("Rationale context retrieval completed.", {
      resultCount: searchResults.length,
      relevantResultCount: relevantResults.length,
      belowSimilarityFloorCount: searchResults.length - relevantResults.length,
      warningCount: searchResult.warnings.length
    });
    const lines = [
      "# Rationale Context Pack",
      ...formatSearchWarnings(searchResult.warnings),
      "",
      "## Stable kernel",
      kernel,
      "",
      "## Retrieved rationales"
    ];

    // Reserve footer tokens up front so appending it never overshoots the budget.
    let usedTokens = estimateTokens(lines.join("\n")) + estimateTokens(feedbackFooter);
    let index = 0;
    const usageEvents: UsageEventInput[] = [];

    for (const result of relevantResults) {
      const entry = await this.rationaleService.getRationale(result.id);
      const includeKind = index < includeFullTopK ? "full" : "summary";
      const fullText = includeKind === "full"
        ? formatFullEntry(entry.rawMarkdown)
        : formatSummary(result);
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

    if (index > 0) {
      lines.push("", feedbackFooter);
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
      "## Retrieved rationales"
    ];

    let usedTokens = estimateTokens(lines.join("\n"));
    let includedCount = 0;
    let position = snapshot.position;
    const usageEvents: UsageEventInput[] = [];
    while (position < snapshot.candidates.length) {
      const result = snapshot.candidates[position];
      if (!result) {
        throw new Error(`Continuation snapshot position ${position} is invalid.`);
      }

      const entry = await this.rationaleService.getRationale(result.id);
      const includeKind = includedCount < includeFullTopK ? "full" : "summary";
      const fullText = includeKind === "full"
        ? formatFullEntry(entry.rawMarkdown)
        : formatSummary(result);
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
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
}) {
  return [
    `### ${result.title}`,
    `- id: ${result.id}`,
    `- type: ${result.type}`,
    `- acceptance state: ${result.acceptanceState}`,
    `- review state: ${result.reviewState}`,
    `- decision state: ${result.decisionState}`,
    ...(result.summary ? [`- summary: ${result.summary}`] : [])
  ].join("\n");
}

function formatContinuationManifest(cursor: string, candidates: MemoryEntryRecord[], position: number) {
  const omitted = candidates.slice(position);
  return [
    "## Retrieval continuation",
    "- has more: true",
    `- next cursor: ${cursor}`,
    `- omitted count: ${omitted.length}`,
    "- use continue_context with this cursor to inspect more retrieved rationale candidates"
  ].join("\n");
}

function formatFullEntry(markdown: string) {
  return [
    "### Retrieved full rationale",
    "",
    markdown.trim()
  ].join("\n");
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

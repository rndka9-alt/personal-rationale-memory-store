import { readFile } from "node:fs/promises";
import path from "node:path";
import { logInfo } from "../diagnostics/index.js";
import { classifyTask } from "../ontology/taskClassifier.js";
import type { RationaleService } from "./rationaleService.js";

export type ComposeContextInput = {
  task: string;
  explicitMode?: string;
  explicitDomains?: string[];
  tokenBudget?: number;
  includeFullTopK?: number;
  minScore?: number;
};

export class ContextComposer {
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
    const searchResults = await this.rationaleService.search({
      query: input.task,
      domains: input.explicitDomains,
      modes: input.explicitMode ? [input.explicitMode] : undefined,
      limit: 12,
      includeDeprecated: false
    });
    const relevantResults = searchResults.filter((result) => (result.searchScore ?? 0) >= minScore);
    logInfo("Rationale context retrieval completed.", {
      resultCount: searchResults.length,
      relevantResultCount: relevantResults.length
    });

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
      "",
      "## Stable kernel",
      kernel,
      "",
      "## Retrieved rationales"
    ];

    let usedTokens = estimateTokens(lines.join("\n"));
    let index = 0;

    for (const result of relevantResults) {
      const entry = await this.rationaleService.getRationale(result.id);
      const fullText = index < includeFullTopK ? formatFullEntry(entry.rawMarkdown, result) : formatSummary(result);
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
      index += 1;
    }

    const context = lines.join("\n").trimEnd();
    logInfo("Composing rationale context completed.", {
      usedTokens,
      includedCount: index,
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

function formatSummary(result: {
  id: string;
  title: string;
  summary?: string;
  type: string;
  status: string;
  searchScore?: number;
  searchReasons?: string[];
}) {
  return [
    `### ${result.title}`,
    `- id: ${result.id}`,
    `- type: ${result.type}`,
    `- status: ${result.status}`,
    ...formatRankingLines(result),
    result.summary ? `- summary: ${result.summary}` : "- summary: none"
  ].join("\n");
}

function formatFullEntry(markdown: string, result: { searchScore?: number; searchReasons?: string[] }) {
  return [
    "### Retrieved full rationale",
    ...formatRankingLines(result),
    "",
    markdown.trim()
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

function truncateToTokens(text: string, maxTokens: number) {
  const maxCharacters = maxTokens * 4;
  return text.length > maxCharacters ? text.slice(0, maxCharacters) : text;
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

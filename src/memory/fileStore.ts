import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { logInfo, logWarn } from "../diagnostics/index.js";
import { rationaleEntrySchema, type RationaleEntry } from "./schema.js";

type ParsedFrontmatter = {
  frontmatter: unknown;
  body: string;
};

export class MemoryFileStore {
  constructor(private readonly dataDirectory: string) {}

  async writeEntry(entry: RationaleEntry) {
    const directory = path.join(this.dataDirectory, "rationales");
    await mkdir(directory, { recursive: true });
    const canonicalPath = path.join(directory, `${entry.frontmatter.id}.md`);
    logInfo("Writing rationale file started.", {
      entryId: entry.frontmatter.id,
      canonicalPath
    });
    await writeFile(canonicalPath, serializeRationaleEntry(entry), "utf8");
    logInfo("Writing rationale file completed.", {
      entryId: entry.frontmatter.id,
      canonicalPath
    });
    return canonicalPath;
  }

  async readEntry(canonicalPath: string) {
    logInfo("Reading rationale file started.", {
      canonicalPath
    });
    const markdown = await readFile(canonicalPath, "utf8");
    const entry = parseRationaleMarkdown(markdown);
    logInfo("Reading rationale file completed.", {
      entryId: entry.frontmatter.id,
      canonicalPath
    });
    return entry;
  }

  async readById(id: string) {
    return this.readEntry(this.pathForId(id));
  }

  pathForId(id: string) {
    return path.join(this.dataDirectory, "rationales", `${id}.md`);
  }

  async listEntries() {
    const directory = path.join(this.dataDirectory, "rationales");
    logInfo("Listing rationale files started.", {
      directory
    });
    await mkdir(directory, { recursive: true });
    const fileNames = await readdir(directory);
    const entries: Array<{ canonicalPath: string; entry: RationaleEntry }> = [];

    for (const fileName of fileNames) {
      if (!fileName.endsWith(".md")) {
        logWarn("Skipping non-markdown file in rationale directory.", {
          fileName
        });
        continue;
      }

      const canonicalPath = path.join(directory, fileName);
      const entry = await this.readEntry(canonicalPath);
      entries.push({ canonicalPath, entry });
    }

    logInfo("Listing rationale files completed.", {
      directory,
      entryCount: entries.length
    });
    return entries;
  }
}

export function serializeRationaleEntry(entry: RationaleEntry) {
  const frontmatter = YAML.stringify(entry.frontmatter);
  return `${[
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${entry.title}`,
    "",
    entry.body.trim()
  ].join("\n").trimEnd()}\n`;
}

export function parseRationaleMarkdown(markdown: string) {
  logInfo("Parsing rationale markdown started.", {
    characters: markdown.length
  });
  const parsed = parseFrontmatter(markdown);
  const document = parseDocument(parsed.body);
  const frontmatterResult = rationaleEntrySchema.shape.frontmatter.parse(normalizeLifecycleFrontmatter(parsed.frontmatter));

  const entry = rationaleEntrySchema.parse({
    frontmatter: frontmatterResult,
    title: document.title,
    body: document.body,
    rawMarkdown: markdown
  });
  logInfo("Parsing rationale markdown completed.", {
    entryId: entry.frontmatter.id
  });
  return entry;
}

function normalizeLifecycleFrontmatter(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }

  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const normalized = { ...value };

  if (typeof normalized.acceptanceState !== "string") {
    normalized.acceptanceState = readLegacyAcceptanceState(normalized.status);
  }

  if (typeof normalized.reviewState !== "string") {
    normalized.reviewState = readLegacyReviewState(metadata.review_state);
  }

  if (typeof normalized.decisionState !== "string") {
    normalized.decisionState = "unknown";
  }

  if (typeof normalized.status !== "string") {
    normalized.status = normalized.acceptanceState;
  }

  return normalized;
}

function readLegacyAcceptanceState(value: unknown) {
  if (value === "accepted" || value === "deprecated") {
    return value;
  }
  return "candidate";
}

function readLegacyReviewState(value: unknown) {
  if (value === "reviewed" || value === "needs_revision") {
    return value;
  }
  return "unreviewed";
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Rationale file must start with YAML frontmatter.");
  }

  const closingIndex = markdown.indexOf("\n---", 4);
  if (closingIndex < 0) {
    throw new Error("Rationale file frontmatter is not closed.");
  }

  const yamlText = markdown.slice(4, closingIndex);
  const body = markdown.slice(closingIndex + 4).trimStart();
  return { frontmatter: YAML.parse(yamlText), body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(markdownBody: string) {
  const lines = markdownBody.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  if (titleIndex < 0) {
    throw new Error("Rationale file must include a level-one title.");
  }
  const title = lines[titleIndex]?.slice(2).trim();
  if (!title) {
    throw new Error("Rationale file title cannot be blank.");
  }

  return {
    title,
    // Existing section headings remain ordinary body Markdown instead of being
    // interpreted as a fixed storage schema.
    body: lines.slice(titleIndex + 1).join("\n").trim()
  };
}

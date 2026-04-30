import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { rationaleEntrySchema, type RationaleEntry } from "./schema.js";

type ParsedFrontmatter = {
  frontmatter: unknown;
  body: string;
};

const sectionHeadings = [
  "Situation",
  "Goal",
  "Constraints",
  "Decision",
  "Rationale",
  "Rejected alternatives",
  "Tradeoff",
  "Reuse when",
  "Avoid when"
];

export class MemoryFileStore {
  constructor(private readonly dataDirectory: string) {}

  async writeEntry(entry: RationaleEntry) {
    const directory = path.join(this.dataDirectory, "rationales");
    await mkdir(directory, { recursive: true });
    const canonicalPath = path.join(directory, `${entry.frontmatter.id}.md`);
    await writeFile(canonicalPath, serializeRationaleEntry(entry), "utf8");
    return canonicalPath;
  }

  async readEntry(canonicalPath: string) {
    const markdown = await readFile(canonicalPath, "utf8");
    return parseRationaleMarkdown(markdown);
  }

  async readById(id: string) {
    return this.readEntry(this.pathForId(id));
  }

  pathForId(id: string) {
    return path.join(this.dataDirectory, "rationales", `${id}.md`);
  }

  async listEntries() {
    const directory = path.join(this.dataDirectory, "rationales");
    await mkdir(directory, { recursive: true });
    const fileNames = await readdir(directory);
    const entries: Array<{ canonicalPath: string; entry: RationaleEntry }> = [];

    for (const fileName of fileNames) {
      if (!fileName.endsWith(".md")) {
        continue;
      }

      const canonicalPath = path.join(directory, fileName);
      const entry = await this.readEntry(canonicalPath);
      entries.push({ canonicalPath, entry });
    }

    return entries;
  }
}

export function serializeRationaleEntry(entry: RationaleEntry) {
  const frontmatter = YAML.stringify(entry.frontmatter);
  const lines = [
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${entry.title}`,
    ""
  ];

  appendOptionalSection(lines, "Situation", entry.situation);
  appendOptionalSection(lines, "Goal", entry.goal);
  appendListSection(lines, "Constraints", entry.constraints);
  appendOptionalSection(lines, "Decision", entry.decision);
  appendOptionalSection(lines, "Rationale", entry.rationale);
  appendRejectedAlternatives(lines, entry.rejectedAlternatives);
  appendOptionalSection(lines, "Tradeoff", entry.tradeoff);
  appendListSection(lines, "Reuse when", entry.reuseWhen);
  appendListSection(lines, "Avoid when", entry.avoidWhen);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseRationaleMarkdown(markdown: string) {
  const parsed = parseFrontmatter(markdown);
  const title = parseTitle(parsed.body);
  const sections = parseSections(parsed.body);
  const frontmatterResult = rationaleEntrySchema.shape.frontmatter.parse(parsed.frontmatter);

  return rationaleEntrySchema.parse({
    frontmatter: frontmatterResult,
    title,
    situation: sections.get("Situation"),
    goal: sections.get("Goal"),
    constraints: parseBulletList(sections.get("Constraints")),
    decision: sections.get("Decision"),
    rationale: sections.get("Rationale"),
    rejectedAlternatives: parseRejectedAlternatives(sections.get("Rejected alternatives")),
    tradeoff: sections.get("Tradeoff"),
    reuseWhen: parseBulletList(sections.get("Reuse when")),
    avoidWhen: parseBulletList(sections.get("Avoid when")),
    rawMarkdown: markdown
  });
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

function parseTitle(body: string) {
  const firstHeading = body.split("\n").find((line) => line.startsWith("# "));
  if (!firstHeading) {
    throw new Error("Rationale file must include a level-one title.");
  }
  return firstHeading.slice(2).trim();
}

function parseSections(body: string) {
  const sections = new Map<string, string>();
  const lines = body.split("\n");
  let activeHeading: string | undefined;
  let buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushSection(sections, activeHeading, buffer);
      const heading = line.slice(3).trim();
      activeHeading = sectionHeadings.includes(heading) ? heading : undefined;
      buffer = [];
      continue;
    }

    if (activeHeading) {
      buffer.push(line);
    }
  }

  flushSection(sections, activeHeading, buffer);
  return sections;
}

function flushSection(sections: Map<string, string>, heading: string | undefined, buffer: string[]) {
  if (!heading) {
    return;
  }

  sections.set(heading, buffer.join("\n").trim());
}

function parseBulletList(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

function parseRejectedAlternatives(value: string | undefined) {
  if (!value) {
    return [];
  }

  const alternatives: Array<{ option: string; reason: string }> = [];
  const lines = value.split("\n").map((line) => line.trim());
  let option: string | undefined;

  for (const line of lines) {
    if (line.startsWith("- ") && !line.startsWith("- Rejected because ")) {
      option = line.slice(2).trim();
      continue;
    }

    if (option && line.startsWith("- Rejected because ")) {
      alternatives.push({
        option,
        reason: line.slice("- Rejected because ".length).trim()
      });
      option = undefined;
    }
  }

  return alternatives;
}

function appendOptionalSection(lines: string[], heading: string, content: string | undefined) {
  if (!content) {
    return;
  }

  lines.push(`## ${heading}`, content, "");
}

function appendListSection(lines: string[], heading: string, items: string[]) {
  if (items.length === 0) {
    return;
  }

  lines.push(`## ${heading}`, ...items.map((item) => `- ${item}`), "");
}

function appendRejectedAlternatives(lines: string[], alternatives: Array<{ option: string; reason: string }>) {
  if (alternatives.length === 0) {
    return;
  }

  lines.push("## Rejected alternatives");
  for (const alternative of alternatives) {
    lines.push(`- ${alternative.option}`, `  - Rejected because ${alternative.reason}`);
  }
  lines.push("");
}


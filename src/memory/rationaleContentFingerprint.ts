import { createHash } from "node:crypto";
import { recordCandidateInputSchema, type RecordCandidateInput, type RationaleEntry } from "./schema.js";

export function fingerprintRationaleContent(input: RecordCandidateInput | RationaleEntry) {
  const content = "frontmatter" in input ? rationaleEntryToContentInput(input) : recordCandidateInputSchema.parse(input);
  const canonicalContent = {
    title: normalizeContentText(content.title),
    situation: normalizeOptionalContentText(content.situation),
    goal: normalizeOptionalContentText(content.goal),
    constraints: normalizeContentList(content.constraints),
    decision: normalizeOptionalContentText(content.decision),
    rationale: normalizeContentText(content.rationale),
    rejectedAlternatives: (content.rejectedAlternatives ?? []).map((alternative) => ({
      option: normalizeContentText(alternative.option),
      reason: normalizeContentText(alternative.reason)
    })),
    tradeoff: normalizeOptionalContentText(content.tradeoff),
    reuseWhen: normalizeContentList(content.reuseWhen),
    avoidWhen: normalizeContentList(content.avoidWhen)
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalContent))
    .digest("hex");
}

function rationaleEntryToContentInput(entry: RationaleEntry): RecordCandidateInput {
  return {
    title: entry.title,
    situation: entry.situation,
    goal: entry.goal,
    constraints: entry.constraints,
    decision: entry.decision,
    rationale: entry.rationale,
    rejectedAlternatives: entry.rejectedAlternatives,
    tradeoff: entry.tradeoff,
    reuseWhen: entry.reuseWhen,
    avoidWhen: entry.avoidWhen
  };
}

function normalizeOptionalContentText(value: string | undefined) {
  if (typeof value === "undefined") {
    return undefined;
  }

  const normalized = normalizeContentText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeContentText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function normalizeContentList(values: string[] | undefined) {
  return (values ?? [])
    .map(normalizeContentText)
    .filter((value) => value.length > 0);
}

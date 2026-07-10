import { createHash } from "node:crypto";
import { recordCandidateInputSchema, type RecordCandidateInput, type RationaleEntry } from "./schema.js";

export function fingerprintRationaleContent(input: RecordCandidateInput | RationaleEntry) {
  const content = "frontmatter" in input ? rationaleEntryToContentInput(input) : recordCandidateInputSchema.parse(input);
  // Provenance and classification do not make the same reusable document a new
  // memory, so deduplication is based only on its canonical title and body.
  const canonicalContent = {
    title: normalizeContentText(content.title),
    body: normalizeContentText(content.body)
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalContent))
    .digest("hex");
}

function rationaleEntryToContentInput(entry: RationaleEntry): RecordCandidateInput {
  return {
    title: entry.title,
    body: entry.body
  };
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

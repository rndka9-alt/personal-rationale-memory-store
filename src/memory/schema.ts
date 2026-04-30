import { z } from "zod";

export const rejectedAlternativeSchema = z.object({
  option: z.string().min(1),
  reason: z.string().min(1)
});

export const sourceMetadataSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1)
});

export const rationaleFrontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).default("rationale"),
  status: z.string().min(1).default("candidate"),
  scope: z.string().min(1).default("general"),
  domains: z.array(z.string()).default([]),
  intents: z.array(z.string()).default([]),
  modes: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  source: sourceMetadataSchema.optional(),
  promotedTo: z.string().optional(),
  deprecatedBy: z.string().optional(),
  metadata: z.record(z.unknown()).default({})
});

export const rationaleEntrySchema = z.object({
  frontmatter: rationaleFrontmatterSchema,
  title: z.string().min(1),
  situation: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  decision: z.string().optional(),
  rationale: z.string().min(1),
  rejectedAlternatives: z.array(rejectedAlternativeSchema).default([]),
  tradeoff: z.string().optional(),
  reuseWhen: z.array(z.string()).default([]),
  avoidWhen: z.array(z.string()).default([]),
  rawMarkdown: z.string().default("")
});

export const recordCandidateInputSchema = z.object({
  title: z.string().min(1),
  situation: z.string().optional(),
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  decision: z.string().optional(),
  rationale: z.string().min(1),
  rejectedAlternatives: z.array(rejectedAlternativeSchema).optional(),
  tradeoff: z.string().optional(),
  reuseWhen: z.array(z.string()).optional(),
  avoidWhen: z.array(z.string()).optional(),
  source: sourceMetadataSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

export const searchInputSchema = z.object({
  query: z.string().min(1),
  domains: z.array(z.string()).optional(),
  intents: z.array(z.string()).optional(),
  modes: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  status: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).default(10),
  includeDeprecated: z.boolean().default(false)
});

export type RationaleEntry = z.infer<typeof rationaleEntrySchema>;
export type RecordCandidateInput = z.infer<typeof recordCandidateInputSchema>;
export type MemorySearchFilters = Omit<z.infer<typeof searchInputSchema>, "query">;

export type MemoryEntryRecord = {
  id: string;
  type: string;
  status: string;
  title: string;
  summary?: string;
  canonicalPath: string;
  scope: string;
  sourceKind?: string;
  sourceRef?: string;
  confidence: number;
  promotedTo?: string;
  deprecatedBy?: string;
  metadata: Record<string, unknown>;
};

export function toMemoryEntryRecord(entry: RationaleEntry, canonicalPath: string): MemoryEntryRecord {
  return {
    id: entry.frontmatter.id,
    type: entry.frontmatter.type,
    status: entry.frontmatter.status,
    title: entry.title,
    summary: summarizeRationale(entry),
    canonicalPath,
    scope: entry.frontmatter.scope,
    sourceKind: entry.frontmatter.source?.kind,
    sourceRef: entry.frontmatter.source?.ref,
    confidence: entry.frontmatter.confidence,
    promotedTo: entry.frontmatter.promotedTo,
    deprecatedBy: entry.frontmatter.deprecatedBy,
    metadata: {
      ...entry.frontmatter.metadata,
      domains: entry.frontmatter.domains,
      intents: entry.frontmatter.intents,
      modes: entry.frontmatter.modes
    }
  };
}

export function summarizeRationale(entry: RationaleEntry) {
  const pieces = [entry.situation, entry.decision, entry.rationale].filter(isNonEmptyString);
  return pieces.join(" ").slice(0, 500);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}


import { z } from "zod";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { RationaleService, RationaleWriteResult } from "../memory/rationaleService.js";
import {
  autoCaptureRationaleInputSchema,
  recordCandidateInputSchema,
  recordRefinementOpinionInputSchema,
  recordUsageFeedbackInputSchema,
  searchInputSchema,
  searchProjectFilterSchema
} from "../memory/schema.js";
import { logError, logInfo } from "../diagnostics/index.js";
import type { StatusService } from "../diagnostics/statusService.js";

export type ToolServices = {
  rationaleService: Pick<
    RationaleService,
    | "searchWithDiagnostics"
    | "getRationale"
    | "autoCaptureRationale"
    | "recordRefinementOpinion"
    | "recordUsageFeedback"
    | "reindexMemory"
    | "recordCandidate"
  >;
  contextComposer: Pick<ContextComposer, "compose" | "continueContext">;
  statusService: Pick<StatusService, "status">;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  metadata: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const sessionCandidateInputSchema = z.object({
  title: recordCandidateInputSchema.shape.title,
  type: recordCandidateInputSchema.shape.type,
  situation: recordCandidateInputSchema.shape.situation,
  goal: recordCandidateInputSchema.shape.goal,
  constraints: recordCandidateInputSchema.shape.constraints,
  decision: recordCandidateInputSchema.shape.decision,
  rationale: recordCandidateInputSchema.shape.rationale,
  rejectedAlternatives: recordCandidateInputSchema.shape.rejectedAlternatives,
  tradeoff: recordCandidateInputSchema.shape.tradeoff,
  reuseWhen: recordCandidateInputSchema.shape.reuseWhen,
  avoidWhen: recordCandidateInputSchema.shape.avoidWhen,
  project: recordCandidateInputSchema.shape.project,
  metadata: recordCandidateInputSchema.shape.metadata
});

export function toolDefinitions(services: ToolServices): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    {
      name: "get_status",
      description: "Return service, storage, database, and indexing status.",
      schema: {},
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("메모장 찾아보는 중..", "찾았어요!"),
      handler: async () => jsonToolResult(await services.statusService.status())
    },
    {
      name: "search_rationales",
      description: "Search rationale memories with lexical, vector, and metadata signals. Optionally pass project (current repo) to boost same-project memories; other projects are never penalized.",
      schema: searchInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("괜찮은 메모가 있나 찾아보는 중..", "찾아보기 완료!"),
      handler: async (input: unknown) => jsonToolResult(await services.rationaleService.searchWithDiagnostics(input))
    },
    {
      name: "get_rationale",
      description: "Read a rationale by id from canonical Markdown.",
      schema: { id: z.string().min(1) },
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("특정 메모 확인하는 중..", "메모 확인 완료!"),
      handler: async (input) => jsonToolResult(await services.rationaleService.getRationale(z.string().parse(input.id)))
    },
    {
      name: "compose_context",
      description: "Compose bounded prompt-ready rationale context for a task. Pass project (current repo) to boost memories captured in the active project; other projects are never penalized. Note-type memories are excluded by default; set includeNotes to pull them in.",
      schema: {
        task: z.string().min(1),
        explicitMode: z.string().optional(),
        explicitDomains: z.array(z.string()).optional(),
        project: searchProjectFilterSchema.optional(),
        includeNotes: z.boolean().optional(),
        tokenBudget: z.number().int().positive().optional(),
        includeFullTopK: z.number().int().min(0).optional(),
        minScore: z.number().min(0).optional()
      },
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("메모 훑어보는 중..", "메모 훑어보기 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.compose(composeInputSchema.parse(input)))
    },
    {
      name: "continue_context",
      description: "Continue a previous compose_context retrieval from a stateful in-memory cursor.",
      schema: {
        cursor: z.string().min(1),
        tokenBudget: z.number().int().positive().optional(),
        includeFullTopK: z.number().int().min(0).optional()
      },
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("계속해서 훑어보는 중..", "추가 확인 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.continueContext(continueInputSchema.parse(input)))
    },
    {
      name: "auto_capture_rationale",
      description:
        "Record relevant content into memory. Only title and rationale are required — add constraints, tradeoffs, reuseWhen, and avoidWhen when you know them. Memories can be referenced from other tasks and later conversations, so actively capture anything that seems useful later — decisions, reasoning, preferences, lessons learned. Set type to preference, convention, constraint, or known_failure for non-decision knowledge, or note for general observations and ideas (defaults to rationale). Notes stay searchable but are kept out of composed task context. Weak or duplicate captures are filtered out downstream; when in doubt, capture.",
      schema: autoCaptureRationaleInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 작성 중..", "메모 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(compactRationaleWriteResult(
          await services.rationaleService.autoCaptureRationale(autoCaptureRationaleInputSchema.parse(input))
        ))
    },
    {
      name: "record_refinement_opinion",
      description: "Attach a bounded unresolved refinement opinion or patch request to a rationale memory.",
      schema: recordRefinementOpinionInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모에 의견 붙이는 중..", "의견 붙이기 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(compactRefinementOpinionWriteResult(
          await services.rationaleService.recordRefinementOpinion(recordRefinementOpinionInputSchema.parse(input))
        ))
    },
    {
      name: "record_usage_feedback",
      description: "Record explicit feedback after a rationale memory was applied, helpful, unhelpful, or dismissed.",
      schema: recordUsageFeedbackInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모를 평가하는 중..", "평가 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(compactUsageFeedbackWriteResult(
          await services.rationaleService.recordUsageFeedback(recordUsageFeedbackInputSchema.parse(input))
        ))
    },
    {
      name: "reindex_memory",
      description: "Rebuild the DB index from canonical Markdown files.",
      schema: {
        scope: z.enum(["all", "changed", "untagged"]).optional(),
        ids: z.array(z.string()).optional()
      },
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 정리 중..", "정리 완료!"),
      handler: async (input) => {
        const parsedInput = reindexInputSchema.parse(input);
        return jsonToolResult({
          ok: true,
          indexed: await services.rationaleService.reindexMemory(parsedInput.scope, parsedInput.ids)
        });
      }
    },
    {
      name: "ingest_session_candidates",
      description: "Record multiple rationale candidates from a session.",
      schema: {
        sessionRef: z.string().min(1),
        candidates: z.array(sessionCandidateInputSchema)
      },
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 후보 모으는 중..", "후보 정리 완료!"),
      handler: async (input) => {
        const parsedInput = ingestSessionInputSchema.parse(input);
        const results = [];
        for (const candidate of parsedInput.candidates) {
          results.push(await services.rationaleService.recordCandidate({
            ...candidate,
            source: { kind: "session", ref: parsedInput.sessionRef },
            metadata: {
              ...candidate.metadata,
              capture_kind: "session",
              session_ref: parsedInput.sessionRef
            }
          }));
        }
        return jsonToolResult(compactBulkRationaleWriteResult(results));
      }
    }
  ];

  return definitions.map(withToolLogging);
}

const jsonOutputSchema = {
  result: z.unknown()
};

const textOutputSchema = {
  text: z.string()
};

const readOnlyToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
};

const writeToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
};

const composeInputSchema = z.object({
  task: z.string().min(1),
  explicitMode: z.string().optional(),
  explicitDomains: z.array(z.string()).optional(),
  project: searchProjectFilterSchema.optional(),
  includeNotes: z.boolean().optional(),
  tokenBudget: z.number().int().positive().optional(),
  includeFullTopK: z.number().int().min(0).optional(),
  minScore: z.number().min(0).optional()
});

const continueInputSchema = z.object({
  cursor: z.string().min(1),
  tokenBudget: z.number().int().positive().optional(),
  includeFullTopK: z.number().int().min(0).optional()
});

const reindexInputSchema = z.object({
  scope: z.enum(["all", "changed", "untagged"]).optional(),
  ids: z.array(z.string()).optional()
});

const ingestSessionInputSchema = z.object({
  sessionRef: z.string().min(1),
  candidates: z.array(sessionCandidateInputSchema)
});

function jsonToolResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

function textToolResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { text }
  };
}

function toolInvocationMetadata(invoking: string, invoked: string) {
  return {
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked
  };
}

function compactRationaleWriteResult(result: RationaleWriteResult) {
  const response: {
    ok: true;
    id: string;
    canonicalPath: string;
    status?: RationaleWriteResult["status"];
    existingId?: string;
  } = {
    ok: true,
    id: result.id,
    canonicalPath: result.canonicalPath
  };

  if (result.status) {
    response.status = result.status;
  }

  if (result.existingId) {
    response.existingId = result.existingId;
  }

  return response;
}

function compactBulkRationaleWriteResult(results: RationaleWriteResult[]) {
  const duplicateIds = results
    .filter((result) => result.status === "duplicate")
    .map((result) => result.id);
  const processingIds = results
    .filter((result) => result.status === "processing")
    .map((result) => result.id);

  const response: {
    ok: true;
    count: number;
    ids: string[];
    duplicateIds?: string[];
    processingIds?: string[];
  } = {
    ok: true,
    count: results.length,
    ids: results.map((result) => result.id)
  };

  if (duplicateIds.length > 0) {
    response.duplicateIds = duplicateIds;
  }

  if (processingIds.length > 0) {
    response.processingIds = processingIds;
  }

  return response;
}

function compactRefinementOpinionWriteResult(result: { id: string; entryId: string; status: string }) {
  return {
    ok: true,
    id: result.id,
    entryId: result.entryId,
    status: result.status
  };
}

function compactUsageFeedbackWriteResult(result: {
  entryId: string;
  eventType: string;
  useCount: number;
  lastUsedAt?: string;
}) {
  return {
    ok: true,
    entryId: result.entryId,
    eventType: result.eventType,
    useCount: result.useCount,
    lastUsedAt: result.lastUsedAt
  };
}

function withToolLogging(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    handler: async (input) => {
      logInfo("MCP tool started.", {
        tool: definition.name
      });

      try {
        const result = await definition.handler(input);
        logInfo("MCP tool completed.", {
          tool: definition.name
        });
        return result;
      } catch (error) {
        logError("MCP tool failed.", error, {
          tool: definition.name
        });
        throw error;
      }
    }
  };
}

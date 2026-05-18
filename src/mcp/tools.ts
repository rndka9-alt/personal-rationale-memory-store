import { z } from "zod";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { RationaleService } from "../memory/rationaleService.js";
import { autoCaptureRationaleInputSchema, recordCandidateInputSchema, searchInputSchema } from "../memory/schema.js";
import { logError, logInfo } from "../diagnostics/index.js";
import type { StatusService } from "../diagnostics/statusService.js";

export type ToolServices = {
  rationaleService: RationaleService;
  contextComposer: ContextComposer;
  statusService: StatusService;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

const sessionCandidateInputSchema = z.object({
  title: recordCandidateInputSchema.shape.title,
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
      handler: async () => jsonToolResult(await services.statusService.status())
    },
    {
      name: "search_rationales",
      description: "Search rationale memories with lexical, vector, and metadata signals.",
      schema: searchInputSchema.shape,
      handler: async (input: unknown) => jsonToolResult(await services.rationaleService.search(input))
    },
    {
      name: "get_rationale",
      description: "Read a rationale by id from canonical Markdown.",
      schema: { id: z.string().min(1) },
      handler: async (input) => jsonToolResult(await services.rationaleService.getRationale(z.string().parse(input.id)))
    },
    {
      name: "compose_context",
      description: "Compose bounded prompt-ready rationale context for a task.",
      schema: {
        task: z.string().min(1),
        explicitMode: z.string().optional(),
        explicitDomains: z.array(z.string()).optional(),
        tokenBudget: z.number().int().positive().optional(),
        includeFullTopK: z.number().int().min(0).optional(),
        minScore: z.number().min(0).optional()
      },
      handler: async (input) => ({
        content: [{ type: "text", text: await services.contextComposer.compose(composeInputSchema.parse(input)) }]
      })
    },
    {
      name: "continue_context",
      description: "Continue a previous compose_context retrieval from a stateful in-memory cursor.",
      schema: {
        cursor: z.string().min(1),
        tokenBudget: z.number().int().positive().optional(),
        includeFullTopK: z.number().int().min(0).optional()
      },
      handler: async (input) => ({
        content: [{ type: "text", text: await services.contextComposer.continueContext(continueInputSchema.parse(input)) }]
      })
    },
    {
      name: "auto_capture_rationale",
      description: "Let an LLM autonomously record a reusable rationale candidate into the review queue.",
      schema: autoCaptureRationaleInputSchema.shape,
      handler: async (input: unknown) =>
        jsonToolResult(await services.rationaleService.autoCaptureRationale(autoCaptureRationaleInputSchema.parse(input)))
    },
    {
      name: "reindex_memory",
      description: "Rebuild the DB index from canonical Markdown files.",
      schema: {
        scope: z.enum(["all", "changed"]).optional(),
        ids: z.array(z.string()).optional()
      },
      handler: async (input) => {
        const parsedInput = reindexInputSchema.parse(input);
        return jsonToolResult({ indexed: await services.rationaleService.reindexMemory(parsedInput.scope, parsedInput.ids) });
      }
    },
    {
      name: "ingest_session_candidates",
      description: "Record multiple rationale candidates from a session.",
      schema: {
        sessionRef: z.string().min(1),
        candidates: z.array(sessionCandidateInputSchema)
      },
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
        return jsonToolResult(results);
      }
    }
  ];

  return definitions.map(withToolLogging);
}

const composeInputSchema = z.object({
  task: z.string().min(1),
  explicitMode: z.string().optional(),
  explicitDomains: z.array(z.string()).optional(),
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
  scope: z.enum(["all", "changed"]).optional(),
  ids: z.array(z.string()).optional()
});

const ingestSessionInputSchema = z.object({
  sessionRef: z.string().min(1),
  candidates: z.array(sessionCandidateInputSchema)
});

function jsonToolResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
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

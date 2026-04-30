import { z } from "zod";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { RationaleService } from "../memory/rationaleService.js";
import type { OntologyService } from "../ontology/ontologyService.js";
import { autoCaptureRationaleInputSchema, recordCandidateInputSchema, searchInputSchema } from "../memory/schema.js";
import { logError, logInfo } from "../diagnostics/index.js";
import type { StatusService } from "../diagnostics/statusService.js";

export type ToolServices = {
  rationaleService: RationaleService;
  ontologyService: OntologyService;
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
      name: "list_rationale_candidates",
      description: "List rationale candidates that are waiting for review.",
      schema: { limit: z.number().int().positive().max(50).optional() },
      handler: async (input) => {
        const parsedInput = listCandidatesInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.listCandidates(parsedInput.limit));
      }
    },
    {
      name: "review_rationale_candidates",
      description: "Produce a Markdown review of rationale candidates with missing sections and recommendations.",
      schema: { limit: z.number().int().positive().max(50).optional() },
      handler: async (input) => {
        const parsedInput = listCandidatesInputSchema.parse(input);
        return {
          content: [{ type: "text", text: await services.rationaleService.reviewCandidates(parsedInput.limit) }]
        };
      }
    },
    {
      name: "auto_capture_rationale",
      description: "Let an LLM autonomously record a reusable rationale candidate into the review queue.",
      schema: autoCaptureRationaleInputSchema.shape,
      handler: async (input: unknown) =>
        jsonToolResult(await services.rationaleService.autoCaptureRationale(autoCaptureRationaleInputSchema.parse(input)))
    },
    {
      name: "list_review_queue",
      description: "List candidate rationales queued for later human review.",
      schema: {
        limit: z.number().int().positive().max(50).optional(),
        captureKind: z.enum(["auto", "manual", "session"]).optional(),
        reviewState: z.enum(["unreviewed", "reviewed", "needs_revision"]).optional()
      },
      handler: async (input) => {
        const parsedInput = reviewQueueInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.listReviewQueue(
          parsedInput.limit,
          parsedInput.captureKind,
          parsedInput.reviewState
        ));
      }
    },
    {
      name: "review_queue",
      description: "Produce a Markdown review report for queued rationale candidates.",
      schema: {
        limit: z.number().int().positive().max(50).optional(),
        captureKind: z.enum(["auto", "manual", "session"]).optional(),
        reviewState: z.enum(["unreviewed", "reviewed", "needs_revision"]).optional()
      },
      handler: async (input) => {
        const parsedInput = reviewQueueInputSchema.parse(input);
        return {
          content: [{
            type: "text",
            text: await services.rationaleService.reviewQueue(
              parsedInput.limit,
              parsedInput.captureKind,
              parsedInput.reviewState
            )
          }]
        };
      }
    },
    {
      name: "mark_review_queue_item",
      description: "Mark a queued rationale as accepted, reviewed, needing revision, or deprecated.",
      schema: {
        id: z.string().min(1),
        action: z.enum(["accept", "keep_candidate", "needs_revision", "deprecate"]),
        notes: z.string().optional(),
        reason: z.string().optional(),
        patch: z.record(z.unknown()).optional()
      },
      handler: async (input) => {
        const parsedInput = markReviewQueueItemInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.markReviewQueueItem(
          parsedInput.id,
          parsedInput.action,
          {
            notes: parsedInput.notes,
            reason: parsedInput.reason,
            patch: parsedInput.patch
          }
        ));
      }
    },
    {
      name: "bulk_deprecate_review_queue",
      description: "Deprecate several queued rationale candidates at once.",
      schema: {
        ids: z.array(z.string().min(1)).min(1).max(50),
        reason: z.string().min(1)
      },
      handler: async (input) => {
        const parsedInput = bulkDeprecateReviewQueueInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.bulkDeprecateReviewQueue(
          parsedInput.ids,
          parsedInput.reason
        ));
      }
    },
    {
      name: "record_candidate",
      description: "Record a rationale candidate as Markdown and index it.",
      schema: recordCandidateInputSchema.shape,
      handler: async (input: unknown) => jsonToolResult(await services.rationaleService.recordCandidate(recordCandidateInputSchema.parse(input)))
    },
    {
      name: "accept_candidate",
      description: "Promote a candidate rationale to accepted status.",
      schema: { id: z.string().min(1) },
      handler: async (input) => jsonToolResult(await services.rationaleService.acceptCandidate(z.string().parse(input.id)))
    },
    {
      name: "update_rationale",
      description: "Patch mutable rationale fields and reindex the canonical file.",
      schema: { id: z.string().min(1), patch: z.record(z.unknown()) },
      handler: async (input) => {
        const parsedInput = updateRationaleInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.updateRationale(parsedInput.id, parsedInput.patch));
      }
    },
    {
      name: "deprecate_rationale",
      description: "Soft-delete a rationale by marking it deprecated.",
      schema: { id: z.string().min(1), reason: z.string().min(1), replacementId: z.string().optional() },
      handler: async (input) => {
        const parsedInput = deprecateRationaleInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.deprecateRationale(
          parsedInput.id,
          parsedInput.reason,
          parsedInput.replacementId
        ));
      }
    },
    {
      name: "propose_ontology_change",
      description: "Create an explicit ontology change proposal.",
      schema: {
        proposalType: z.enum(["add", "deprecate", "rename", "merge", "split"]),
        targetKind: z.enum(["intent", "domain", "mode", "memory_type", "routing_policy"]),
        name: z.string().min(1),
        reason: z.string().min(1),
        proposedChange: z.record(z.unknown())
      },
      handler: async (input: unknown) => jsonToolResult(await services.ontologyService.proposeOntologyChange(input))
    },
    {
      name: "accept_ontology_proposal",
      description: "Accept an explicit ontology proposal.",
      schema: { id: z.string().min(1) },
      handler: async (input) => jsonToolResult(await services.ontologyService.acceptOntologyProposal(z.string().parse(input.id)))
    },
    {
      name: "promote_to_principle",
      description: "Promote an accepted rationale into a principle memory.",
      schema: { id: z.string().min(1), title: z.string().optional(), reason: z.string().min(1) },
      handler: async (input) => {
        const parsedInput = promoteToPrincipleInputSchema.parse(input);
        return jsonToolResult(await services.rationaleService.promoteToPrinciple(
          parsedInput.id,
          parsedInput.title,
          parsedInput.reason
        ));
      }
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

const listCandidatesInputSchema = z.object({
  limit: z.number().int().positive().max(50).default(10)
});

const reviewQueueInputSchema = z.object({
  limit: z.number().int().positive().max(50).default(10),
  captureKind: z.enum(["auto", "manual", "session"]).optional(),
  reviewState: z.enum(["unreviewed", "reviewed", "needs_revision"]).default("unreviewed")
});

const markReviewQueueItemInputSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["accept", "keep_candidate", "needs_revision", "deprecate"]),
  notes: z.string().optional(),
  reason: z.string().optional(),
  patch: z.record(z.unknown()).optional()
});

const bulkDeprecateReviewQueueInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
  reason: z.string().min(1)
});

const updateRationaleInputSchema = z.object({
  id: z.string().min(1),
  patch: z.record(z.unknown())
});

const deprecateRationaleInputSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  replacementId: z.string().optional()
});

const promoteToPrincipleInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  reason: z.string().min(1)
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

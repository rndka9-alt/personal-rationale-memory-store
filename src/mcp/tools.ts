import { z } from "zod";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { NoteService } from "../memory/noteService.js";
import type { RationaleService, RationaleWriteResult } from "../memory/rationaleService.js";
import {
  autoCaptureRationaleInputSchema,
  composeNotesContextInputSchema,
  noteSourceConversationSchema,
  noteTopicSchema,
  rateNoteInputSchema,
  recordNoteInputSchema,
  recordUsageFeedbackInputSchema,
  searchProjectFilterSchema,
  updateRationaleInputSchema
} from "../memory/schema.js";
import { logError, logInfo } from "../diagnostics/index.js";

export type ToolServices = {
  rationaleService: Pick<
    RationaleService,
    | "searchWithDiagnostics"
    | "getRationale"
    | "getMemoryEntryRecord"
    | "updateRationaleFromRevision"
    | "autoCaptureRationale"
    | "recordUsageFeedback"
  >;
  contextComposer: Pick<ContextComposer, "compose" | "continueContext">;
  noteService: Pick<NoteService, "recordNote" | "rateNote" | "composeNotesContext">;
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

export function toolDefinitions(services: ToolServices): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    {
      name: "search_rationales",
      description: "Search rationale memories with lexical, vector, and metadata signals. Optionally pass project (current repo) to boost same-project memories; other projects are never penalized.",
      schema: searchToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("괜찮은 메모가 있나 찾아보는 중..", "찾아보기 완료!"),
      handler: async (input: unknown) => jsonToolResult(compactSearchResult(
        await services.rationaleService.searchWithDiagnostics(searchToolInputSchema.parse(input))
      ))
    },
    {
      name: "get_rationale",
      description: "Read a rationale by id from canonical Markdown.",
      schema: { id: z.string().min(1) },
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("특정 메모 확인하는 중..", "메모 확인 완료!"),
      handler: async (input) => {
        const id = z.string().parse(input.id);
        const entry = await services.rationaleService.getRationale(id);
        const entryRecord = await services.rationaleService.getMemoryEntryRecord(id);
        return jsonToolResult({
          ...entry,
          revisionId: entryRecord.currentRevisionId
        });
      }
    },
    {
      name: "compose_context",
      description: "Compose bounded prompt-ready rationale context for a task. Pass project (current repo) to boost memories captured in the active project; other projects are never penalized. Plain notes are a separate context source; use compose_notes_context for those.",
      schema: composeInputSchema.shape,
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("메모 훑어보는 중..", "메모 훑어보기 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.compose(composeInputSchema.parse(input)))
    },
    {
      name: "continue_context",
      description: "Continue a previous compose_context retrieval from a stateful in-memory cursor.",
      schema: continueInputSchema.shape,
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("계속해서 훑어보는 중..", "추가 확인 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.continueContext(continueInputSchema.parse(input)))
    },
    {
      name: "record_note",
      description:
        "Record a lightweight personal note. When it comes from the current conversation, include sourceContext with a concise topic and 1–4 relevant user/assistant messages preserving their original roles, text, and order. Omit sourceContext only for standalone notes.",
      schema: recordNoteToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("쪽지 적는 중..", "쪽지 적엇어요!"),
      handler: async (input: unknown) => {
        const parsedInput = recordNoteToolInputSchema.parse(input);
        return jsonToolResult(compactNoteResult(
          await services.noteService.recordNote(toRecordNoteInput(parsedInput))
        ));
      }
    },
    {
      name: "rate_note",
      description: "Add one upvote or downvote to a note using its short slot id, shown by compose_notes_context in each note's '━━━ <slot> ━━━' header line. Slots are ephemeral (LRU, capacity 40); rating an expired slot returns ok:false with httpStatus 410 instead of an error, so just re-fetch the notes and rate again.",
      schema: rateNoteInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("쪽지 평가 중..", "쪽지 평가 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(await services.noteService.rateNote(rateNoteInputSchema.parse(input)))
    },
    {
      name: "compose_notes_context",
      description: "Compose plain note context from original note text. Notes are selected by weighted random first, then score ordering, within a character budget. The output ends with a rate_note nudge; note bodies are never rewritten.",
      schema: composeNotesContextInputSchema.shape,
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("쪽지 꺼내는 중..", "쪽지 꺼냇어요!"),
      handler: async (input: unknown) =>
        textToolResult(await services.noteService.composeNotesContext(composeNotesContextInputSchema.parse(input)))
    },
    {
      name: "auto_capture_rationale",
      description:
        "Record reusable rationale memory as a title and self-contained Markdown body. Use record_note for casual or lightweight personal notes.",
      schema: autoCaptureRationaleToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 작성 중..", "메모 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(compactRationaleWriteResult(
          await services.rationaleService.autoCaptureRationale(autoCaptureRationaleToolInputSchema.parse(input))
        ))
    },
    {
      name: "update_rationale",
      description: "Replace a rationale title and body from a base revision.",
      schema: updateRationaleToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 수정 중..", "메모 수정 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(await services.rationaleService.updateRationaleFromRevision(updateRationaleToolInputSchema.parse(input)))
    },
    {
      name: "record_usage_feedback",
      description: "Record explicit feedback after a rationale memory was applied, helpful, unhelpful, or dismissed.",
      schema: recordUsageFeedbackToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모를 평가하는 중..", "평가 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(compactUsageFeedbackWriteResult(
          await services.rationaleService.recordUsageFeedback(recordUsageFeedbackToolInputSchema.parse(input))
        ))
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

const searchToolInputSchema = z.object({
  query: z.string().min(1),
  project: searchProjectFilterSchema.optional()
});

const composeInputSchema = z.object({
  task: z.string().min(1),
  project: searchProjectFilterSchema.optional()
});

const continueInputSchema = z.object({
  cursor: z.string().min(1)
});

const recordNoteToolInputSchema = z.object({
  content: recordNoteInputSchema.shape.content.describe("The lightweight note to remember."),
  // Topic-only context remains valid for existing callers, while the public guidance asks
  // conversational captures to preserve the relevant source messages.
  sourceContext: z.object({
    topic: noteTopicSchema.describe("A short label for the source conversation."),
    messages: noteSourceConversationSchema.shape.messages
      .describe("One to four relevant messages preserving their original speaker roles, text, and order.")
      .optional()
  })
    .optional()
    .describe("Conversation provenance for notes derived from a conversation; omit for standalone notes.")
});

const autoCaptureRationaleToolInputSchema = z.object({
  title: autoCaptureRationaleInputSchema.shape.title,
  body: autoCaptureRationaleInputSchema.shape.body,
  type: autoCaptureRationaleInputSchema.shape.type,
  project: searchProjectFilterSchema.optional()
});

const updateRationaleToolInputSchema = z.object({
  revisionId: updateRationaleInputSchema.shape.revisionId,
  reason: updateRationaleInputSchema.shape.reason,
  title: updateRationaleInputSchema.shape.title,
  body: updateRationaleInputSchema.shape.body
});

const recordUsageFeedbackToolInputSchema = z.object({
  entryId: recordUsageFeedbackInputSchema.shape.entryId,
  eventType: recordUsageFeedbackInputSchema.shape.eventType
});

function toRecordNoteInput(input: z.infer<typeof recordNoteToolInputSchema>) {
  if (!input.sourceContext) {
    return { content: input.content };
  }
  if (!input.sourceContext.messages) {
    return {
      content: input.content,
      topic: input.sourceContext.topic
    };
  }
  return {
    content: input.content,
    topic: input.sourceContext.topic,
    sourceConversation: {
      messages: input.sourceContext.messages
    }
  };
}

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

function compactSearchResult(result: {
  results: Array<{
    id: string;
    title: string;
    summary?: string;
    type: string;
    acceptanceState: string;
    reviewState: string;
    decisionState: string;
  }>;
  warnings: Array<{
    kind: string;
    severity: string;
    message: string;
  }>;
}) {
  const response: {
    results: Array<{
      id: string;
      title: string;
      type: string;
      acceptanceState: string;
      reviewState: string;
      decisionState: string;
      summary?: string;
    }>;
    warnings?: Array<{
      kind: string;
      severity: string;
      message: string;
    }>;
  } = {
    results: result.results.map(compactSearchEntry)
  };

  if (result.warnings.length > 0) {
    response.warnings = result.warnings.map((warning) => ({
      kind: warning.kind,
      severity: warning.severity,
      message: warning.message
    }));
  }

  return response;
}

function compactSearchEntry(entry: {
  id: string;
  title: string;
  summary?: string;
  type: string;
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
}) {
  const response: {
    id: string;
    title: string;
    type: string;
    acceptanceState: string;
    reviewState: string;
    decisionState: string;
    summary?: string;
  } = {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    acceptanceState: entry.acceptanceState,
    reviewState: entry.reviewState,
    decisionState: entry.decisionState
  };

  if (entry.summary) {
    response.summary = entry.summary;
  }

  return response;
}

function compactRationaleWriteResult(result: RationaleWriteResult) {
  const response: {
    ok: true;
    id: string;
    status?: RationaleWriteResult["status"];
  } = {
    ok: true,
    id: result.id
  };

  if (result.status) {
    response.status = result.status;
  }

  return response;
}

function compactNoteResult(result: { id: string }) {
  return {
    ok: true,
    id: result.id
  };
}

function compactUsageFeedbackWriteResult(result: {
  entryId: string;
  eventType: string;
}) {
  return {
    ok: true,
    entryId: result.entryId,
    eventType: result.eventType
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

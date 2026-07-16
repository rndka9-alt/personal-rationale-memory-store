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
    | "getLatestRationaleFromRevision"
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
      description: "Search rationale memories with lexical, vector, and metadata signals. Result ids identify the current revision snapshot. Write natural-language queries in Korean while keeping code identifiers, exact search terms, and proper nouns unchanged. Optionally pass project (current repo) to boost same-project memories; other projects are never penalized.",
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
      description: "Read the latest rationale for the memory identified by a revision id. If the supplied revision is stale, returns the latest revision's content and id.",
      schema: { id: z.string().min(1) },
      outputSchema: jsonOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("특정 메모 확인하는 중..", "메모 확인 완료!"),
      handler: async (input) => {
        const id = z.string().parse(input.id);
        const snapshot = await services.rationaleService.getLatestRationaleFromRevision(id);
        return jsonToolResult({
          id: snapshot.id,
          title: snapshot.entry.title,
          body: snapshot.entry.body
        });
      }
    },
    {
      name: "compose_context",
      description: "Compose bounded prompt-ready rationale context for a task. The task field is a retrieval query, not an instruction to an agent: state the topic in 1-3 Korean sentences packed with key entities and terms, keeping code identifiers and proper nouns unchanged, and do not ask for judgment or actions. Pass project (current repo) to boost memories captured in the active project; other projects are never penalized. Plain notes are a separate context source; use compose_notes_context for those.",
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
        "Record a lightweight personal note — raw material for a synthesized long-term memory of the user. Write content and topic in Korean while keeping code identifiers and proper nouns unchanged. When it comes from the current conversation, include sourceContext with 1–4 relevant user/assistant messages preserving their original language, roles, text, and order. Omit sourceContext only for standalone notes.",
      schema: recordNoteToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("쪽지 적는 중..", "쪽지 적엇어요!"),
      handler: async (input: unknown) => {
        const parsedInput = recordNoteToolInputSchema.parse(input);
        // 노트 id(N…)는 어떤 MCP 툴도 입력으로 받지 않으므로(평가는 slot, archive는 웹 전용)
        // 응답에 싣지 않는다.
        await services.noteService.recordNote(toRecordNoteInput(parsedInput));
        return jsonToolResult({ ok: true });
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
      description: "Retrieve memory about the user: a synthesized digest of who they are (current interests, recent context, long-term background, personality and preferences) followed by original personal notes. Call this early in a conversation to ground responses in what is already known about the user. Notes are selected by weighted random first, then score ordering, within a character budget. The output ends with a rate_note nudge; note bodies are never rewritten.",
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
        "Record reusable rationale memory as a title and self-contained Markdown body. Write title and body in Korean while keeping code identifiers and proper nouns unchanged. Use record_note for casual or lightweight personal notes.",
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
      description: "Replace a rationale title and body from a base revision snapshot id. A stale id returns the latest id without applying the replacement. Write reason, title, and body in Korean while keeping code identifiers and proper nouns unchanged.",
      schema: updateRationaleToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 수정 중..", "메모 수정 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(await services.rationaleService.updateRationaleFromRevision(updateRationaleToolInputSchema.parse(input)))
    },
    {
      name: "rate_memory",
      description: "Rate a memory after acting on retrieved context, using the revision id shown by compose_context or search_rationales. Call it once per memory you actually weighed: \"applied\" if it shaped your answer or work, \"dismissed\" if it was retrieved but not useful this time, \"user_helpful\"/\"user_unhelpful\" only when the user explicitly reacted to an outcome the memory influenced. Ranking aggregates feedback across the whole memory entry.",
      schema: rateMemoryToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모를 평가하는 중..", "평가 완료!"),
      handler: async (input: unknown) => {
        // id·eventType은 호출자가 넣은 입력 에코라 응답에 싣지 않는다.
        await services.rationaleService.recordUsageFeedback(rateMemoryToolInputSchema.parse(input));
        return jsonToolResult({ ok: true });
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

const searchToolInputSchema = z.object({
  query: z.string()
    .min(1)
    .describe("Natural-language search query in Korean; keep code identifiers, exact search terms, and proper nouns unchanged."),
  project: searchProjectFilterSchema.optional()
});

const composeInputSchema = z.object({
  task: z.string()
    .min(1)
    .describe("Retrieval query, not an instruction to an agent: 1-3 Korean sentences stating the topic with its key entities and terms; keep code identifiers and proper nouns unchanged. Questions, requests for judgment, and long narratives degrade matching."),
  project: searchProjectFilterSchema.optional()
});

const continueInputSchema = z.object({
  cursor: z.string().min(1)
});

const recordNoteToolInputSchema = z.object({
  content: recordNoteInputSchema.shape.content
    .describe("Lightweight note in Korean; keep code identifiers and proper nouns unchanged. When stating a judgment or trait about the user, attach the observed grounds (mechanism → conclusion, e.g. \"남에게 줄 영향을 고민하는 편이다. 그래서 메타인지가 뛰어나다\"), never a bare label — fragmentary conclusions without their reasons cannot be re-verified against later observations. Mark your own inferences as such, distinct from the user's direct statements."),
  // Topic-only context remains valid for existing callers, while the public guidance asks
  // conversational captures to preserve the relevant source messages.
  sourceContext: z.object({
    topic: noteTopicSchema.describe("Short Korean label for the source conversation."),
    messages: noteSourceConversationSchema.shape.messages
      .describe("One to four relevant messages preserving their original language, speaker roles, text, and order.")
      .optional()
  })
    .optional()
    .describe("Conversation provenance for notes derived from a conversation; omit for standalone notes.")
});

const autoCaptureRationaleToolInputSchema = z.object({
  title: autoCaptureRationaleInputSchema.shape.title
    .describe("Concise rationale title in Korean; keep code identifiers and proper nouns unchanged."),
  body: autoCaptureRationaleInputSchema.shape.body
    .describe("Self-contained Markdown body in Korean; keep code identifiers and proper nouns unchanged."),
  project: searchProjectFilterSchema.optional()
});

const updateRationaleToolInputSchema = z.object({
  id: updateRationaleInputSchema.shape.id,
  reason: updateRationaleInputSchema.shape.reason
    .describe("Reason for the update in Korean; keep code identifiers and proper nouns unchanged."),
  title: updateRationaleInputSchema.shape.title
    .describe("Complete replacement title in Korean; keep code identifiers and proper nouns unchanged."),
  body: updateRationaleInputSchema.shape.body
    .describe("Complete replacement Markdown body in Korean; keep code identifiers and proper nouns unchanged.")
});

const rateMemoryToolInputSchema = z.object({
  id: recordUsageFeedbackInputSchema.shape.id,
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
    currentRevisionId?: string;
    title: string;
    summary?: string;
    type: string;
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

// acceptanceState·reviewState·decisionState는 리뷰 워크플로우를 실제로 돌리지 않아
// 항상 초기값이라, 검색 응답에서는 제외한다(결과 개수만큼 곱해지는 노이즈).
function compactSearchEntry(entry: {
  id: string;
  currentRevisionId?: string;
  title: string;
  summary?: string;
  type: string;
}) {
  const revisionId = readCurrentRevisionId(entry);
  const response: {
    id: string;
    title: string;
    type: string;
    summary?: string;
  } = {
    id: revisionId,
    title: entry.title,
    type: entry.type
  };

  if (entry.summary) {
    response.summary = entry.summary;
  }

  return response;
}

function compactRationaleWriteResult(result: RationaleWriteResult) {
  if (result.status === "processing") {
    return {
      ok: false as const,
      reason: "processing" as const
    };
  }
  if (!result.revisionId) {
    throw new Error(`Rationale write result has no revision id: ${result.id}`);
  }
  const response: {
    ok: true;
    id: string;
    status?: RationaleWriteResult["status"];
  } = {
    ok: true,
    id: result.revisionId
  };

  if (result.status) {
    response.status = result.status;
  }

  return response;
}

function readCurrentRevisionId(entry: { id: string; currentRevisionId?: string }) {
  if (!entry.currentRevisionId) {
    throw new Error(`Memory entry has no current revision: ${entry.id}`);
  }
  return entry.currentRevisionId;
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

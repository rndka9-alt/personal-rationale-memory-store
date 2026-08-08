import { z } from "zod";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { NoteService } from "../memory/noteService.js";
import type { RationaleService, RationaleWriteResult } from "../memory/rationaleService.js";
import {
  autoCaptureRationaleInputSchema,
  composeNotesContextInputSchema,
  deprecateRationaleInputSchema,
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
    | "deprecateRationaleFromRevision"
    | "restoreRationaleFromRevision"
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
      description: "Search rationale memories. Each result summary is an excerpt anchored to the query terms (or the body head when no term matches), with `…` marking trimmed edges — never conclude information is absent from a summary alone; read the full body with get_rationale first.",
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
      description: "Read the latest revision of the rationale memory identified by a revision id. Stale ids resolve to the latest revision.",
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
      description: "Compose bounded prompt-ready rationale context for a task. Each retrieved memory appears as an excerpt anchored to the task terms, with `…` marking trimmed edges — never conclude information is absent from an excerpt alone; read the full body with get_rationale first. Plain notes are a separate context source; use compose_notes_context for those.",
      schema: composeInputSchema.shape,
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("메모 훑어보는 중..", "메모 훑어보기 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.compose(composeInputSchema.parse(input)))
    },
    {
      name: "continue_context",
      description: "Continue a previous compose_context result using its cursor.",
      schema: continueInputSchema.shape,
      outputSchema: textOutputSchema,
      annotations: readOnlyToolAnnotations,
      metadata: toolInvocationMetadata("계속해서 훑어보는 중..", "추가 확인 완료!"),
      handler: async (input) => textToolResult(await services.contextComposer.continueContext(continueInputSchema.parse(input)))
    },
    {
      name: "record_note",
      description:
        "Record a lightweight personal note — raw material for the synthesized user digest. Always provide a topic: a short subject label used to group notes over time. Write content and topic in Korean while keeping code identifiers and proper nouns unchanged. When the note comes from the current conversation, include sourceContext with 1–4 relevant user/assistant messages preserving their original language, roles, text, and order. Omit sourceContext only for standalone notes.",
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
      description: "Add one upvote or downvote to a note using its short slot id, shown by compose_notes_context in each note's '━━━ <slot> ━━━' header line. Slots are ephemeral; if a slot has expired, call compose_notes_context again and rate the fresh slot.",
      schema: rateNoteInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("쪽지 평가 중..", "쪽지 평가 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(await services.noteService.rateNote(rateNoteInputSchema.parse(input)))
    },
    {
      name: "compose_notes_context",
      description: "Retrieve the synthesized user digest — who they are (current interests, recent context, long-term background, personality and preferences) — followed by original personal notes. Call this early in a conversation to ground responses in what is already known about the user.",
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
        "Record a reusable rationale memory as a title and self-contained Markdown body. Use record_note for casual or lightweight personal notes.",
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
      description: "Replace a rationale memory's title and body from a base revision snapshot id. If the base is stale, read the latest revision, merge your replacement on top of it, and retry with the latest id.",
      schema: updateRationaleToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("메모 수정 중..", "메모 수정 완료!"),
      handler: async (input: unknown) =>
        jsonToolResult(await services.rationaleService.updateRationaleFromRevision(updateRationaleToolInputSchema.parse(input)))
    },
    {
      name: "deprecate_rationale",
      description: "Retire an outdated rationale memory instead of deleting it: it drops out of default search and compose retrieval but stays readable via get_rationale. Call it when a memory no longer holds — a superseded decision, a finished backlog, an invalidated analysis — ideally right after capturing or updating the memory that replaces it.",
      schema: deprecateRationaleToolInputSchema.shape,
      outputSchema: jsonOutputSchema,
      annotations: writeToolAnnotations,
      metadata: toolInvocationMetadata("낡은 메모 정리하는 중..", "메모 정리 완료!"),
      handler: async (input: unknown) => {
        const parsedInput = deprecateRationaleToolInputSchema.parse(input);
        // 응답은 ok만: 대상 id와 사유는 호출자 입력 에코라 싣지 않는다.
        return jsonToolResult(parsedInput.restore
          ? await services.rationaleService.restoreRationaleFromRevision(parsedInput)
          : await services.rationaleService.deprecateRationaleFromRevision(parsedInput));
      }
    },
    {
      name: "rate_memory",
      description: "Rate a rationale memory after acting on retrieved context, using the revision id shown by compose_context or search_rationales. Call it once per memory you actually weighed: \"applied\" if it shaped your answer or work, \"dismissed\" if it was retrieved but not useful this time, \"user_helpful\"/\"user_unhelpful\" only when the user explicitly reacted to an outcome the memory influenced.",
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
    .describe("Current repo. Boosts memories captured in the same project; other projects are never penalized.")
});

const composeInputSchema = z.object({
  task: z.string()
    .min(1)
    .describe("Retrieval query, not an instruction to an agent: 1-3 Korean sentences stating the topic with its key entities and terms; keep code identifiers and proper nouns unchanged. Questions, requests for judgment, and long narratives degrade matching."),
  project: searchProjectFilterSchema.optional()
    .describe("Current repo. Boosts memories captured in the same project; other projects are never penalized.")
});

const continueInputSchema = z.object({
  cursor: z.string().min(1)
});

const deprecateRationaleToolInputSchema = z.object({
  id: deprecateRationaleInputSchema.shape.id
    .describe("Any revision snapshot id of the memory to retire."),
  reason: deprecateRationaleInputSchema.shape.reason
    .describe("Why the memory no longer holds (or why it is being restored), in Korean; keep code identifiers and proper nouns unchanged."),
  replacementId: deprecateRationaleInputSchema.shape.replacementId
    .describe("Revision id of the memory that supersedes this one, when it exists; links the decision chain for later readers."),
  restore: deprecateRationaleInputSchema.shape.restore
    .describe("Set true to undo a mistaken deprecation; the memory returns to its pre-deprecation state.")
});

const recordNoteToolInputSchema = z.object({
  content: recordNoteInputSchema.shape.content
    .describe("Lightweight note in Korean; keep code identifiers and proper nouns unchanged, and write Korean as literal characters — never hand-transcribe it into \\uXXXX escapes. When stating a judgment or trait about the user, attach the observed grounds (mechanism → conclusion, e.g. \"남에게 줄 영향을 고민하는 편이다. 그래서 메타인지가 뛰어나다\"), never a bare label — fragmentary conclusions without their reasons cannot be re-verified against later observations. Mark your own inferences as such, distinct from the user's direct statements."),
  // topic은 항상 필수. digest 합성이 노트를 묶는 그룹 라벨이라 폴더명처럼 짧고 구체적으로 짓게 유도한다.
  topic: noteTopicSchema
    .describe("Required. Short Korean label for what this note is about, like a folder name — specific but not a full sentence (e.g. '발주GAP 하위호환 검증')."),
  // sourceContext는 대화에서 파생된 노트의 출처(원문 메시지)만 담는다. standalone 노트에선 생략한다.
  sourceContext: z.object({
    messages: noteSourceConversationSchema.shape.messages
      .describe("One to four relevant messages preserving their original language, speaker roles, text, and order.")
  })
    .optional()
    .describe("Conversation provenance for notes derived from a conversation; omit for standalone notes.")
});

const autoCaptureRationaleToolInputSchema = z.object({
  title: autoCaptureRationaleInputSchema.shape.title
    .describe("Concise rationale title in Korean; keep code identifiers and proper nouns unchanged."),
  body: autoCaptureRationaleInputSchema.shape.body
    .describe("Self-contained Markdown body in Korean; keep code identifiers and proper nouns unchanged. Write Korean as literal characters — never hand-transcribe it into \\uXXXX escapes."),
  project: searchProjectFilterSchema.optional()
    .describe("Current repo, stored as the memory's project context.")
});

const updateRationaleToolInputSchema = z.object({
  id: updateRationaleInputSchema.shape.id,
  reason: updateRationaleInputSchema.shape.reason
    .describe("Reason for the update in Korean; keep code identifiers and proper nouns unchanged."),
  title: updateRationaleInputSchema.shape.title
    .describe("Complete replacement title in Korean; keep code identifiers and proper nouns unchanged."),
  body: updateRationaleInputSchema.shape.body
    .describe("Complete replacement Markdown body in Korean; keep code identifiers and proper nouns unchanged. Write Korean as literal characters — never hand-transcribe it into \\uXXXX escapes.")
});

const rateMemoryToolInputSchema = z.object({
  id: recordUsageFeedbackInputSchema.shape.id,
  eventType: recordUsageFeedbackInputSchema.shape.eventType
});

function toRecordNoteInput(input: z.infer<typeof recordNoteToolInputSchema>) {
  return {
    content: input.content,
    topic: input.topic,
    sourceConversation: input.sourceContext
      ? { messages: input.sourceContext.messages }
      : undefined
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
    updatedAt?: string;
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
  updatedAt?: string;
}) {
  const revisionId = readCurrentRevisionId(entry);
  const response: {
    id: string;
    title: string;
    type: string;
    updatedAt?: string;
    summary?: string;
  } = {
    id: revisionId,
    title: entry.title,
    type: entry.type
  };

  if (entry.updatedAt) {
    response.updatedAt = entry.updatedAt.slice(0, 10);
  }
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
        throw translateUnicodeStorageError(error);
      }
    }
  };
}

// zod 방어를 뚫고 DB(jsonb)까지 간 깨진 유니코드는 사고 시점에 재시도 지침으로 변환한다 —
// 상시 설명보다 in-context 안내가 소비자 LLM의 행동을 바꾼다(feedbackFooter 전례).
function translateUnicodeStorageError(error: unknown) {
  if (!(error instanceof Error)) {
    return error;
  }
  const errorCode = (error as { code?: unknown }).code;
  const combinedText = `${error.message} ${(error as { detail?: unknown }).detail ?? ""}`;
  const isUnicodeJsonbFailure = errorCode === "22P02" && /surrogate|unicode|\\u0000/i.test(combinedText);
  if (!isUnicodeJsonbFailure) {
    return error;
  }
  return new Error(
    `${error.message} — the input reached storage with broken Unicode. Do not hand-transcribe Korean into \\uXXXX escapes; resend the text as literal characters.`
  );
}

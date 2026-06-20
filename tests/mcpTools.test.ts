import { describe, expect, it } from "vitest";
import { toolDefinitions, type ToolDefinition, type ToolServices } from "../src/mcp/tools.js";
import type { NoteRecord, RationaleEntry } from "../src/memory/schema.js";

const unusedServiceMethod = async () => {
  throw new Error("Unexpected service method call.");
};

describe("MCP write tool results", () => {
  it("exposes the intended compact MCP tool set", () => {
    const services = createToolServices();

    expect(toolDefinitions(services).map((toolDefinition) => toolDefinition.name)).toEqual([
      "search_rationales",
      "get_rationale",
      "compose_context",
      "continue_context",
      "record_note",
      "rate_note",
      "compose_notes_context",
      "auto_capture_rationale",
      "record_refinement_opinion",
      "record_usage_feedback"
    ]);
  });

  it("adds customized ChatGPT invocation status metadata to every tool", () => {
    const services = createToolServices();
    const expectedStatuses = new Map([
      ["auto_capture_rationale", ["메모 작성 중..", "메모 완료!"]],
      ["compose_context", ["메모 훑어보는 중..", "메모 훑어보기 완료!"]],
      ["compose_notes_context", ["쪽지 꺼내는 중..", "쪽지 꺼냇어요!"]],
      ["continue_context", ["계속해서 훑어보는 중..", "추가 확인 완료!"]],
      ["get_rationale", ["특정 메모 확인하는 중..", "메모 확인 완료!"]],
      ["rate_note", ["쪽지 평가 중..", "쪽지 평가 완료!"]],
      ["record_refinement_opinion", ["메모에 의견 붙이는 중..", "의견 붙이기 완료!"]],
      ["record_note", ["쪽지 적는 중..", "쪽지 적엇어요!"]],
      ["record_usage_feedback", ["메모를 평가하는 중..", "평가 완료!"]],
      ["search_rationales", ["괜찮은 메모가 있나 찾아보는 중..", "찾아보기 완료!"]]
    ]);

    for (const toolDefinition of toolDefinitions(services)) {
      const invoking = toolDefinition.metadata["openai/toolInvocation/invoking"];
      const invoked = toolDefinition.metadata["openai/toolInvocation/invoked"];
      const expectedStatus = expectedStatuses.get(toolDefinition.name);

      expect(expectedStatus).toBeDefined();
      expect([invoking, invoked]).toEqual(expectedStatus);
      expect(typeof invoking).toBe("string");
      expect(typeof invoked).toBe("string");
      expect(String(invoking).length).toBeLessThanOrEqual(64);
      expect(String(invoked).length).toBeLessThanOrEqual(64);
    }
  });

  it("adds planning annotations and output schemas to every tool", () => {
    const services = createToolServices();
    const readOnlyTools = new Set([
      "search_rationales",
      "get_rationale",
      "compose_context",
      "compose_notes_context",
      "continue_context"
    ]);

    for (const toolDefinition of toolDefinitions(services)) {
      expect(toolDefinition.annotations).toEqual({
        readOnlyHint: readOnlyTools.has(toolDefinition.name),
        destructiveHint: false,
        openWorldHint: false
      });
      expect(toolDefinition.outputSchema).not.toEqual({});
    }
  });

  it("returns compact success metadata for auto-captured rationales", async () => {
    const services = createToolServices();
    const result = await getTool(services, "auto_capture_rationale").handler({
      title: "Keep write responses compact",
      rationale: "Tool responses are fed back into the model context.",
      captureReason: "This decision avoids context bloat.",
      reuseWhen: ["A write tool only needs to acknowledge success."],
      avoidWhen: ["The caller explicitly needs the full entry."]
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      id: "R20260604T000000000Z-compact"
    });
    expect(payload).not.toHaveProperty("canonicalPath");
    expect(payload).not.toHaveProperty("entry");
  });

  it("returns existing rationale ids for duplicate auto-capture results", async () => {
    const services = createToolServices();
    services.rationaleService.autoCaptureRationale = async () => ({
      id: "R20260604T000000000Z-existing",
      canonicalPath: "/memory/R20260604T000000000Z-existing.md",
      status: "duplicate",
      existingId: "R20260604T000000000Z-existing"
    });

    const result = await getTool(services, "auto_capture_rationale").handler({
      title: "Keep duplicate responses compact",
      rationale: "The caller only needs the existing id to verify duplicate content.",
      captureReason: "Duplicate capture should not return the full entry.",
      reuseWhen: ["A matching rationale already exists."],
      avoidWhen: ["The content is distinct."]
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      id: "R20260604T000000000Z-existing",
      status: "duplicate"
    });
    expect(payload).not.toHaveProperty("canonicalPath");
    expect(payload).not.toHaveProperty("existingId");
    expect(payload).not.toHaveProperty("entry");
  });

  it("returns compact success metadata for refinement opinions", async () => {
    const services = createToolServices();
    const result = await getTool(services, "record_refinement_opinion").handler({
      entryId: "R20260604T000000000Z-compact",
      body: "Mention why the result is intentionally compact.",
      suggestedPatch: {
        rationale: "Shorter MCP write responses reduce context pressure."
      }
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      id: "opinion-1"
    });
    expect(payload).not.toHaveProperty("entryId");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("suggestedPatch");
  });

  it("returns compact success metadata for notes", async () => {
    const services = createToolServices();
    const result = await getTool(services, "record_note").handler({
      content: "쭈인님은 노트 원문을 다시 도구 응답에 싣지 않길 원한다."
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      id: "N20260604T000000000Z-compact"
    });
    expect(payload).not.toHaveProperty("upvotes");
    expect(payload).not.toHaveProperty("downvotes");
    expect(payload).not.toHaveProperty("archived");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("updatedAt");
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("topic");
    expect(payload).not.toHaveProperty("sourceConversation");
  });

  it("returns compact success metadata for note ratings", async () => {
    const services = createToolServices();
    const result = await getTool(services, "rate_note").handler({
      noteId: "N20260604T000000000Z-compact",
      rating: "up"
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      id: "N20260604T000000000Z-compact"
    });
    expect(payload).not.toHaveProperty("upvotes");
    expect(payload).not.toHaveProperty("downvotes");
    expect(payload).not.toHaveProperty("updatedAt");
  });

  it("returns compact success metadata for usage feedback", async () => {
    const services = createToolServices();
    const result = await getTool(services, "record_usage_feedback").handler({
      entryId: "R20260604T000000000Z-compact",
      eventType: "user_helpful"
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      entryId: "R20260604T000000000Z-compact",
      eventType: "user_helpful"
    });
    expect(payload).not.toHaveProperty("useCount");
    expect(payload).not.toHaveProperty("lastUsedAt");
  });
});

function createToolServices(): ToolServices {
  const recordedEntry = createRationaleEntry("R20260604T000000000Z-compact", "Keep write responses compact");

  return {
    rationaleService: {
      searchWithDiagnostics: unusedServiceMethod,
      getRationale: unusedServiceMethod,
      autoCaptureRationale: async () => ({
        id: recordedEntry.frontmatter.id,
        canonicalPath: "/memory/R20260604T000000000Z-compact.md",
        entry: recordedEntry
      }),
      recordRefinementOpinion: async () => ({
        id: "opinion-1",
        entryId: recordedEntry.frontmatter.id,
        opinionType: "patch_request",
        status: "open",
        body: "Mention why the result is intentionally compact.",
        suggestedPatch: {
          rationale: "Shorter MCP write responses reduce context pressure."
        },
        sourceKind: "llm_opinion",
        metadata: {},
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z"
      }),
      recordUsageFeedback: async () => ({
        entryId: recordedEntry.frontmatter.id,
        eventType: "user_helpful",
        useCount: 1,
        lastUsedAt: "2026-06-04T00:00:00.000Z"
      })
    },
    contextComposer: {
      compose: unusedServiceMethod,
      continueContext: unusedServiceMethod
    },
    noteService: {
      recordNote: async () => createNoteRecord(),
      rateNote: async () => ({
        ...createNoteRecord(),
        upvotes: 1,
        updatedAt: "2026-06-04T00:01:00.000Z"
      }),
      composeNotesContext: async () => "Compact note context."
    }
  };
}

function createRationaleEntry(id: string, title: string): RationaleEntry {
  return {
    frontmatter: {
      id,
      type: "rationale",
      status: "candidate",
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      decisionState: "unknown",
      scope: "general",
      domains: [],
      intents: [],
      modes: [],
      confidence: 0.5,
      metadata: {}
    },
    title,
    rationale: "Full rationale body should not be returned by write tools.",
    constraints: [],
    rejectedAlternatives: [],
    reuseWhen: [],
    avoidWhen: [],
    rawMarkdown: ""
  };
}

function createNoteRecord(): NoteRecord {
  return {
    id: "N20260604T000000000Z-compact",
    content: "Full note body should not be returned by write tools.",
    topic: "Hidden note source context",
    sourceConversation: {
      messages: [
        { role: "user", text: "This should not be returned." },
        { role: "assistant", text: "Keep write responses compact." }
      ]
    },
    upvotes: 0,
    downvotes: 0,
    archived: false,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z"
  };
}

function getTool(services: ToolServices, name: string): ToolDefinition {
  const definition = toolDefinitions(services).find((toolDefinition) => toolDefinition.name === name);
  if (!definition) {
    throw new Error(`Tool not found: ${name}`);
  }
  return definition;
}

function parseToolJson(result: Awaited<ReturnType<ToolDefinition["handler"]>>) {
  expect(result.structuredContent).toBeDefined();
  const [firstContent] = result.content;
  if (!firstContent) {
    throw new Error("Tool result did not include content.");
  }
  return JSON.parse(firstContent.text);
}

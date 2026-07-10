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
      "update_rationale",
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
      ["record_note", ["쪽지 적는 중..", "쪽지 적엇어요!"]],
      ["record_usage_feedback", ["메모를 평가하는 중..", "평가 완료!"]],
      ["search_rationales", ["괜찮은 메모가 있나 찾아보는 중..", "찾아보기 완료!"]],
      ["update_rationale", ["메모 수정 중..", "메모 수정 완료!"]]
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

  it("keeps public tool inputs minimal", () => {
    const services = createToolServices();

    expect(Object.keys(getTool(services, "search_rationales").schema)).toEqual(["query", "project"]);
    expect(Object.keys(getTool(services, "compose_context").schema)).toEqual(["task", "project"]);
    expect(Object.keys(getTool(services, "continue_context").schema)).toEqual(["cursor"]);
    expect(Object.keys(getTool(services, "record_note").schema)).toEqual(["content", "sourceContext"]);
    expect(Object.keys(getTool(services, "auto_capture_rationale").schema)).toEqual(["title", "body", "type", "project"]);
    expect(Object.keys(getTool(services, "update_rationale").schema)).toEqual(["revisionId", "reason", "title", "body"]);
    expect(Object.keys(getTool(services, "record_usage_feedback").schema)).toEqual(["entryId", "eventType"]);
    expect(getRequiredInputKeys(getTool(services, "record_note"))).toEqual(["content"]);
    expect(getRequiredInputKeys(getTool(services, "auto_capture_rationale"))).toEqual(["title", "body"]);
    expect(getRequiredInputKeys(getTool(services, "update_rationale"))).toEqual(["revisionId", "reason", "title", "body"]);
    expect(getRequiredInputKeys(getTool(services, "record_usage_feedback"))).toEqual(["entryId", "eventType"]);
  });

  it("explains when note conversation provenance should be captured", () => {
    const recordNoteTool = getTool(createToolServices(), "record_note");

    expect(recordNoteTool.description).toContain("current conversation");
    expect(recordNoteTool.description).toContain("original roles, text, and order");
    expect(recordNoteTool.schema.content.description).toBe("The lightweight note to remember.");
    expect(recordNoteTool.schema.sourceContext.description).toContain("Conversation provenance");
  });

  it("returns compact search results without internal ranking or storage metadata", async () => {
    const services = createToolServices();
    services.rationaleService.searchWithDiagnostics = async () => ({
      results: [{
        id: "R20260604T000000000Z-search",
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        title: "Keep search responses compact",
        summary: "Search callers only need enough detail to choose a follow-up read.",
        canonicalPath: "/memory/R20260604T000000000Z-search.md",
        scope: "general",
        sourceKind: "session",
        sourceRef: "test",
        confidence: 0.5,
        useCount: 3,
        metadata: { domains: ["development"] },
        lexicalRank: 1,
        vectorScore: 0.8,
        searchScore: 4.2,
        searchReasons: ["vector:0.800:+4.00"]
      }],
      warnings: [{
        kind: "vector_search_failed",
        severity: "warning",
        message: "Vector search failed; returning lexical fallback results.",
        details: { provider: "mock" }
      }]
    });

    const result = await getTool(services, "search_rationales").handler({
      query: "compact search result"
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      results: [{
        id: "R20260604T000000000Z-search",
        title: "Keep search responses compact",
        type: "rationale",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        summary: "Search callers only need enough detail to choose a follow-up read."
      }],
      warnings: [{
        kind: "vector_search_failed",
        severity: "warning",
        message: "Vector search failed; returning lexical fallback results."
      }]
    });
    expect(payload.results[0]).not.toHaveProperty("canonicalPath");
    expect(payload.results[0]).not.toHaveProperty("metadata");
    expect(payload.results[0]).not.toHaveProperty("searchScore");
    expect(payload.results[0]).not.toHaveProperty("searchReasons");
    expect(payload.results[0]).not.toHaveProperty("refinementOpinions");
    expect(payload.warnings[0]).not.toHaveProperty("details");
  });

  it("returns compact success metadata for auto-captured rationales", async () => {
    const services = createToolServices();
    const result = await getTool(services, "auto_capture_rationale").handler({
      title: "Keep write responses compact",
      body: "Tool responses are fed back into the model context."
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
      body: "The caller only needs the existing id to verify duplicate content."
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

  it("returns compact success metadata for rationale updates", async () => {
    const services = createToolServices();
    const result = await getTool(services, "update_rationale").handler({
      revisionId: "V20260604T000000000Z-base",
      reason: "Keep the rationale concise.",
      title: "Keep write responses compact",
      body: "Shorter MCP write responses reduce context pressure."
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      revisionId: "V20260604T000000000Z-next"
    });
    expect(payload).not.toHaveProperty("entry");
  });

  it("returns latest revision ids for rationale update conflicts", async () => {
    const services = createToolServices();
    services.rationaleService.updateRationaleFromRevision = async () => ({
      ok: false as const,
      latestRevisionId: "V20260604T000000000Z-latest"
    });

    const result = await getTool(services, "update_rationale").handler({
      revisionId: "V20260604T000000000Z-stale",
      reason: "Keep the rationale concise.",
      title: "Keep write responses compact",
      body: "Shorter MCP write responses reduce context pressure."
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: false,
      latestRevisionId: "V20260604T000000000Z-latest"
    });
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

  it("groups note provenance into one public source context", async () => {
    const services = createToolServices();
    let recordedInput: unknown;
    services.noteService.recordNote = async (input) => {
      recordedInput = input;
      return createNoteRecord();
    };

    await getTool(services, "record_note").handler({
      content: "Keep the source context compact.",
      sourceContext: {
        topic: "MCP schema design",
        messages: [{ role: "user", text: "Group related provenance." }]
      }
    });

    expect(recordedInput).toEqual({
      content: "Keep the source context compact.",
      topic: "MCP schema design",
      sourceConversation: {
        messages: [{ role: "user", text: "Group related provenance." }]
      }
    });
  });

  it("returns slot-scoped success metadata for note ratings", async () => {
    const services = createToolServices();
    const result = await getTool(services, "rate_note").handler({
      slot: "a3",
      rating: "up"
    });

    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.slot).toBe("a3");
    expect(payload.rating).toBe("up");
    expect(typeof payload.feedback).toBe("string");
    // 긴 노트 원문 id는 응답에 노출하지 않는다(슬롯만으로 충분).
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("content");
  });

  it("returns a 410 expiry result instead of throwing when the slot is gone", async () => {
    const services = createToolServices();
    services.noteService.rateNote = async () => ({
      ok: false as const,
      httpStatus: 410,
      reason: "앗.. 그 쪽지는 이미 날아가버렷어요! 쪽지를 다시 꺼낸 다음 평가해 주세요"
    });

    const result = await getTool(services, "rate_note").handler({
      slot: "zz",
      rating: "up"
    });

    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(payload.httpStatus).toBe(410);
    expect(typeof payload.reason).toBe("string");
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
      getMemoryEntryRecord: async () => ({
        id: recordedEntry.frontmatter.id,
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        title: recordedEntry.title,
        canonicalPath: "/memory/R20260604T000000000Z-compact.md",
        currentRevisionId: "V20260604T000000000Z-current",
        scope: "general",
        confidence: 0.5,
        useCount: 0,
        metadata: {}
      }),
      updateRationaleFromRevision: async () => ({
        ok: true as const,
        revisionId: "V20260604T000000000Z-next"
      }),
      autoCaptureRationale: async () => ({
        id: recordedEntry.frontmatter.id,
        canonicalPath: "/memory/R20260604T000000000Z-compact.md",
        entry: recordedEntry
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
      rateNote: async (input: unknown) => {
        const { slot, rating } = input as { slot: string; rating: "up" | "down" };
        return {
          ok: true as const,
          slot,
          rating,
          upvotes: rating === "up" ? 1 : 0,
          downvotes: rating === "down" ? 1 : 0,
          feedback: "추천 도장 쾅! 좋은 쪽지로 기억해 둘게요 ✨"
        };
      },
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
    body: "Full rationale body should not be returned by write tools.",
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

function getRequiredInputKeys(definition: ToolDefinition) {
  return Object.entries(definition.schema)
    .filter(([, schema]) => !schema.isOptional())
    .map(([key]) => key);
}

function parseToolJson(result: Awaited<ReturnType<ToolDefinition["handler"]>>) {
  expect(result.structuredContent).toBeDefined();
  const [firstContent] = result.content;
  if (!firstContent) {
    throw new Error("Tool result did not include content.");
  }
  return JSON.parse(firstContent.text);
}

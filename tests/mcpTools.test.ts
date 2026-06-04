import { describe, expect, it } from "vitest";
import { toolDefinitions, type ToolDefinition, type ToolServices } from "../src/mcp/tools.js";
import type { RationaleEntry } from "../src/memory/schema.js";

const unusedServiceMethod = async () => {
  throw new Error("Unexpected service method call.");
};

describe("MCP write tool results", () => {
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
      id: "R20260604T000000000Z-compact",
      canonicalPath: "/memory/R20260604T000000000Z-compact.md"
    });
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
      id: "opinion-1",
      entryId: "R20260604T000000000Z-compact",
      status: "open"
    });
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("suggestedPatch");
  });

  it("returns count and ids for bulk session ingestion", async () => {
    const services = createToolServices();
    const result = await getTool(services, "ingest_session_candidates").handler({
      sessionRef: "session-1",
      candidates: [
        {
          title: "First rationale",
          rationale: "The first candidate has enough reusable context."
        },
        {
          title: "Second rationale",
          rationale: "The second candidate has enough reusable context."
        }
      ]
    });

    const payload = parseToolJson(result);

    expect(payload).toEqual({
      ok: true,
      count: 2,
      ids: ["R20260604T000000000Z-bulk-1", "R20260604T000000000Z-bulk-2"]
    });
    expect(payload).not.toHaveProperty("entries");
  });
});

function createToolServices(): ToolServices {
  const recordedEntry = createRationaleEntry("R20260604T000000000Z-compact", "Keep write responses compact");
  let recordCandidateCount = 0;

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
      }),
      reindexMemory: async () => 3,
      recordCandidate: async () => {
        recordCandidateCount += 1;
        const id = `R20260604T000000000Z-bulk-${recordCandidateCount}`;
        return {
          id,
          canonicalPath: `/memory/${id}.md`,
          entry: createRationaleEntry(id, `Bulk rationale ${recordCandidateCount}`)
        };
      }
    },
    contextComposer: {
      compose: unusedServiceMethod,
      continueContext: unusedServiceMethod
    },
    statusService: {
      status: unusedServiceMethod
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

function getTool(services: ToolServices, name: string): ToolDefinition {
  const definition = toolDefinitions(services).find((toolDefinition) => toolDefinition.name === name);
  if (!definition) {
    throw new Error(`Tool not found: ${name}`);
  }
  return definition;
}

function parseToolJson(result: Awaited<ReturnType<ToolDefinition["handler"]>>) {
  const [firstContent] = result.content;
  if (!firstContent) {
    throw new Error("Tool result did not include content.");
  }
  return JSON.parse(firstContent.text);
}

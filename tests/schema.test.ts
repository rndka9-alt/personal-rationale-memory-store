import { describe, expect, it } from "vitest";
import {
  autoCaptureRationaleInputSchema,
  composeNotesContextInputSchema,
  memoryUsageEventTypeSchema,
  rateNoteInputSchema,
  recordRefinementOpinionInputSchema,
  recordNoteInputSchema,
  recordUsageFeedbackInputSchema,
  rationaleEntrySchema
} from "../src/memory/schema.js";

describe("rationaleEntrySchema", () => {
  it("requires rationale-centered content", () => {
    const entry = rationaleEntrySchema.parse({
      frontmatter: {
        id: "R2026-04-30-001",
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        scope: "general",
        domains: ["development"],
        intents: ["design"],
        modes: ["planning"],
        confidence: 0.8,
        project: {
          name: "personal-rationale-memory-store",
          repo: "maetdol/personal-rationale-memory-store"
        },
        metadata: {}
      },
      title: "Prefer rationale over bare decisions",
      rationale: "The reusable reason matters more than the final decision."
    });

    expect(entry.frontmatter.id).toBe("R2026-04-30-001");
    expect(entry.frontmatter.project?.name).toBe("personal-rationale-memory-store");
    expect(entry.frontmatter.acceptanceState).toBe("candidate");
    expect(entry.frontmatter.reviewState).toBe("unreviewed");
    expect(entry.frontmatter.decisionState).toBe("unknown");
    expect(entry.constraints).toEqual([]);
  });
});

describe("autoCaptureRationaleInputSchema", () => {
  it("accepts quick captures with only title and rationale", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Capture reusable rationale",
      rationale: "Boundary fields can be backfilled during review."
    });

    expect(input.reuseWhen).toBeUndefined();
    expect(input.avoidWhen).toBeUndefined();
    expect(input.captureReason).toBeUndefined();
  });

  it("still requires a rationale body", () => {
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture without rationale"
    })).toThrow();
  });

  it("accepts agent-assignable memory types and rejects principle and note", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Prefer fail-fast over silent fallback",
      rationale: "Silent fallbacks hide corrupted data until it is expensive to repair.",
      type: "preference"
    });

    expect(input.type).toBe("preference");
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Promote to principle directly",
      rationale: "Principles must come from promoting accepted rationale.",
      type: "principle"
    })).toThrow();
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Remember a small personal detail",
      rationale: "Notes belong in the plain note surface, not rationale memory.",
      type: "note"
    })).toThrow();
  });

  it("keeps boundary fields when provided", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Capture reusable rationale",
      rationale: "This rationale includes enough boundary information to be queued safely.",
      captureReason: "The decision pattern is likely reusable.",
      reuseWhen: ["A similar constrained decision appears."],
      avoidWhen: ["The future task is unrelated."]
    });

    expect(input.reuseWhen).toHaveLength(1);
    expect(input.avoidWhen).toHaveLength(1);
  });
});

describe("memoryUsageEventTypeSchema", () => {
  it("accepts composed usage and rejects unknown event types", () => {
    expect(memoryUsageEventTypeSchema.parse("composed")).toBe("composed");
    expect(() => memoryUsageEventTypeSchema.parse("previewed")).toThrow();
  });
});

describe("recordRefinementOpinionInputSchema", () => {
  it("defaults opinion type and bounds body length", () => {
    const opinion = recordRefinementOpinionInputSchema.parse({
      entryId: "R2026-05-19-001",
      body: "This memory should mention the operational caveat before reuse."
    });

    expect(opinion.opinionType).toBe("opinion");
    expect(() => recordRefinementOpinionInputSchema.parse({
      entryId: "R2026-05-19-001",
      body: "x".repeat(2001)
    })).toThrow();
  });
});

describe("recordUsageFeedbackInputSchema", () => {
  it("accepts explicit feedback events and rejects passive retrieval events", () => {
    const feedback = recordUsageFeedbackInputSchema.parse({
      entryId: "R2026-05-19-001",
      eventType: "user_helpful",
      task: "Use memory in implementation"
    });

    expect(feedback.eventType).toBe("user_helpful");
    expect(() => recordUsageFeedbackInputSchema.parse({
      entryId: "R2026-05-19-001",
      eventType: "composed"
    })).toThrow();
  });
});

describe("note input schemas", () => {
  it("accepts notes with optional source context and rejects blank or overlong content", () => {
    const input = recordNoteInputSchema.parse({
      content: "쭈인님은 노트 원문을 요약 없이 보관하길 원한다.",
      topic: "노트 provenance 설계",
      sourceConversation: {
        messages: [
          { role: "user", text: "노트가 꽤 재밌게 저장되더라구..." },
          { role: "assistant", text: "그때 분위기를 보는 쪽이 좋겟어요." }
        ]
      }
    });

    expect(input.content).toContain("요약 없이");
    expect(input.topic).toBe("노트 provenance 설계");
    expect(input.sourceConversation?.messages[0]?.role).toBe("user");
    expect(() => recordNoteInputSchema.parse({ content: "   " })).toThrow();
    expect(() => recordNoteInputSchema.parse({ content: "x".repeat(1001) })).toThrow();
    expect(() => recordNoteInputSchema.parse({
      content: "invalid role",
      sourceConversation: { messages: [{ role: "system", text: "hidden" }] }
    })).toThrow();
  });

  it("accepts bounded note compose budgets and rating values", () => {
    expect(composeNotesContextInputSchema.parse({ maxLength: 5000 }).maxLength).toBe(5000);
    expect(rateNoteInputSchema.parse({ noteId: "N1", rating: "up" }).rating).toBe("up");
    expect(() => rateNoteInputSchema.parse({ noteId: "N1", rating: "sideways" })).toThrow();
  });
});

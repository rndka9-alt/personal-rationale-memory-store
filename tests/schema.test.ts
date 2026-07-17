import { describe, expect, it } from "vitest";
import {
  autoCaptureRationaleInputSchema,
  memoryUsageEventTypeSchema,
  rateNoteInputSchema,
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
      body: "The reusable reason matters more than the final decision."
    });

    expect(entry.frontmatter.id).toBe("R2026-04-30-001");
    expect(entry.frontmatter.project?.name).toBe("personal-rationale-memory-store");
    expect(entry.frontmatter.acceptanceState).toBe("candidate");
    expect(entry.frontmatter.reviewState).toBe("unreviewed");
    expect(entry.frontmatter.decisionState).toBe("unknown");
    expect(entry.body).toContain("reusable reason");
  });
});

describe("autoCaptureRationaleInputSchema", () => {
  it("accepts captures with a title and body", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Capture reusable rationale",
      body: "Boundary information belongs in the document body when it matters."
    });

    expect(input.body).toContain("document body");
  });

  it("requires a non-blank body", () => {
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture without body"
    })).toThrow();
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture blank body",
      body: "   "
    })).toThrow();
  });

  it("does not accept a caller-assigned memory type", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Prefer fail-fast over silent fallback",
      body: "Silent fallbacks hide corrupted data until it is expensive to repair.",
      type: "preference"
    });

    expect(input).not.toHaveProperty("type");
  });
});

describe("memoryUsageEventTypeSchema", () => {
  it("accepts composed usage and rejects unknown event types", () => {
    expect(memoryUsageEventTypeSchema.parse("composed")).toBe("composed");
    expect(() => memoryUsageEventTypeSchema.parse("previewed")).toThrow();
  });
});

describe("recordUsageFeedbackInputSchema", () => {
  it("accepts explicit feedback events and rejects passive retrieval events", () => {
    const feedback = recordUsageFeedbackInputSchema.parse({
      id: "V2026-05-19-001",
      eventType: "user_helpful"
    });

    expect(feedback.eventType).toBe("user_helpful");
    expect(() => recordUsageFeedbackInputSchema.parse({
      id: "V2026-05-19-001",
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
      topic: "역할 검증",
      sourceConversation: { messages: [{ role: "system", text: "hidden" }] }
    })).toThrow();
    // topic이 필수가 됐음을 확인: content만으로는 통과하지 못한다.
    expect(() => recordNoteInputSchema.parse({ content: "topic 없이 기록" })).toThrow();
  });

  it("accepts note rating values", () => {
    expect(rateNoteInputSchema.parse({ slot: "a3", rating: "up" }).rating).toBe("up");
    expect(() => rateNoteInputSchema.parse({ slot: "a3", rating: "sideways" })).toThrow();
  });
});

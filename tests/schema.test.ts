import { describe, expect, it } from "vitest";
import {
  autoCaptureRationaleInputSchema,
  memoryUsageEventTypeSchema,
  recordRefinementOpinionInputSchema,
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

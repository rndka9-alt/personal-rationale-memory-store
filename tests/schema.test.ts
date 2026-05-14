import { describe, expect, it } from "vitest";
import { autoCaptureRationaleInputSchema, rationaleEntrySchema } from "../src/memory/schema.js";

describe("rationaleEntrySchema", () => {
  it("requires rationale-centered content", () => {
    const entry = rationaleEntrySchema.parse({
      frontmatter: {
        id: "R2026-04-30-001",
        type: "rationale",
        status: "candidate",
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
    expect(entry.constraints).toEqual([]);
  });
});

describe("autoCaptureRationaleInputSchema", () => {
  it("requires reuse and avoid boundaries for autonomous capture", () => {
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture reusable rationale",
      rationale: "This should not be auto-captured without boundaries.",
      captureReason: "It may be useful later.",
      reuseWhen: [],
      avoidWhen: []
    })).toThrow();

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

import { describe, expect, it } from "vitest";
import { findMissingSections } from "../src/memory/rationaleService.js";
import { rationaleEntrySchema } from "../src/memory/schema.js";

function minimalEntryOfType(type: string) {
  return rationaleEntrySchema.parse({
    frontmatter: {
      id: "R-test-type-001",
      type
    },
    title: "Minimal entry",
    rationale: "Body only."
  });
}

describe("findMissingSections", () => {
  it("flags decision-shaped sections for rationale entries", () => {
    const missingSections = findMissingSections(minimalEntryOfType("rationale"));

    expect(missingSections).toContain("decision");
    expect(missingSections).toContain("rejectedAlternatives");
    expect(missingSections).toContain("tradeoff");
    expect(missingSections).toContain("constraints");
  });

  it("does not flag decision-shaped sections for non-decision types", () => {
    const missingSections = findMissingSections(minimalEntryOfType("preference"));

    expect(missingSections).not.toContain("decision");
    expect(missingSections).not.toContain("rejectedAlternatives");
    expect(missingSections).not.toContain("tradeoff");
    expect(missingSections).not.toContain("constraints");
    expect(missingSections).toContain("reuseWhen");
    expect(missingSections).toContain("avoidWhen");
  });
});

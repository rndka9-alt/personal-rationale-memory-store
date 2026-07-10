import { describe, expect, it } from "vitest";
import { reviewCandidateEntry } from "../src/memory/rationaleService.js";
import { rationaleEntrySchema } from "../src/memory/schema.js";

function entryWithBody(body: string) {
  return rationaleEntrySchema.parse({
    frontmatter: {
      id: "R-test-type-001",
      type: "rationale",
      domains: ["development"],
      intents: ["review"],
      modes: ["planning"]
    },
    title: "Minimal entry",
    body
  });
}

describe("reviewCandidateEntry", () => {
  it("flags a short body without requiring fixed sections", () => {
    const review = reviewCandidateEntry(entryWithBody("Body only."));

    expect(review.cautions).toContain("body is short");
    expect(review.strengths).toEqual([]);
  });

  it("recognizes a substantive free-form body", () => {
    const review = reviewCandidateEntry(entryWithBody(
      "A reusable memory can explain its context, decision, constraints, and tradeoffs naturally without storing each idea in a separate field. ".repeat(2)
    ));

    expect(review.strengths).toContain("substantive body");
    expect(review.cautions).not.toContain("body is short");
  });
});

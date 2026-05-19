import { describe, expect, it } from "vitest";
import { inferRationaleTags } from "../src/memory/rationaleService.js";

describe("inferRationaleTags", () => {
  it("infers lifecycle-search tags from rationale content", () => {
    const tags = inferRationaleTags({
      title: "Implement Docker compose memory retrieval repair",
      situation: "The rationale memory index needs tag repair before retrieval quality can improve.",
      goal: "Backfill domains, intents, and modes for old memory files.",
      constraints: ["Keep canonical Markdown as the source of truth."],
      decision: "Use a repair reindex scope instead of silently mutating files in the background.",
      rationale: "Memory retrieval works better when rationale records carry ontology tags.",
      reuseWhen: ["A memory-system implementation task needs tag inference."],
      avoidWhen: ["The task is unrelated to rationale memory."]
    });

    expect(tags.domains).toContain("memory-system");
    expect(tags.domains).toContain("operations");
    expect(tags.intents).toContain("design");
    expect(tags.modes).toContain("coding");
  });
});

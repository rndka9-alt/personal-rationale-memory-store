import { describe, expect, it } from "vitest";
import { inferRationaleTags } from "../src/memory/rationaleService.js";

describe("inferRationaleTags", () => {
  it("infers lifecycle-search tags from rationale content", () => {
    const tags = inferRationaleTags({
      title: "Implement Docker compose memory retrieval repair",
      body: [
        "The rationale memory index needs tag repair before retrieval quality can improve.",
        "Backfill domains, intents, and modes for old memory files.",
        "Keep canonical Markdown as the source of truth.",
        "Use a repair reindex scope instead of silently mutating files in the background."
      ].join("\n")
    });

    expect(tags.domains).toContain("memory-system");
    expect(tags.domains).toContain("operations");
    expect(tags.intents).toContain("design");
    expect(tags.modes).toContain("coding");
  });
});

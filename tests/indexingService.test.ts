import { describe, expect, it } from "vitest";
import { splitRationaleIntoChunks } from "../src/memory/indexingService.js";
import { rationaleEntrySchema } from "../src/memory/schema.js";

describe("splitRationaleIntoChunks", () => {
  it("derives bounded search chunks from a single Markdown body", () => {
    const entry = rationaleEntrySchema.parse({
      frontmatter: { id: "R-body-chunks" },
      title: "Keep storage flat",
      body: [
        "## Context",
        "The stored document keeps its Markdown headings.",
        "",
        "## Decision",
        "Search chunks are derived during indexing instead of becoming storage fields.",
        "",
        "x".repeat(1500)
      ].join("\n")
    });

    const chunks = splitRationaleIntoChunks(entry);
    const bodyChunks = chunks.filter((chunk) => chunk.kind === "body");

    expect(chunks[0]?.kind).toBe("summary");
    expect(bodyChunks.length).toBeGreaterThan(1);
    expect(bodyChunks.every((chunk) => chunk.content.length <= 1200)).toBe(true);
    expect(bodyChunks.map((chunk) => chunk.content).join("\n\n")).toContain("## Decision");
  });
});

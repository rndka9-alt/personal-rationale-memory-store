import { describe, expect, it } from "vitest";
import { MockEmbeddingProvider } from "../src/embeddings/mockEmbeddingProvider.js";

describe("MockEmbeddingProvider", () => {
  it("creates deterministic vectors with the requested dimension", async () => {
    const provider = new MockEmbeddingProvider();
    const [first] = await provider.embedTexts(["rationale"], {
      inputType: "document",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(first).toHaveLength(1024);
  });
});


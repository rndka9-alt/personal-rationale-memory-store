import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/ontology/taskClassifier.js";

describe("classifyTask", () => {
  it("extracts multiple task signals for implementation work", () => {
    const classification = classifyTask("Implement Docker compose changes in src/index.ts for memory retrieval");

    expect(classification.intents).toContain("design");
    expect(classification.domains).toContain("memory-system");
    expect(classification.domains).toContain("operations");
    expect(classification.modes).toContain("coding");
    expect(classification.fileHints).toContain("src/index.ts");
    expect(classification.likelyArtifact).toBe("code");
  });
});

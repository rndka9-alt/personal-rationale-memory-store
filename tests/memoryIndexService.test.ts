import { describe, expect, it } from "vitest";
import {
  deriveProjectName,
  electMedoid,
  maxPairSimilarity,
  validateTriggerPhrase
} from "../src/memory/memoryIndexService.js";

describe("maxPairSimilarity", () => {
  it("picks the strongest chunk pair regardless of chunk counts", () => {
    const shortDocument = [[1, 0, 0]];
    const longDocument = [
      [0, 1, 0],
      [0.9, 0.1, 0],
      [0, 0, 1]
    ];

    const similarity = maxPairSimilarity(shortDocument, longDocument);

    expect(similarity).toBeGreaterThan(0.99);
  });

  it("stays low when no chunk pair shares meaning", () => {
    const similarity = maxPairSimilarity([[1, 0, 0]], [[0, 1, 0], [0, 0, 1]]);

    expect(similarity).toBeLessThan(0.01);
  });
});

describe("electMedoid", () => {
  it("elects the document closest to every other member", () => {
    const embeddingsByEntryId = new Map<string, number[][]>([
      ["R-left", [[1, 0.2, 0]]],
      ["R-center", [[1, 0, 0]]],
      ["R-right", [[1, -0.2, 0]]]
    ]);

    const medoid = electMedoid(["R-left", "R-center", "R-right"], embeddingsByEntryId);

    expect(medoid).toBe("R-center");
  });

  it("ignores members without embeddings instead of failing the election", () => {
    const embeddingsByEntryId = new Map<string, number[][]>([
      ["R-embedded", [[1, 0, 0]]]
    ]);

    const medoid = electMedoid(["R-legacy", "R-embedded"], embeddingsByEntryId);

    expect(medoid).toBe("R-embedded");
  });

  it("returns null when no member has an embedding", () => {
    expect(electMedoid(["R-legacy"], new Map())).toBeNull();
  });
});

describe("deriveProjectName", () => {
  it("keeps the project only when every member shares it", () => {
    expect(deriveProjectName([
      { projectName: "cancun-market-front" },
      { projectName: "cancun-market-front" }
    ])).toBe("cancun-market-front");
  });

  it("falls back to global when projects mix or are missing", () => {
    expect(deriveProjectName([
      { projectName: "cancun-market-front" },
      { projectName: "llm-io" }
    ])).toBeNull();
    expect(deriveProjectName([
      { projectName: "cancun-market-front" },
      { projectName: null }
    ])).toBeNull();
  });
});

describe("validateTriggerPhrase", () => {
  it("accepts a single-line phrase within the length limit", () => {
    expect(validateTriggerPhrase(true, "git push가 hook에서 실패하면 → uncommitted changes 확인")).toBeNull();
  });

  it("requires a phrase when the memories share a trigger", () => {
    expect(validateTriggerPhrase(true, null)).not.toBeNull();
    expect(validateTriggerPhrase(true, "   ")).not.toBeNull();
  });

  it("rejects newlines and control characters that would break the compose pack", () => {
    expect(validateTriggerPhrase(true, "한 줄\n## 주입된 헤딩")).not.toBeNull();
    expect(validateTriggerPhrase(true, "제어\u0007문자 포함")).not.toBeNull();
  });

  it("skips validation entirely on abstain", () => {
    expect(validateTriggerPhrase(false, null)).toBeNull();
  });
});

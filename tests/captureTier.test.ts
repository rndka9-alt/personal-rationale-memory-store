import { describe, expect, it } from "vitest";
import { deriveCaptureTier } from "../src/memory/rationaleService.js";

describe("deriveCaptureTier", () => {
  it("labels captures with both reuse boundaries as full", () => {
    expect(deriveCaptureTier({
      reuseWhen: ["A similar constrained decision appears."],
      avoidWhen: ["The future task is unrelated."]
    })).toBe("full");
  });

  it("labels captures missing any boundary as quick", () => {
    expect(deriveCaptureTier({})).toBe("quick");
    expect(deriveCaptureTier({
      reuseWhen: ["A similar constrained decision appears."],
      avoidWhen: []
    })).toBe("quick");
    expect(deriveCaptureTier({
      reuseWhen: [],
      avoidWhen: ["The future task is unrelated."]
    })).toBe("quick");
  });
});

import { describe, expect, it } from "vitest";
import { calculateReviewPriority } from "../src/memory/rationaleService.js";

describe("calculateReviewPriority", () => {
  it("prioritizes open opinions before usage-only candidates", () => {
    const withOpinion = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 0
    }, 1);
    const withUsageOnly = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 3
    }, 0);

    expect(withOpinion.score).toBeGreaterThan(withUsageOnly.score);
    expect(withOpinion.reasons).toContain("open-opinions:1");
  });

  it("keeps standard candidates explicit when no priority signal exists", () => {
    const priority = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 0
    }, 0);

    expect(priority.score).toBe(0);
    expect(priority.reasons).toEqual(["standard-candidate"]);
  });

  it("subtracts explicit negative feedback from review priority", () => {
    const helpful = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 0
    }, 0, {
      appliedCount: 0,
      helpfulCount: 2,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 2,
      negativeCount: 0
    });
    const unhelpful = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 0
    }, 0, {
      appliedCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 2,
      dismissedCount: 0,
      positiveCount: 0,
      negativeCount: 2
    });

    expect(helpful.score).toBeGreaterThan(unhelpful.score);
    expect(unhelpful.reasons).toContain("feedback:-2.00");
  });
});

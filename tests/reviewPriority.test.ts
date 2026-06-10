import { describe, expect, it } from "vitest";
import { calculateReviewPriority, calculateSearchRanking } from "../src/memory/rationaleService.js";

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
    expect(withOpinion.reasons).toContain("open-opinions:1:+4.00");
  });

  it("keeps standard candidates explicit when no priority signal exists", () => {
    const priority = calculateReviewPriority({
      reviewState: "unreviewed",
      useCount: 0
    }, 0);

    expect(priority.score).toBe(0);
    expect(priority.reasons).toEqual(["standard-candidate"]);
  });

  it("raises explicit negative feedback as review attention", () => {
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

    expect(unhelpful.score).toBeGreaterThan(helpful.score);
    expect(helpful.reasons).toContain("positive-feedback:2:+1.50");
    expect(unhelpful.reasons).toContain("negative-feedback:2:+3.00");
  });
});

describe("calculateSearchRanking", () => {
  it("reports signed score contributions for ranking signals", () => {
    const ranking = calculateSearchRanking({
      confidence: 0.7,
      acceptanceState: "accepted",
      reviewState: "reviewed",
      type: "rationale",
      metadata: {
        domains: ["memory-system"],
        intents: ["design"],
        modes: ["coding"]
      },
      useCount: 4,
      vectorScore: 0.8,
      lexicalRank: 1
    }, {
      domains: ["memory-system"],
      intents: ["design"],
      modes: ["coding"],
      types: ["rationale"]
    }, {
      appliedCount: 1,
      helpfulCount: 1,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 2,
      negativeCount: 0
    });

    expect(ranking.reasons).toContain("vector:0.800:+4.00");
    expect(ranking.reasons).toContain("lexical:1.00:+1.00");
    expect(ranking.reasons).toContain("accepted:+2.00");
    expect(ranking.reasons).toContain("reviewed:+0.50");
    expect(ranking.reasons).toContain("positive-feedback:2:+0.70");
    expect(ranking.reasons).toContain("domain-match:1:+2.00");
  });

  it("penalizes memories that need revision during search", () => {
    const ranking = calculateSearchRanking({
      confidence: 0.5,
      acceptanceState: "candidate",
      reviewState: "needs_revision",
      type: "rationale",
      metadata: {},
      useCount: 0,
      vectorScore: 0.7
    }, {}, {
      appliedCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 1,
      dismissedCount: 1,
      positiveCount: 0,
      negativeCount: 2
    });

    expect(ranking.reasons).toContain("needs-revision:-1.00");
    expect(ranking.reasons).toContain("negative-feedback:2:-1.50");
  });

  it("does not penalize auto-captured unreviewed candidates", () => {
    const manualCandidateRanking = calculateSearchRanking({
      confidence: 0.5,
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      type: "rationale",
      metadata: {},
      useCount: 0,
      vectorScore: 0.7
    }, {});
    const autoCapturedRanking = calculateSearchRanking({
      confidence: 0.5,
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      type: "rationale",
      metadata: { capture_kind: "auto" },
      useCount: 0,
      vectorScore: 0.7
    }, {});

    expect(autoCapturedRanking.score).toBe(manualCandidateRanking.score);
    expect(autoCapturedRanking.reasons.some((reason) => reason.startsWith("auto-unreviewed:"))).toBe(false);
  });

  it("does not boost search ranking from passive use counts", () => {
    const baseRanking = calculateSearchRanking({
      confidence: 0.5,
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      type: "rationale",
      metadata: {},
      useCount: 0,
      vectorScore: 0.7
    }, {}, {
      appliedCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 0,
      negativeCount: 0
    });
    const passiveUseRanking = calculateSearchRanking({
      confidence: 0.5,
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      type: "rationale",
      metadata: {},
      useCount: 100,
      lastUsedAt: "2099-01-01T00:00:00.000Z",
      vectorScore: 0.7
    }, {}, {
      appliedCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 0,
      negativeCount: 0
    });

    expect(passiveUseRanking.score).toBe(baseRanking.score);
    expect(passiveUseRanking.reasons.some((reason) => reason.startsWith("usage:"))).toBe(false);
    expect(passiveUseRanking.reasons.some((reason) => reason.startsWith("recent-usage:"))).toBe(false);
  });
});

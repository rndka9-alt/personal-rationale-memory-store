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
      acceptanceState: "accepted",
      reviewState: "reviewed",
      vectorScore: 0.8,
      lexicalRank: 1
    }, {}, {
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
    expect(ranking.reasons).toContain("positive-feedback:2:+1.00");
  });

  it("penalizes memories that need revision during search", () => {
    const ranking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "needs_revision",
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

  it("caps positive feedback below unbounded accumulation", () => {
    const ranking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7
    }, {}, {
      appliedCount: 10,
      helpfulCount: 0,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 10,
      negativeCount: 0
    });

    expect(ranking.reasons).toContain("positive-feedback:10:+2.00");
  });

  it("boosts matching-project memories without penalizing other projects", () => {
    const noProjectRanking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7
    }, { project: { name: "alpha" } });
    const matchingProjectRanking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7,
      project: { name: "alpha" }
    }, { project: { name: "alpha" } });
    const otherProjectRanking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7,
      project: { name: "beta" }
    }, { project: { name: "alpha" } });

    expect(matchingProjectRanking.reasons).toContain("project-match:+1.50");
    expect(matchingProjectRanking.score).toBeGreaterThan(noProjectRanking.score);
    expect(otherProjectRanking.score).toBe(noProjectRanking.score);
    expect(otherProjectRanking.reasons.some((reason) => reason.startsWith("project-"))).toBe(false);
  });

  it("matches project names case-insensitively", () => {
    const ranking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7,
      project: { name: "RisuAI" }
    }, { project: { name: "risuai" } });

    expect(ranking.reasons).toContain("project-match:+1.50");
  });

  it("keeps distinct project names separate even when one contains the other", () => {
    const ranking = calculateSearchRanking({
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      vectorScore: 0.7,
      project: { name: "Risuai-NodeOnly" }
    }, { project: { name: "risuai" } });

    expect(ranking.reasons.some((reason) => reason.startsWith("project-"))).toBe(false);
  });
});

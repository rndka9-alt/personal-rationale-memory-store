import { describe, expect, it } from "vitest";
import {
  paginateReviewQueueEntries,
  type ReviewQueueEntry
} from "../src/memory/rationaleService.js";

describe("review queue pagination", () => {
  it("sorts the complete result by creation time before slicing a page", () => {
    const entries = [
      createEntry("oldest", "2026-07-01T00:00:00.000Z"),
      createEntry("newest", "2026-07-04T00:00:00.000Z"),
      createEntry("third", "2026-07-02T00:00:00.000Z"),
      createEntry("second", "2026-07-03T00:00:00.000Z")
    ];

    const result = paginateReviewQueueEntries(entries, {
      sortMode: "created",
      signalFilter: "all",
      page: 2,
      pageSize: 2
    });

    expect(result.items.map((entry) => entry.id)).toEqual(["third", "oldest"]);
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 4,
      totalPages: 2
    });
  });

  it("applies signal filters before calculating pagination totals", () => {
    const positive = createEntry("positive", "2026-07-02T00:00:00.000Z");
    positive.usageFeedback.positiveCount = 1;

    const result = paginateReviewQueueEntries([
      createEntry("plain", "2026-07-03T00:00:00.000Z"),
      positive
    ], {
      sortMode: "created",
      signalFilter: "with_positive_feedback",
      page: 1,
      pageSize: 25
    });

    expect(result.items.map((entry) => entry.id)).toEqual(["positive"]);
    expect(result.pagination.totalItems).toBe(1);
  });
});

function createEntry(id: string, createdAt: string): ReviewQueueEntry {
  return {
    id,
    type: "rationale",
    status: "candidate",
    acceptanceState: "candidate",
    reviewState: "unreviewed",
    decisionState: "unknown",
    title: id,
    canonicalPath: `/tmp/${id}.md`,
    scope: "general",
    confidence: 0.5,
    useCount: 0,
    createdAt,
    metadata: {},
    usageFeedback: {
      appliedCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 0,
      dismissedCount: 0,
      positiveCount: 0,
      negativeCount: 0
    },
    reviewPriorityScore: 0,
    reviewPriorityReasons: ["standard-candidate"]
  };
}

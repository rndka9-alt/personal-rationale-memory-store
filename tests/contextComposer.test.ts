import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ContextComposer } from "../src/memory/contextComposer.js";
import type { RationaleService } from "../src/memory/rationaleService.js";
import type { MemoryEntryRecord } from "../src/memory/schema.js";

type RecordedUsageEvent = Parameters<RationaleService["recordUsageEvents"]>[0][number];

describe("compose context relevance floor", () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "context-composer-"));
    await mkdir(path.join(dataDirectory, "kernel"), { recursive: true });
    await writeFile(path.join(dataDirectory, "kernel", "global-principles.md"), "# Global Principles\n- Test kernel.");
  });

  it("drops low-similarity results while keeping lexical-only results usable", async () => {
    const relevantEntry = createSearchResult("R-relevant", "Relevant memory", 0.9);
    const unrelatedEntry = createSearchResult("R-unrelated", "Unrelated but boosted memory", 0.2);
    const lexicalOnlyEntry = createSearchResult("R-lexical", "Lexical fallback memory", undefined);
    const { service, recordedEvents } = createRationaleServiceStub([
      relevantEntry,
      unrelatedEntry,
      lexicalOnlyEntry
    ]);

    const composer = new ContextComposer(dataDirectory, service);
    const context = await composer.compose({ task: "test task" });

    expect(context).toContain("R-relevant");
    expect(context).toContain("R-lexical");
    expect(context).not.toContain("R-unrelated");
    expect(recordedEvents.map((event) => event.entryId)).toEqual(["R-relevant", "R-lexical"]);
  });

  it("appends a feedback footer so clients have an in-context trigger", async () => {
    const { service } = createRationaleServiceStub([
      createSearchResult("R-relevant", "Relevant memory", 0.9)
    ]);

    const composer = new ContextComposer(dataDirectory, service);
    const context = await composer.compose({ task: "test task" });

    expect(context).toContain("## Feedback");
    expect(context).toContain("record_usage_feedback");
  });

  it("omits the feedback footer when nothing survives the floor", async () => {
    const { service, recordedEvents } = createRationaleServiceStub([
      createSearchResult("R-unrelated", "Unrelated memory", 0.1)
    ]);

    const composer = new ContextComposer(dataDirectory, service);
    const context = await composer.compose({ task: "test task" });

    expect(context).not.toContain("## Feedback");
    expect(recordedEvents).toEqual([]);
  });
});

function createSearchResult(id: string, title: string, vectorScore: number | undefined): MemoryEntryRecord {
  const entry: MemoryEntryRecord = {
    id,
    type: "rationale",
    status: "candidate",
    acceptanceState: "candidate",
    reviewState: "unreviewed",
    decisionState: "unknown",
    title,
    canonicalPath: `/memory/${id}.md`,
    scope: "general",
    confidence: 0.5,
    useCount: 0,
    metadata: {},
    searchScore: 5,
    searchReasons: []
  };

  if (typeof vectorScore === "number") {
    entry.vectorScore = vectorScore;
  } else {
    entry.lexicalRank = 4;
  }

  return entry;
}

function createRationaleServiceStub(results: MemoryEntryRecord[]) {
  const recordedEvents: RecordedUsageEvent[] = [];
  const stub = {
    searchWithDiagnostics: async () => ({ results, warnings: [] }),
    getRationale: async (id: string) => ({ rawMarkdown: `# ${id}\nFull entry body.` }),
    recordUsageEvents: async (events: RecordedUsageEvent[]) => {
      recordedEvents.push(...events);
      return events.length;
    }
  };

  return { service: stub as unknown as RationaleService, recordedEvents };
}

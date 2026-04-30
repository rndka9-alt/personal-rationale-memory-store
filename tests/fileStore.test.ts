import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { MemoryFileStore } from "../src/memory/fileStore.js";
import type { RationaleEntry } from "../src/memory/schema.js";

describe("MemoryFileStore", () => {
  it("writes and reads canonical Markdown rationale files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rationale-memory-"));
    const store = new MemoryFileStore(directory);
    const entry: RationaleEntry = {
      frontmatter: {
        id: "R-test-001",
        type: "rationale",
        status: "candidate",
        scope: "general",
        domains: ["development"],
        intents: ["design"],
        modes: ["planning"],
        confidence: 0.5,
        metadata: {}
      },
      title: "Keep rationale canonical",
      situation: "A memory needs to survive database rebuilds.",
      goal: "Keep a human-readable source of truth.",
      constraints: ["Postgres is an index"],
      decision: "Write Markdown first.",
      rationale: "Canonical files preserve reviewable reasoning.",
      rejectedAlternatives: [{ option: "DB-only storage", reason: "It hides memory from humans." }],
      tradeoff: "Parsing is required.",
      reuseWhen: ["Rebuilding indexes"],
      avoidWhen: ["Temporary scratch notes"],
      rawMarkdown: ""
    };

    const canonicalPath = await store.writeEntry(entry);
    const parsed = await store.readEntry(canonicalPath);

    expect(parsed.title).toBe(entry.title);
    expect(parsed.rejectedAlternatives).toEqual(entry.rejectedAlternatives);

    await rm(directory, { recursive: true, force: true });
  });
});


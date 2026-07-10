import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  applyDigestOperations,
  createDigestTextGenerator,
  digestProseSchema,
  extractLlmRequestUsage,
  formatDigestSection,
  shouldRefreshDigest,
  synthesizeDigestSnapshot,
  type DigestClaim,
  type DigestSnapshot
} from "../src/memory/digestService.js";

describe("digest operations", () => {
  it("applies add, strengthen, revise, and retire while capping recent evidence samples", () => {
    const skippedOperations: string[] = [];
    const result = applyDigestOperations([
      createClaim("strengthen", "now", ["n1", "n2"]),
      createClaim("revise", "now", ["n1"]),
      createClaim("retire", "recent", ["n1"])
    ], [
      { type: "add", layer: "about", text: "새 claim", noteIds: ["n7"] },
      { type: "strengthen", claimId: "strengthen", noteIds: ["n3", "n4", "n5", "n6"] },
      { type: "revise", claimId: "revise", text: "고친 claim", layer: "recent", noteIds: ["n8"] },
      { type: "retire", claimId: "retire" },
      { type: "strengthen", claimId: "missing", noteIds: ["n9"] }
    ], {
      now: new Date("2026-07-10T12:00:00.000Z"),
      createClaimId: () => "added",
      onSkippedOperation: (operation) => skippedOperations.push(operation.type)
    });

    expect(result.claims.find((claim) => claim.id === "added")).toMatchObject({
      layer: "about",
      text: "새 claim",
      evidenceCount: 1,
      sampleNoteIds: ["n7"]
    });
    expect(result.claims.find((claim) => claim.id === "strengthen")).toMatchObject({
      evidenceCount: 6,
      sampleNoteIds: ["n2", "n3", "n4", "n5", "n6"]
    });
    expect(result.claims.find((claim) => claim.id === "revise")).toMatchObject({
      layer: "recent",
      text: "고친 claim",
      evidenceCount: 2,
      sampleNoteIds: ["n1", "n8"]
    });
    expect(result.claims.find((claim) => claim.id === "retire")?.retiredAt)
      .toBe("2026-07-10T12:00:00.000Z");
    expect(result.skippedOperations).toHaveLength(1);
    expect(skippedOperations).toEqual(["strengthen"]);
    expect([...result.dirtyLayers]).toEqual(expect.arrayContaining(["now", "recent", "about"]));
  });
});

describe("digest refresh trigger", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("refreshes immediately at the new-note threshold", () => {
    expect(shouldRefreshDigest({
      newNoteCount: 10,
      synthesizedAt: "2026-07-10T11:59:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(true);
  });

  it("refreshes one new note after the minimum interval", () => {
    expect(shouldRefreshDigest({
      newNoteCount: 1,
      synthesizedAt: "2026-07-09T12:00:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(true);
  });

  it("does not refresh below both conditions", () => {
    expect(shouldRefreshDigest({
      newNoteCount: 1,
      synthesizedAt: "2026-07-10T11:00:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(false);
    expect(shouldRefreshDigest({
      newNoteCount: 0,
      synthesizedAt: "2026-07-01T00:00:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(false);
  });
});

describe("digest section formatting", () => {
  it("orders all four layers and includes freshness metadata", () => {
    const section = formatDigestSection({
      now: "NOW",
      recent: "RECENT",
      longterm: "LONGTERM",
      about: "ABOUT"
    }, "2026-07-10T12:00:00.000Z", 3);

    expect(section).toContain("━━━ digest (2026-07-10 합성 · 이후 신규 노트 3개 미반영) ━━━");
    expect(section.indexOf("NOW")).toBeLessThan(section.indexOf("RECENT"));
    expect(section.indexOf("RECENT")).toBeLessThan(section.indexOf("LONGTERM"));
    expect(section.indexOf("LONGTERM")).toBeLessThan(section.indexOf("ABOUT"));
  });
});

describe("digest synthesis failure", () => {
  it("does not mutate the snapshot when the LLM response cannot be parsed", async () => {
    const snapshot = createSnapshot();
    const originalSnapshot = structuredClone(snapshot);
    const generator = {
      generate: vi.fn().mockResolvedValue("not json")
    };

    await expect(synthesizeDigestSnapshot(snapshot, generator))
      .rejects.toThrow("Digest LLM output was not valid JSON.");
    expect(snapshot).toEqual(originalSnapshot);
  });
});

describe("digest prose repair", () => {
  it("retries an over-budget dirty layer and uses the first repair within 800 characters", async () => {
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "strengthen", claimId: "claim-1", noteIds: ["note-2"] }],
          prose: { now: "가".repeat(900) }
        }))
        .mockResolvedValueOnce("나".repeat(850))
        .mockResolvedValueOnce("다".repeat(790))
    };

    const result = await synthesizeDigestSnapshot(createSnapshot(), generator);

    expect(result.prose.now).toBe("다".repeat(790));
    expect(result.prose.recent).toBe("기존 최근");
    expect(generator.generate).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("800자 이내"),
      "가".repeat(900),
      "digest_repair"
    );
    expect(generator.generate).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("800자 이내"),
      "나".repeat(850),
      "digest_repair"
    );
  });

  it("keeps the shortest complete candidate when both repairs remain over budget", async () => {
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "strengthen", claimId: "claim-1", noteIds: ["note-2"] }],
          prose: { now: "가".repeat(900) }
        }))
        .mockResolvedValueOnce("나".repeat(850))
        .mockResolvedValueOnce("다".repeat(875))
    };

    const result = await synthesizeDigestSnapshot(createSnapshot(), generator);

    expect(result.prose.now).toBe("나".repeat(850));
  });

  it("accepts the 1200 character sanity cap but rejects larger prose", () => {
    const baseProse = {
      now: "",
      recent: "",
      longterm: "",
      about: ""
    };
    expect(digestProseSchema.parse({ ...baseProse, now: "가".repeat(1200) }).now).toHaveLength(1200);
    expect(() => digestProseSchema.parse({ ...baseProse, now: "가".repeat(1201) })).toThrow();
  });
});

describe("digest LLM usage logging", () => {
  it("reads gateway cost and cache tokens from raw usage", () => {
    const usage = extractLlmRequestUsage("vercel", {
      text: "result",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150
      },
      raw: {
        usage: {
          cost: 0.000061,
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          cache_creation_input_tokens: 12,
          market_cost: 0.000061,
          gateway_cost: 0.000061
        }
      }
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 12,
      costUsd: 0.000061,
      raw: {
        cost: 0.000061,
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
        cache_creation_input_tokens: 12,
        market_cost: 0.000061,
        gateway_cost: 0.000061
      }
    });
  });

  it("does not infer cost for direct providers", () => {
    const usage = extractLlmRequestUsage("openai", {
      text: "result",
      raw: { usage: { cost: 1, prompt_tokens: 10 } }
    });

    expect(usage.costUsd).toBeNull();
    expect(usage.inputTokens).toBe(10);
  });

  it("preserves raw usage when llm-io rejects an empty length-limited response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4096,
        total_tokens: 4196,
        cost: 0.063
      }
    }), { status: 200 })));
    try {
      const config = loadConfig({
        DIGEST_ENABLED: "true",
        DIGEST_LLM_PROVIDER: "vercel",
        DIGEST_LLM_MODEL: "anthropic/claude-sonnet-5",
        DIGEST_LLM_API_KEY: "test-key"
      }).digest;
      if (!config.enabled) {
        throw new Error("Expected digest config to be enabled.");
      }
      const generator = createDigestTextGenerator(config);

      await expect(generator.generate("system", "user")).rejects.toMatchObject({
        raw: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4096,
            total_tokens: 4196,
            cost: 0.063
          }
        }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("digest config", () => {
  it("is disabled by default", () => {
    expect(loadConfig({}).digest.enabled).toBe(false);
  });

  it("fails fast when enabled LLM settings are incomplete", () => {
    expect(() => loadConfig({ DIGEST_ENABLED: "true" }))
      .toThrow("DIGEST_LLM_PROVIDER is required");
    expect(() => loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "anthropic"
    })).toThrow("DIGEST_LLM_MODEL is required");
    expect(() => loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "openai",
      DIGEST_LLM_MODEL: "gpt-test"
    })).toThrow("DIGEST_LLM_API_KEY is required");
  });

  it("returns a configured provider and thresholds when enabled", () => {
    const config = loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "openai",
      DIGEST_LLM_MODEL: "gpt-test",
      DIGEST_LLM_API_KEY: "test-key",
      DIGEST_LLM_MAX_TOKENS: "16384",
      DIGEST_IMMEDIATE_NOTES: "12",
      DIGEST_MIN_INTERVAL_HOURS: "36"
    });

    expect(config.digest).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-test",
      apiKey: "test-key",
      maxTokens: 16384,
      immediateNotes: 12,
      minIntervalHours: 36
    });
  });

  it("accepts Vercel AI Gateway models and defaults to an 8192 token budget", () => {
    const config = loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "vercel",
      DIGEST_LLM_MODEL: "openai/gpt-5.6-terra",
      DIGEST_LLM_API_KEY: "test-key"
    });

    expect(config.digest).toMatchObject({
      provider: "vercel",
      model: "openai/gpt-5.6-terra",
      maxTokens: 8192
    });
  });
});

function createClaim(id: string, layer: "now" | "recent" | "longterm" | "about", sampleNoteIds: string[]): DigestClaim {
  return {
    id,
    layer,
    text: `${id} claim`,
    evidenceCount: sampleNoteIds.length,
    sampleNoteIds,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    retiredAt: null
  };
}

function createSnapshot(): DigestSnapshot {
  return {
    claims: [createClaim("claim-1", "now", ["note-1"])],
    state: {
      noteCursor: "2026-07-01T00:00:00.000Z",
      prose: {
        now: "기존 요즘",
        recent: "기존 최근",
        longterm: "기존 장기",
        about: "기존 소개"
      },
      synthesizedAt: "2026-07-01T00:00:00.000Z",
      refreshStartedAt: null
    },
    newNotes: [{
      id: "note-2",
      content: "새 노트",
      topic: null,
      createdAt: "2026-07-10T00:00:00.000Z"
    }]
  };
}

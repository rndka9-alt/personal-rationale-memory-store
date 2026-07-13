import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  applyDigestOperations,
  countNewDigestNotes,
  createDigestTextGenerator,
  DigestService,
  digestProseSchema,
  extractLlmRequestUsage,
  formatDigestSection,
  getDigestClaimStats,
  maintainDigestClaims,
  planDigestOperations,
  resolveMergePressure,
  shouldRefreshDigest,
  synthesizeDigestSnapshot,
  type DigestClaim,
  type DigestEvidence,
  type DigestSnapshot,
  type SynthesizeDigestOptions
} from "../src/memory/digestService.js";

describe("digest evidence", () => {
  it("counts distinct observation dates in Asia/Seoul", () => {
    const claim = createClaim("claim", "now", [
      createEvidence("note-1", "2026-07-01T14:30:00.000Z"),
      createEvidence("note-2", "2026-07-01T15:30:00.000Z"),
      createEvidence("note-3", "2026-07-01T16:00:00.000Z")
    ]);

    expect(getDigestClaimStats(claim)).toEqual({
      firstObservedAt: "2026-07-01T14:30:00.000Z",
      lastObservedAt: "2026-07-01T16:00:00.000Z",
      observedDays: 2
    });
  });
});

describe("digest operation planner", () => {
  it("enforces stable-layer entry through promote and defers a short-span promotion", () => {
    const claim = createClaim("claim", "recent", [
      createEvidence("note-1", "2026-07-01T00:00:00.000Z")
    ]);
    const plan = planDigestOperations([claim], [
      { type: "add", layer: "about", text: "우회 add", noteIds: ["note-2"] },
      { type: "revise", claimId: "claim", layer: "longterm" },
      { type: "promote", claimId: "claim", layer: "about" }
    ], [createNote("note-2", "2026-07-02T00:00:00.000Z")], {
      promoteMinSpanDays: 7,
      runId: "run-1",
      now: new Date("2026-07-02T12:00:00.000Z")
    });

    expect(plan.operations).toEqual([]);
    expect(plan.skippedOperations.map((skipped) => skipped.reason)).toEqual(expect.arrayContaining([
      "stable_layer_add_requires_promotion",
      "stable_layer_transition_requires_promotion",
      "observation_span_below_7_days"
    ]));
    expect(plan.deferredRequests).toEqual([expect.objectContaining({
      claimId: "claim",
      targetLayer: "about",
      runId: "run-1"
    })]);
  });

  it("applies promotion at the configured span boundary", () => {
    const claim = createClaim("claim", "recent", [
      createEvidence("note-1", "2026-07-01T00:00:00.000Z"),
      createEvidence("note-2", "2026-07-08T00:00:00.000Z")
    ]);
    const plan = planDigestOperations([claim], [
      { type: "promote", claimId: "claim", layer: "longterm" }
    ], [], {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });

    expect(plan.operations).toEqual([{ type: "promote", claimId: "claim", layer: "longterm" }]);
    expect(plan.deferredRequests).toEqual([]);
  });

  it("resolves multi-op conflicts from the pre-run snapshot without output-order dependence", () => {
    const claim = createClaim("claim", "now", [createEvidence("note-1", "2026-07-01T00:00:00.000Z")]);
    const operations = [
      { type: "strengthen", claimId: "claim", noteIds: ["note-2"] },
      { type: "promote", claimId: "claim", layer: "about" },
      { type: "retire", claimId: "claim" }
    ] as const;
    const newNotes = [createNote("note-2", "2026-07-10T00:00:00.000Z")];
    const first = planDigestOperations([claim], [...operations], newNotes, {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });
    const reversed = planDigestOperations([claim], [...operations].reverse(), newNotes, {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });

    expect(first.operations).toEqual([{ type: "retire", claimId: "claim" }]);
    expect(reversed.operations).toEqual(first.operations);
    expect(first.skippedOperations.filter((skipped) => skipped.reason === "superseded_by_higher_priority_operation"))
      .toHaveLength(2);
  });

  it("rejects evidence ids outside the current note batch", () => {
    const claim = createClaim("claim", "now", []);
    const plan = planDigestOperations([claim], [
      { type: "strengthen", claimId: "claim", noteIds: ["old-note"] }
    ], [], {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });

    expect(plan.operations).toEqual([]);
    expect(plan.skippedOperations[0]?.reason).toBe("evidence_note_not_in_current_batch");
  });
});

describe("digest operation application", () => {
  it("moves merged child evidence to the parent and retires children", () => {
    const parent = createClaim("parent", "about", [createEvidence("note-1", "2026-06-01T00:00:00.000Z")]);
    const child = createClaim("child", "about", [
      createEvidence("note-1", "2026-06-01T00:00:00.000Z"),
      createEvidence("note-2", "2026-07-01T00:00:00.000Z")
    ]);
    const plan = planDigestOperations([parent, child], [{
      type: "merge",
      parentClaimId: "parent",
      childClaimIds: ["child"],
      text: "위계화된 성향"
    }], [], {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });
    const applied = applyDigestOperations([parent, child], plan, [], {
      now: new Date("2026-07-10T00:00:00.000Z"),
      createClaimId: () => "unused"
    });

    expect(applied.claims.find((claim) => claim.id === "parent")).toMatchObject({
      text: "위계화된 성향",
      evidence: [
        expect.objectContaining({ noteId: "note-1" }),
        expect.objectContaining({ noteId: "note-2" })
      ]
    });
    expect(applied.claims.find((claim) => claim.id === "child")).toMatchObject({
      evidence: [],
      retiredAt: "2026-07-10T00:00:00.000Z"
    });
    expect([...applied.dirtyLayers]).toEqual(["about"]);
  });

  it("records strengthen evidence without touching claim updatedAt or prose dirtiness", () => {
    const claim = createClaim("claim", "now", [createEvidence("note-1", "2026-07-01T00:00:00.000Z")]);
    const plan = planDigestOperations([claim], [
      { type: "strengthen", claimId: "claim", noteIds: ["note-2"] }
    ], [createNote("note-2", "2026-07-02T00:00:00.000Z")], {
      promoteMinSpanDays: 7,
      runId: "run-1"
    });
    const applied = applyDigestOperations([claim], plan, [createNote("note-2", "2026-07-02T00:00:00.000Z")], {
      now: new Date("2026-07-10T00:00:00.000Z"),
      createClaimId: () => "unused"
    });

    expect(applied.claims[0]?.evidence).toHaveLength(2);
    expect(applied.claims[0]?.updatedAt).toBe(claim.updatedAt);
    expect(applied.dirtyLayers.size).toBe(0);
  });
});

describe("deferred promotion and retention maintenance", () => {
  it("applies an eligible deferred promotion without an LLM judgment", () => {
    const claim = createClaim("claim", "recent", [
      createEvidence("note-1", "2026-07-01T00:00:00.000Z"),
      createEvidence("note-2", "2026-07-08T00:00:00.000Z")
    ]);
    const result = maintainDigestClaims([claim], [{
      claimId: "claim",
      targetLayer: "about",
      requestedAt: "2026-07-02T00:00:00.000Z",
      runId: "run-1",
      reason: "observation_span_below_7_days"
    }], [], {
      promoteMinSpanDays: 7,
      recentRetireWeeks: 8,
      now: new Date("2026-07-10T00:00:00.000Z")
    });

    expect(result.claims[0]?.layer).toBe("about");
    expect(result.deferredPromotions).toEqual([]);
    expect(result.appliedOperations).toEqual([{ type: "promote", claimId: "claim", layer: "about" }]);
    expect([...result.dirtyLayers]).toEqual(expect.arrayContaining(["recent", "about"]));
  });

  it("protects deferred recent claims while mechanically retiring other stale recent claims", () => {
    const deferredClaim = createClaim("deferred", "recent", [createEvidence("note-1", "2026-01-01T00:00:00.000Z")]);
    const staleClaim = createClaim("stale", "recent", [createEvidence("note-2", "2026-01-01T00:00:00.000Z")]);
    const result = maintainDigestClaims([deferredClaim, staleClaim], [{
      claimId: "deferred",
      targetLayer: "longterm",
      requestedAt: "2026-01-02T00:00:00.000Z",
      runId: "run-1",
      reason: "observation_span_below_7_days"
    }], [], {
      promoteMinSpanDays: 7,
      recentRetireWeeks: 8,
      now: new Date("2026-07-10T00:00:00.000Z")
    });

    expect(result.claims.find((claim) => claim.id === "deferred")?.retiredAt).toBeNull();
    expect(result.claims.find((claim) => claim.id === "stale")?.retiredAt).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("digest two-stage synthesis", () => {
  it("renders dirty layers from active claims without notes, ops, or previous prose", async () => {
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "revise", claimId: "claim-1", text: "고친 claim", noteIds: ["note-2"] }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ now: "확정 원장만 본 새 prose" }))
    };

    const result = await synthesizeDigestSnapshot(createSnapshot(), generator, createSynthesisOptions());

    expect(result.prose.now).toBe("확정 원장만 본 새 prose");
    expect(generator.generate).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("원장 operation만 결정"),
      expect.stringContaining("newNotes"),
      "digest_judgment"
    );
    const renderPrompt = String(generator.generate.mock.calls[1]?.[1]);
    const judgmentPrompt = String(generator.generate.mock.calls[0]?.[1]);
    expect(judgmentPrompt).not.toContain("evidenceCount");
    expect(judgmentPrompt).not.toContain("updatedAt");
    expect(renderPrompt).toContain("고친 claim");
    expect(renderPrompt).not.toContain("새 노트");
    expect(renderPrompt).not.toContain("기존 요즘");
    expect(renderPrompt).not.toContain("note-2");
  });

  it("keeps the input snapshot unchanged when the render call fails", async () => {
    const snapshot = createSnapshot();
    const originalSnapshot = structuredClone(snapshot);
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "revise", claimId: "claim-1", text: "고친 claim", noteIds: ["note-2"] }]
        }))
        .mockRejectedValueOnce(new Error("render failed"))
    };

    await expect(synthesizeDigestSnapshot(snapshot, generator, createSynthesisOptions()))
      .rejects.toThrow("render failed");
    expect(snapshot).toEqual(originalSnapshot);
  });

  it("does not call the renderer when a dirty layer has no active claims", async () => {
    const generator = {
      generate: vi.fn().mockResolvedValueOnce(JSON.stringify({
        ops: [{ type: "retire", claimId: "claim-1" }]
      }))
    };

    const result = await synthesizeDigestSnapshot(createSnapshot(), generator, createSynthesisOptions());

    expect(result.prose.now).toBe("");
    expect(generator.generate).toHaveBeenCalledTimes(1);
  });

  it("checks eligible deferred promotions without an LLM judgment call", async () => {
    const snapshot = createSnapshot();
    snapshot.claims[0] = createClaim("claim-1", "recent", [
      createEvidence("note-1", "2026-07-01T00:00:00.000Z"),
      createEvidence("note-2", "2026-07-08T00:00:00.000Z")
    ]);
    snapshot.newNotes = [];
    snapshot.deferredPromotions = [{
      claimId: "claim-1",
      targetLayer: "about",
      requestedAt: "2026-07-02T00:00:00.000Z",
      runId: "old-run",
      reason: "observation_span_below_7_days"
    }];
    const generator = {
      generate: vi.fn().mockResolvedValueOnce(JSON.stringify({ about: "승격된 초상" }))
    };

    const result = await synthesizeDigestSnapshot(snapshot, generator, {
      ...createSynthesisOptions(),
      runJudgment: false
    });

    expect(result.claims[0]?.layer).toBe("about");
    expect(result.prose.recent).toBe("");
    expect(result.prose.about).toBe("승격된 초상");
    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(generator.generate).toHaveBeenCalledWith(
      expect.stringContaining("확정된 개인 메모리"),
      expect.any(String),
      "digest_render"
    );
  });

  it("repairs an over-budget rendered layer", async () => {
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "revise", claimId: "claim-1", text: "고친 claim", noteIds: ["note-2"] }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ now: "가".repeat(900) }))
        .mockResolvedValueOnce("나".repeat(790))
    };

    const result = await synthesizeDigestSnapshot(createSnapshot(), generator, createSynthesisOptions());

    expect(result.prose.now).toBe("나".repeat(790));
    expect(generator.generate).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("800자 이내"),
      "가".repeat(900),
      "digest_repair"
    );
  });
});

describe("digest publish boundary", () => {
  it("records a failed run without opening the publish transaction when rendering fails", async () => {
    const pool = new pg.Pool();
    const query = vi.spyOn(pool, "query").mockImplementation(async (text) => {
      const sql = String(text);
      if (sql.includes("FROM digest_state") && sql.includes("WHERE id = $1")) {
        return createQueryResult([{
          id: "singleton",
          note_cursor: "2026-07-01T00:00:00.000Z",
          note_cursor_id: "note-1",
          prose: createProse("기존"),
          synthesized_at: new Date("2026-07-01T00:00:00.000Z"),
          judgment_at: new Date("2026-07-01T00:00:00.000Z"),
          refresh_started_at: null,
          longterm_merge_pressure: false,
          about_merge_pressure: false
        }]);
      }
      if (sql.includes("COUNT(*)::int AS new_note_count")) {
        return createQueryResult([{ new_note_count: 1 }]);
      }
      if (sql.includes("has_maintenance_work")) {
        return createQueryResult([{ has_maintenance_work: false }]);
      }
      if (sql.includes("SET refresh_started_at = $3")) {
        return createQueryResult([{ refresh_started_at: new Date("2026-07-10T00:00:00.000Z") }]);
      }
      if (sql.includes("FROM digest_claims AS claims") && sql.includes("jsonb_agg")) {
        return createQueryResult([{
          id: "claim-1",
          layer: "now",
          text: "기존 claim",
          evidence: [{
            note_id: "note-1",
            observed_at: "2026-07-01T00:00:00.000Z",
            source_kind: "note"
          }],
          created_at: new Date("2026-07-01T00:00:00.000Z"),
          updated_at: new Date("2026-07-01T00:00:00.000Z"),
          retired_at: null
        }]);
      }
      if (sql.includes("SELECT id, content, topic, created_at")) {
        return createQueryResult([{
          id: "note-2",
          content: "새 노트",
          topic: null,
          created_at: new Date("2026-07-10T00:00:00.000Z")
        }]);
      }
      if (sql.includes("FROM digest_deferred_promotions")) {
        return createQueryResult([]);
      }
      if (sql.includes("INSERT INTO llm_request_logs")) {
        return createQueryResult([]);
      }
      if (sql.includes("INSERT INTO digest_runs")) {
        return createQueryResult([]);
      }
      if (sql.includes("SET refresh_started_at = NULL")) {
        return createQueryResult([]);
      }
      throw new Error(`Unexpected digest query: ${sql}`);
    });
    const connect = vi.spyOn(pool, "connect");
    const config = loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "openai",
      DIGEST_LLM_MODEL: "gpt-test",
      DIGEST_LLM_API_KEY: "test-key",
      DIGEST_MIN_INTERVAL_HOURS: "1"
    }).digest;
    if (!config.enabled) {
      throw new Error("Expected digest config to be enabled.");
    }
    const generator = {
      generate: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          ops: [{ type: "revise", claimId: "claim-1", text: "고친 claim", noteIds: ["note-2"] }]
        }))
        .mockRejectedValueOnce(new Error("render failed"))
    };
    const service = new DigestService(pool, config, generator);

    await service.maybeRefreshInBackground();

    expect(connect).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([text]) => String(text).includes("INSERT INTO digest_claims"))).toBe(false);
    expect(query.mock.calls.some(([text]) => String(text).includes("SET note_cursor ="))).toBe(false);
    expect(query.mock.calls.some(([text]) => String(text).includes("INSERT INTO digest_runs"))).toBe(true);
    const failedRunCall = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO digest_runs"));
    expect(String(failedRunCall?.[1]?.[2])).toContain("고친 claim");
  });
});

describe("digest cursor", () => {
  it("counts notes after a (created_at, id) tuple cursor", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ new_note_count: 2 }] });

    await expect(countNewDigestNotes(
      { query },
      "2026-07-10T00:00:00.000Z",
      "note-b"
    )).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("(created_at, id) > ($1::timestamptz, $2::text)"),
      ["2026-07-10T00:00:00.000Z", "note-b"]
    );
  });
});

describe("digest refresh trigger and soft cap", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("refreshes at the note threshold or minimum interval", () => {
    expect(shouldRefreshDigest({
      newNoteCount: 10,
      synthesizedAt: "2026-07-10T11:59:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(true);
    expect(shouldRefreshDigest({
      newNoteCount: 1,
      synthesizedAt: "2026-07-09T12:00:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(true);
    expect(shouldRefreshDigest({
      newNoteCount: 0,
      synthesizedAt: "2026-07-01T00:00:00.000Z",
      immediateNotes: 10,
      minIntervalHours: 24,
      now
    })).toBe(false);
  });

  it("keeps merge pressure active between trigger and release", () => {
    expect(resolveMergePressure(false, 25, 25, 20)).toBe(true);
    expect(resolveMergePressure(true, 22, 25, 20)).toBe(true);
    expect(resolveMergePressure(true, 20, 25, 20)).toBe(false);
  });
});

describe("digest section and prose validation", () => {
  it("orders all four layers and accepts the 1200 character hard cap", () => {
    const section = formatDigestSection(createProse("current"), "2026-07-10T12:00:00.000Z");
    expect(section).toMatch(/^━━━ digest \(2026-07-10 기준\) ━━━/);
    expect(section).not.toContain("미반영");
    expect(section.indexOf("current now")).toBeLessThan(section.indexOf("current recent"));
    expect(section.indexOf("current recent")).toBeLessThan(section.indexOf("current longterm"));
    expect(section.indexOf("current longterm")).toBeLessThan(section.indexOf("current about"));
    expect(digestProseSchema.parse({ ...createProse(""), now: "가".repeat(1200) }).now).toHaveLength(1200);
    expect(() => digestProseSchema.parse({ ...createProse(""), now: "가".repeat(1201) })).toThrow();
  });
});

describe("digest LLM usage logging", () => {
  it("reads gateway cost and cache tokens from raw usage", () => {
    const usage = extractLlmRequestUsage("vercel", {
      text: "result",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      raw: {
        usage: {
          cost: 0.000061,
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          cache_creation_input_tokens: 12
        }
      }
    });

    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 12,
      costUsd: 0.000061
    });
  });

  it("preserves raw usage when llm-io rejects an empty length-limited response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196, cost: 0.063 }
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
        raw: { usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196, cost: 0.063 } }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("digest config", () => {
  it("is disabled by default and validates merge hysteresis", () => {
    expect(loadConfig({}).digest.enabled).toBe(false);
    expect(() => loadConfig({
      DIGEST_STABLE_LAYER_MERGE_TRIGGER: "20",
      DIGEST_STABLE_LAYER_MERGE_RELEASE: "20"
    })).toThrow("DIGEST_STABLE_LAYER_MERGE_RELEASE must be lower");
  });

  it("returns configured digest policies", () => {
    const config = loadConfig({
      DIGEST_ENABLED: "true",
      DIGEST_LLM_PROVIDER: "openai",
      DIGEST_LLM_MODEL: "gpt-test",
      DIGEST_LLM_API_KEY: "test-key",
      DIGEST_LLM_MAX_TOKENS: "16384",
      DIGEST_IMMEDIATE_NOTES: "12",
      DIGEST_MIN_INTERVAL_HOURS: "36",
      DIGEST_PROMOTE_MIN_SPAN_DAYS: "9",
      DIGEST_RECENT_RETIRE_WEEKS: "10",
      DIGEST_STABLE_LAYER_MERGE_TRIGGER: "30",
      DIGEST_STABLE_LAYER_MERGE_RELEASE: "24"
    });

    expect(config.digest).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-test",
      apiKey: "test-key",
      maxTokens: 16384,
      immediateNotes: 12,
      minIntervalHours: 36,
      promoteMinSpanDays: 9,
      recentRetireWeeks: 10,
      stableLayerMergeTrigger: 30,
      stableLayerMergeRelease: 24
    });
  });
});

function createClaim(
  id: string,
  layer: "now" | "recent" | "longterm" | "about",
  evidence: DigestEvidence[]
): DigestClaim {
  return {
    id,
    layer,
    text: `${id} claim`,
    evidence,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    retiredAt: null
  };
}

function createEvidence(noteId: string, observedAt: string): DigestEvidence {
  return { noteId, observedAt, sourceKind: "note" };
}

function createNote(id: string, createdAt: string) {
  return { id, content: `${id} content`, topic: null, createdAt };
}

function createSnapshot(): DigestSnapshot {
  return {
    claims: [createClaim("claim-1", "now", [createEvidence("note-1", "2026-07-01T00:00:00.000Z")])],
    state: {
      noteCursorAt: "2026-07-01T00:00:00.000Z",
      noteCursorId: "note-1",
      prose: {
        now: "기존 요즘",
        recent: "기존 최근",
        longterm: "기존 장기",
        about: "기존 소개"
      },
      synthesizedAt: "2026-07-01T00:00:00.000Z",
      judgmentAt: "2026-07-01T00:00:00.000Z",
      refreshStartedAt: null,
      longtermMergePressure: false,
      aboutMergePressure: false
    },
    newNotes: [{
      id: "note-2",
      content: "새 노트",
      topic: null,
      createdAt: "2026-07-10T00:00:00.000Z"
    }],
    deferredPromotions: []
  };
}

function createSynthesisOptions(): SynthesizeDigestOptions {
  return {
    promoteMinSpanDays: 7,
    recentRetireWeeks: 8,
    stableLayerMergeTrigger: 25,
    stableLayerMergeRelease: 20,
    runId: "run-1",
    now: new Date("2026-07-10T12:00:00.000Z"),
    createClaimId: () => "added"
  };
}

function createProse(prefix: string) {
  return {
    now: `${prefix} now`,
    recent: `${prefix} recent`,
    longterm: `${prefix} longterm`,
    about: `${prefix} about`
  };
}

function createQueryResult(rows: pg.QueryResultRow[]): pg.QueryResult {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

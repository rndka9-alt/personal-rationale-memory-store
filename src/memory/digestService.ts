import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  AnthropicMessagesFormat,
  AnthropicProvider,
  Llm,
  OpenAIChatCompletionsFormat,
  OpenAIProvider,
  VercelAIGatewayProvider,
  type FetchLike,
  type LlmFinishReason,
  type LlmUsage
} from "llm-io";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { logError, logInfo, logWarn } from "../diagnostics/index.js";
import {
  LlmRequestLogService,
  type LlmRequestUsage
} from "./llmRequestLogService.js";
import {
  applyDigestOperations,
  digestClaimTextMaxLength,
  digestJudgmentOutputSchema,
  digestLayerSchema,
  digestLayers,
  digestOperationClaimIds,
  digestOperationSchema,
  digestProseSchema,
  getDigestClaimStats,
  maintainDigestClaims,
  planDigestOperations,
  resolveMergePressure,
  type AppliedDigestOperations,
  type DigestClaim,
  type DigestDeferredEvent,
  type DigestDeferredPromotion,
  type DigestEvidence,
  type DigestLayer,
  type DigestNote,
  type DigestOperation,
  type DigestProse,
  type DigestSkippedOperation
} from "./digestDomain.js";

export {
  applyDigestOperations,
  digestClaimTextMaxLength,
  digestLayerSchema,
  digestLayers,
  digestOperationSchema,
  digestProseHardMaxLength,
  digestProseSchema,
  getDigestClaimStats,
  maintainDigestClaims,
  planDigestOperations,
  resolveMergePressure
} from "./digestDomain.js";
export type {
  DigestClaim,
  DigestDeferredEvent,
  DigestDeferredPromotion,
  DigestEvidence,
  DigestLayer,
  DigestNote,
  DigestOperation,
  DigestProse,
  DigestSkippedOperation
} from "./digestDomain.js";

const digestStateId = "singleton";
const digestRefreshLockTimeoutMinutes = 10;
export const digestProseTargetLength = 800;
export const digestRenderOutputMaxLength = 4000;

const digestOutputProseSchema = z.object({
  now: z.string().max(digestRenderOutputMaxLength).optional(),
  recent: z.string().max(digestRenderOutputMaxLength).optional(),
  longterm: z.string().max(digestRenderOutputMaxLength).optional(),
  about: z.string().max(digestRenderOutputMaxLength).optional()
}).strict();

const digestRepairTextSchema = z.string().trim().min(1);

const digestStateRowSchema = z.object({
  id: z.literal(digestStateId),
  note_cursor: z.string().nullable(),
  note_cursor_id: z.string().nullable(),
  prose: digestProseSchema,
  synthesized_at: z.coerce.date().nullable(),
  judgment_at: z.coerce.date().nullable(),
  refresh_started_at: z.coerce.date().nullable(),
  longterm_merge_pressure: z.boolean(),
  about_merge_pressure: z.boolean()
});

const digestClaimRowSchema = z.object({
  id: z.string(),
  layer: digestLayerSchema,
  text: z.string(),
  evidence: z.array(z.object({
    note_id: z.string(),
    observed_at: z.coerce.date(),
    source_kind: z.string()
  }).strict()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  retired_at: z.coerce.date().nullable()
});

const digestNoteRowSchema = z.object({
  id: z.string(),
  content: z.string(),
  topic: z.string().nullable(),
  created_at: z.coerce.date()
});

export const digestSeedInputSchema = z.object({
  claims: z.array(z.object({
    layer: digestLayerSchema,
    // 판단 planner의 하드캡을 seed가 우회해 비대 claim을 심지 못하게 같은 상한을 건다.
    text: z.string().min(1).max(digestClaimTextMaxLength),
    sampleNoteIds: z.array(z.string().min(1))
  }).strict()),
  prose: digestProseSchema
}).strict();

export type DigestSeedInput = z.infer<typeof digestSeedInputSchema>;

export type DigestState = {
  noteCursorAt: string | null;
  noteCursorId: string | null;
  prose: DigestProse;
  synthesizedAt: string | null;
  // 코드-only 렌더가 신규 노트 판단 주기를 뒤로 미루지 않도록 마지막 판단 시각을 분리한다.
  judgmentAt: string | null;
  refreshStartedAt: string | null;
  longtermMergePressure: boolean;
  aboutMergePressure: boolean;
};

export type DigestSnapshot = {
  claims: DigestClaim[];
  state: DigestState;
  newNotes: DigestNote[];
  deferredPromotions: DigestDeferredPromotion[];
};

export type DigestLlmPurpose = "digest_judgment" | "digest_render" | "digest_repair";

export type DigestTextGeneration = {
  text: string;
  usage?: LlmUsage;
  raw?: unknown;
  finishReason?: LlmFinishReason;
};

export type DigestTextGenerator = {
  generate(
    systemPrompt: string,
    userPrompt: string,
    purpose?: DigestLlmPurpose
  ): Promise<string | DigestTextGeneration>;
};

type EnabledDigestConfig = Extract<AppConfig["digest"], { enabled: true }>;
type DigestQueryExecutor = Pick<pg.Pool, "query">;

type SynthesizedDigest = AppliedDigestOperations & {
  deferredPromotions: DigestDeferredPromotion[];
  deferredEvents: DigestDeferredEvent[];
  prose: DigestProse;
  longtermMergePressure: boolean;
  aboutMergePressure: boolean;
};

export class DigestService {
  private refreshInFlight = false;
  private readonly generator: DigestTextGenerator;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: EnabledDigestConfig,
    generator?: DigestTextGenerator
  ) {
    this.generator = generator ?? createDigestTextGenerator(config);
  }

  async getDigestSection() {
    const state = await getDigestState(this.pool);
    if (!state.synthesizedAt) {
      return null;
    }

    return formatDigestSection(state.prose, state.synthesizedAt);
  }

  async maybeRefreshInBackground() {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      await this.refreshIfDue();
    } catch (error) {
      logError("Digest background refresh failed.", error);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async refreshIfDue() {
    const initialState = await getDigestState(this.pool);
    const initialNewNoteCount = await countNewDigestNotes(
      this.pool,
      initialState.noteCursorAt,
      initialState.noteCursorId
    );
    const now = new Date();
    const judgmentDue = shouldRefreshDigest({
      newNoteCount: initialNewNoteCount,
      synthesizedAt: initialState.judgmentAt,
      immediateNotes: this.config.immediateNotes,
      minIntervalHours: this.config.minIntervalHours,
      now
    });
    const maintenanceDue = await hasDigestMaintenanceWork(this.pool, this.config, now);
    if (!judgmentDue && !maintenanceDue) {
      return;
    }

    const lockStartedAt = await acquireDigestRefreshLock(this.pool);
    if (!lockStartedAt) {
      logInfo("Digest refresh skipped because another process holds the lock.");
      return;
    }

    let operations: DigestOperation[] = [];
    let skippedOperations: DigestSkippedOperation[] = [];
    let deferredEvents: DigestDeferredEvent[] = [];
    let snapshot: DigestSnapshot | undefined;
    let runKind: "synthesis" | "maintenance" = judgmentDue ? "synthesis" : "maintenance";
    const runId = randomUUID();
    try {
      snapshot = await loadDigestSnapshot(this.pool);
      const shouldRunJudgment = judgmentDue && snapshot.newNotes.length > 0;
      runKind = shouldRunJudgment ? "synthesis" : "maintenance";

      const synthesized = await synthesizeDigestSnapshot(
        snapshot,
        createLoggedDigestTextGenerator(this.pool, this.config, this.generator, runId),
        {
          ...this.config,
          runId,
          now,
          runJudgment: shouldRunJudgment,
          onPlanned: (planned) => {
            operations = planned.operations;
            skippedOperations = planned.skippedOperations;
            deferredEvents = planned.deferredEvents;
          }
        }
      );
      operations = synthesized.operations;
      skippedOperations = synthesized.skippedOperations;
      deferredEvents = synthesized.deferredEvents;
      if (!shouldRunJudgment && !hasDigestChanges(synthesized)) {
        await releaseDigestRefreshLock(this.pool, lockStartedAt);
        return;
      }
      await persistSuccessfulDigestRun(
        this.pool,
        snapshot,
        synthesized,
        lockStartedAt,
        now,
        runId,
        runKind
      );
      logInfo("Digest refresh completed.", {
        newNoteCount: snapshot.newNotes.length,
        operationCount: operations.length,
        skippedOperationCount: skippedOperations.length,
        dirtyLayers: [...synthesized.dirtyLayers]
      });
    } catch (error) {
      const proseSnapshot = snapshot ? snapshot.state.prose : initialState.prose;
      const newNoteCount = runKind === "synthesis"
        ? snapshot?.newNotes.length ?? initialNewNoteCount
        : 0;
      try {
        await recordFailedDigestRun(
          this.pool,
          snapshot?.claims ?? [],
          operations,
          skippedOperations,
          deferredEvents,
          proseSnapshot,
          newNoteCount,
          lockStartedAt,
          error,
          now,
          runId,
          runKind
        );
      } catch (recordError) {
        logError("Recording failed digest run failed.", recordError);
        await releaseDigestRefreshLock(this.pool, lockStartedAt);
      }
      throw error;
    }
  }
}

export function shouldRefreshDigest(input: {
  newNoteCount: number;
  synthesizedAt: string | null;
  immediateNotes: number;
  minIntervalHours: number;
  now?: Date;
}) {
  if (input.newNoteCount >= input.immediateNotes) {
    return true;
  }
  if (input.newNoteCount < 1) {
    return false;
  }
  if (!input.synthesizedAt) {
    return true;
  }

  const now = input.now ?? new Date();
  const synthesizedAt = new Date(input.synthesizedAt);
  if (Number.isNaN(synthesizedAt.getTime())) {
    throw new Error(`Invalid digest synthesizedAt timestamp: ${input.synthesizedAt}`);
  }
  const minIntervalMilliseconds = input.minIntervalHours * 60 * 60 * 1000;
  return now.getTime() - synthesizedAt.getTime() >= minIntervalMilliseconds;
}

export function formatDigestSection(prose: DigestProse, synthesizedAt: string) {
  const synthesizedDate = new Date(synthesizedAt);
  if (Number.isNaN(synthesizedDate.getTime())) {
    throw new Error(`Invalid digest synthesizedAt timestamp: ${synthesizedAt}`);
  }

  const sections = [
    `[요즘 관심사]\n${prose.now}`,
    `[최근]\n${prose.recent}`,
    `[장기]\n${prose.longterm}`,
    `[나에 대해]\n${prose.about}`
  ];
  const header = `━━━ digest (${synthesizedDate.toISOString().slice(0, 10)} 기준) ━━━`;
  return `${header}\n${sections.join("\n\n")}`;
}

export type SynthesizeDigestOptions = {
  promoteMinSpanDays: number;
  recentRetireWeeks: number;
  stableLayerMergeTrigger: number;
  stableLayerMergeRelease: number;
  runId: string;
  runJudgment?: boolean;
  now?: Date;
  createClaimId?: () => string;
  onPlanned?: (planned: {
    operations: DigestOperation[];
    skippedOperations: DigestSkippedOperation[];
    deferredEvents: DigestDeferredEvent[];
  }) => void;
};

export async function synthesizeDigestSnapshot(
  snapshot: DigestSnapshot,
  generator: DigestTextGenerator,
  options: SynthesizeDigestOptions
): Promise<SynthesizedDigest> {
  const now = options.now ?? new Date();
  const runJudgment = options.runJudgment ?? true;
  const currentLongtermMergePressure = resolveMergePressure(
    snapshot.state.longtermMergePressure,
    countActiveClaims(snapshot.claims, "longterm"),
    options.stableLayerMergeTrigger,
    options.stableLayerMergeRelease
  );
  const currentAboutMergePressure = resolveMergePressure(
    snapshot.state.aboutMergePressure,
    countActiveClaims(snapshot.claims, "about"),
    options.stableLayerMergeTrigger,
    options.stableLayerMergeRelease
  );
  let requestedOperations: DigestOperation[] = [];
  if (runJudgment) {
    const generation = await generator.generate(
      createDigestJudgmentSystemPrompt({
        longtermMergePressure: currentLongtermMergePressure,
        aboutMergePressure: currentAboutMergePressure
      }),
      createDigestJudgmentUserPrompt(snapshot.claims, snapshot.newNotes, now),
      "digest_judgment"
    );
    requestedOperations = parseDigestJudgmentOutput(normalizeDigestTextGeneration(generation).text).ops;
  }

  const plan = planDigestOperations(snapshot.claims, requestedOperations, snapshot.newNotes, {
    promoteMinSpanDays: options.promoteMinSpanDays,
    runId: options.runId,
    now
  });
  const applied = applyDigestOperations(snapshot.claims, plan, snapshot.newNotes, {
    now,
    createClaimId: options.createClaimId ?? createDigestClaimId
  });
  const maintained = maintainDigestClaims(
    applied.claims,
    snapshot.deferredPromotions,
    applied.deferredRequests,
    {
      promoteMinSpanDays: options.promoteMinSpanDays,
      recentRetireWeeks: options.recentRetireWeeks,
      now
    }
  );
  const dirtyLayers = new Set([...applied.dirtyLayers, ...maintained.dirtyLayers]);
  const operations = [...applied.operations, ...maintained.appliedOperations];
  options.onPlanned?.({
    operations,
    skippedOperations: applied.skippedOperations,
    deferredEvents: maintained.deferredEvents
  });
  const prose = await renderDirtyDigestProse(
    snapshot.state.prose,
    maintained.claims,
    dirtyLayers,
    generator
  );
  const longtermMergePressure = resolveMergePressure(
    currentLongtermMergePressure,
    countActiveClaims(maintained.claims, "longterm"),
    options.stableLayerMergeTrigger,
    options.stableLayerMergeRelease
  );
  const aboutMergePressure = resolveMergePressure(
    currentAboutMergePressure,
    countActiveClaims(maintained.claims, "about"),
    options.stableLayerMergeTrigger,
    options.stableLayerMergeRelease
  );

  return {
    ...applied,
    operations,
    claims: maintained.claims,
    deferredPromotions: maintained.deferredPromotions,
    deferredEvents: maintained.deferredEvents,
    dirtyLayers,
    prose,
    longtermMergePressure,
    aboutMergePressure
  };
}

export async function seedDigest(
  pool: pg.Pool,
  input: DigestSeedInput,
  force = false,
  now = new Date()
) {
  const seed = digestSeedInputSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingResult = await client.query(
      `SELECT (
        EXISTS (SELECT 1 FROM digest_claims)
        OR EXISTS (SELECT 1 FROM digest_runs)
        OR EXISTS (SELECT 1 FROM digest_state WHERE id = $1 AND synthesized_at IS NOT NULL)
      ) AS has_existing`,
      [digestStateId]
    );
    const existingRow = z.object({ has_existing: z.boolean() }).parse(existingResult.rows[0]);
    if (existingRow.has_existing && !force) {
      throw new Error("Digest data already exists. Re-run digest-seed with --force to replace it.");
    }

    if (force) {
      await client.query("DELETE FROM digest_runs");
      await client.query("DELETE FROM digest_claims");
    }

    for (const claim of seed.claims) {
      const claimId = createDigestClaimId();
      await client.query(
        `INSERT INTO digest_claims (
          id, layer, text, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $4)`,
        [
          claimId,
          claim.layer,
          claim.text,
          now
        ]
      );
      const noteIds = uniqueNoteIds(claim.sampleNoteIds);
      if (noteIds.length > 0) {
        const notesResult = await client.query(
          "SELECT id, created_at FROM notes WHERE id = ANY($1::text[])",
          [noteIds]
        );
        if (notesResult.rows.length !== noteIds.length) {
          throw new Error(`Digest seed claim referenced missing notes: ${claim.text}`);
        }
        for (const row of notesResult.rows) {
          const note = z.object({ id: z.string(), created_at: z.coerce.date() }).parse(row);
          await client.query(
            `INSERT INTO digest_claim_evidence (claim_id, note_id, observed_at, source_kind)
            VALUES ($1, $2, $3, 'seed')
            ON CONFLICT (claim_id, note_id) DO NOTHING`,
            [claimId, note.id, note.created_at]
          );
        }
      }
    }

    const cursorResult = await client.query(
      `SELECT created_at, id
      FROM notes
      WHERE archived = FALSE
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
    );
    const cursorRow = cursorResult.rows[0]
      ? z.object({ created_at: z.coerce.date(), id: z.string() }).parse(cursorResult.rows[0])
      : null;
    const stateResult = await client.query(
      `UPDATE digest_state
        SET note_cursor = $2,
            note_cursor_id = $3,
            prose = $4,
            synthesized_at = $5,
            judgment_at = $5,
            longterm_merge_pressure = FALSE,
            about_merge_pressure = FALSE,
            refresh_started_at = NULL
        WHERE id = $1`,
      [digestStateId, cursorRow?.created_at ?? null, cursorRow?.id ?? null, seed.prose, now]
    );
    if (stateResult.rowCount !== 1) {
      throw new Error("Digest state row is missing. Run migrations before seeding digest.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    claimCount: seed.claims.length,
    synthesizedAt: now.toISOString()
  };
}

function createDigestJudgmentSystemPrompt(input: {
  longtermMergePressure: boolean;
  aboutMergePressure: boolean;
}) {
  const stableLayerPressureRules = [
    input.longtermMergePressure
      ? "longterm은 소프트캡 압력 상태다. 같은 레이어의 중복·종속 claim은 merge를 우선한다."
      : "longterm은 현재 소프트캡 압력 상태가 아니다.",
    input.aboutMergePressure
      ? "about은 소프트캡 압력 상태다. 설명력이 큰 부모 아래 지엽 성향을 합치는 merge를 우선한다."
      : "about은 현재 소프트캡 압력 상태가 아니다."
  ].join("\n");

  return `당신은 개인 메모리 digest 원장을 증분 갱신하는 판단기다. 표현용 prose는 다른 단계가 맡으므로 원장 operation만 결정한다.

레이어 정의: now=진행 중인 관심사·작업, recent=일단락된 최근 사건·성과, longterm=직업·환경·정체성 같은 안정적 사실, about=시간과 무관한 성향·취향·작업 방식 선호.

판단 계약:
1. 입력 노트는 어시스턴트 시점에서 기록되었으므로 claim은 사용자를 중심으로 서술한다.
2. 가치 우선순위는 모순·직접 정정에 따른 고침 > 새로운 확장 > 반복이다. 모순은 기존 claim의 revise 또는 retire로 먼저 해소한다. 새로운 확장은 기존 claim을 불리는 revise가 아니라 add로 반영한다.
3. claim은 단일 명제다. 서로 다른 사실·사건·성과를 한 claim에 나열하지 않으며, 문구는 150자 이내를 지향한다.
4. revise의 text 변경은 정정·압축·명료화 전용이다. 같은 주제라도 새로운 전개는 add, 순수 반복은 strengthen을 사용한다. 150자를 크게 넘는 claim을 만나면 핵심 명제 하나로 압축하는 revise를 검토한다.
5. 반복은 편집 가치가 0이어도 관측 가치가 있다. 같은 내용의 신규 노트는 add 대신 strengthen로 연결해 관측일을 보존한다.
6. 한 세션의 에코나 어시스턴트가 재진술한 파생 노트를 서로 독립된 성향으로 증식시키지 않는다.
7. longterm/about 진입은 promote만 사용한다. add는 now/recent에서 시작하고, revise의 레이어 이동도 now/recent 사이에서만 사용한다.
8. merge는 같은 레이어의 parent와 child 사이에서만 사용한다. 부모는 설명력이 넓은 claim으로 고르고 자식의 의미를 text에 보존한다.
9. lastObservedAt이 현재 시각보다 3주 이상 오래된 now claim은 recent로 옮기는 revise 또는 retire를 검토한다.
10. longterm/about claim의 retire는 신규 노트가 명백히 모순하거나 직접 정정하는 경우에 사용한다.
11. now/recent active claim 합계가 60개를 넘으면 새 add보다 같은 레이어의 merge와 불필요 claim retire를 우선한다.
12. 건강 등 민감 영역은 구체적인 사생활을 반복하지 않고 한 줄 수준으로 추상화한다.
13. noteIds에는 이번 입력의 신규 노트 id만 넣는다. 존재하는 claim 전체를 재출력하지 않고 실제 변화의 ops만 만든다.

${stableLayerPressureRules}

출력 JSON 스키마:
{
  "ops": [
    { "type": "add", "layer": "now|recent", "text": "string", "noteIds": ["note-id"] },
    { "type": "strengthen", "claimId": "claim-id", "noteIds": ["note-id"] },
    { "type": "revise", "claimId": "claim-id", "text": "optional string", "layer": "optional now|recent", "noteIds": ["optional note-id"] },
    { "type": "retire", "claimId": "claim-id" },
    { "type": "promote", "claimId": "claim-id", "layer": "longterm|about" },
    { "type": "merge", "parentClaimId": "claim-id", "childClaimIds": ["claim-id"], "text": "optional string" }
  ]
}

마크다운 코드 펜스, 설명, 주석 없이 JSON 객체 하나만 출력한다.`;
}

const digestRenderSystemPrompt = `당신은 확정된 개인 메모리 digest claim 원장을 prose로 렌더한다.

렌더 계약:
1. prose의 모든 내용은 입력된 active claim에서만 가져온다. 신규 노트, operation, 이전 prose는 문맥에 없으며 추측으로 보충하지 않는다.
2. 각 레이어 prose는 해당 레이어에 입력된 claim 전체를 종합한 완결된 교체본이다.
3. now는 무엇이 진행 중이고 어디까지 왔는지가 드러나는 상태 브리핑으로 쓴다.
4. recent와 longterm은 간결한 사실 서술로 쓴다.
5. about은 사실 나열보다 성향을 연결한 인물 초상으로 쓴다. 관측 스팬과 observedDays가 큰 성향을 중심에 두고 관측이 적은 지엽 취향은 변두리나 종속절에 둔다.
6. 각 prose 값은 800자 이하다.
7. 입력 layers에 있는 키만 같은 키의 문자열로 반환한다.
8. 마크다운 코드 펜스, 설명, 주석 없이 JSON 객체 하나만 출력한다.`;

const digestRepairSystemPrompt = `개인 메모리 digest 문장을 압축한다.

규칙:
1. 원문의 의미, 사실, 뉘앙스를 유지한다.
2. 반복과 군더더기만 줄여 ${digestProseTargetLength}자 이내로 만든다.
3. 문장을 중간에서 자르지 않는다.
4. 설명, 주석, 따옴표 없이 압축한 본문만 출력한다.`;

function createDigestJudgmentUserPrompt(claims: DigestClaim[], newNotes: DigestNote[], now: Date) {
  return JSON.stringify({
    currentTime: now.toISOString(),
    activeClaims: claims.filter((claim) => !claim.retiredAt).map(formatClaimForPrompt),
    newNotes: newNotes.map((note) => ({
      id: note.id,
      content: note.content,
      topic: note.topic,
      createdAt: note.createdAt
    }))
  });
}

function formatClaimForPrompt(claim: DigestClaim) {
  return {
    id: claim.id,
    layer: claim.layer,
    text: claim.text,
    ...getDigestClaimStats(claim)
  };
}

function parseDigestJudgmentOutput(outputText: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(outputText);
  } catch (error) {
    throw new Error("Digest judgment output was not valid JSON.", { cause: error });
  }
  return digestJudgmentOutputSchema.parse(parsedJson);
}

async function renderDirtyDigestProse(
  currentProse: DigestProse,
  claims: DigestClaim[],
  dirtyLayers: Set<DigestLayer>,
  generator: DigestTextGenerator
) {
  const mergedProse = { ...currentProse };
  const layersToRender: DigestLayer[] = [];
  for (const layer of digestLayers) {
    if (!dirtyLayers.has(layer)) {
      continue;
    }
    const activeClaims = claims.filter((claim) => !claim.retiredAt && claim.layer === layer);
    if (activeClaims.length === 0) {
      mergedProse[layer] = "";
      continue;
    }
    layersToRender.push(layer);
  }

  if (layersToRender.length > 0) {
    const generation = await generator.generate(
      digestRenderSystemPrompt,
      JSON.stringify({
        layers: Object.fromEntries(layersToRender.map((layer) => [
          layer,
          claims
            .filter((claim) => !claim.retiredAt && claim.layer === layer)
            .map(formatClaimForPrompt)
        ]))
      }),
      "digest_render"
    );
    const outputProse = parseDigestRenderOutput(normalizeDigestTextGeneration(generation).text);
    for (const layer of layersToRender) {
      const output = outputProse[layer];
      if (output === undefined) {
        throw new Error(`Digest render output omitted prose for dirty layer: ${layer}`);
      }
      mergedProse[layer] = output;
    }
    for (const layer of digestLayers) {
      if (!layersToRender.includes(layer) && outputProse[layer] !== undefined) {
        throw new Error(`Digest render output included an unrequested layer: ${layer}`);
      }
    }
  }

  return repairLongDigestProse(mergedProse, dirtyLayers, generator);
}

function parseDigestRenderOutput(outputText: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(outputText);
  } catch (error) {
    throw new Error("Digest render output was not valid JSON.", { cause: error });
  }
  return digestOutputProseSchema.parse(parsedJson);
}

async function repairLongDigestProse(
  prose: DigestProse,
  dirtyLayers: Set<DigestLayer>,
  generator: DigestTextGenerator
) {
  const repairedProse = { ...prose };
  for (const layer of digestLayers) {
    const original = repairedProse[layer];
    if (!dirtyLayers.has(layer) || original.length <= digestProseTargetLength) {
      continue;
    }
    repairedProse[layer] = await repairDigestProseLayer(layer, original, generator);
  }
  return digestProseSchema.parse(repairedProse);
}

async function repairDigestProseLayer(
  layer: DigestLayer,
  original: string,
  generator: DigestTextGenerator
) {
  const candidates = [original];
  let repairInput = original;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const generation = await generator.generate(
        digestRepairSystemPrompt,
        repairInput,
        "digest_repair"
      );
      const candidate = digestRepairTextSchema.parse(normalizeDigestTextGeneration(generation).text);
      candidates.push(candidate);
      if (candidate.length <= digestProseTargetLength) {
        return candidate;
      }
      repairInput = candidate;
    } catch (error) {
      logWarn("Digest prose repair call failed; the best complete candidate will be used.", {
        layer,
        attempt,
        error
      });
    }
  }

  const shortestCandidate = candidates.reduce((shortest, candidate) => (
    candidate.length < shortest.length ? candidate : shortest
  ));
  logWarn("Digest prose remained over the target length after repair.", {
    layer,
    targetLength: digestProseTargetLength,
    candidateLengths: candidates.map((candidate) => candidate.length),
    selectedLength: shortestCandidate.length
  });
  return shortestCandidate;
}

function normalizeDigestTextGeneration(generation: string | DigestTextGeneration): DigestTextGeneration {
  return typeof generation === "string" ? { text: generation } : generation;
}

export function createDigestTextGenerator(config: EnabledDigestConfig): DigestTextGenerator {
  if (config.provider === "anthropic") {
    const responseCapture = createLlmResponseCapture();
    const llm = new Llm({
      fetch: responseCapture.fetch,
      format: new AnthropicMessagesFormat({
        model: config.model,
        maxTokens: config.maxTokens
      }),
      provider: new AnthropicProvider({ apiKey: config.apiKey })
    });
    return {
      generate: async (systemPrompt, userPrompt) => {
        responseCapture.reset();
        try {
          const output = await llm.generate({
            messages: createDigestMessages(systemPrompt, userPrompt)
          });
          return createDigestTextGeneration(output);
        } catch (error) {
          throw new DigestTextGenerationError(error, responseCapture.getRawResponse());
        }
      }
    };
  }

  const responseCapture = createLlmResponseCapture();
  const provider = config.provider === "vercel"
    ? new VercelAIGatewayProvider({ apiKey: config.apiKey })
    : new OpenAIProvider({ apiKey: config.apiKey });
  const llm = new Llm({
    fetch: responseCapture.fetch,
    format: new OpenAIChatCompletionsFormat({ model: config.model }),
    provider
  });
  return {
    generate: async (systemPrompt, userPrompt) => {
      responseCapture.reset();
      try {
        const output = await llm.generate({
          messages: createDigestMessages(systemPrompt, userPrompt),
          options: { maxTokens: config.maxTokens }
        });
        return createDigestTextGeneration(output);
      } catch (error) {
        throw new DigestTextGenerationError(error, responseCapture.getRawResponse());
      }
    }
  };
}

class DigestTextGenerationError extends Error {
  constructor(cause: unknown, readonly raw: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "DigestTextGenerationError";
  }
}

function createLlmResponseCapture() {
  let rawResponse: unknown;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await fetch(input, init);
    return {
      body: response.body,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: async () => {
        const value: unknown = await response.json();
        rawResponse = value;
        return value;
      },
      text: async () => {
        const value = await response.text();
        rawResponse = parseJsonResponse(value);
        return value;
      }
    };
  };
  return {
    fetch: capturingFetch,
    reset: () => {
      rawResponse = undefined;
    },
    getRawResponse: () => rawResponse
  };
}

function parseJsonResponse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function createDigestTextGeneration(output: {
  message: { text: string };
  usage?: LlmUsage;
  raw: unknown;
  finishReason?: LlmFinishReason;
}): DigestTextGeneration {
  return {
    text: output.message.text,
    usage: output.usage,
    raw: output.raw,
    finishReason: output.finishReason
  };
}

function createLoggedDigestTextGenerator(
  pool: pg.Pool,
  config: EnabledDigestConfig,
  generator: DigestTextGenerator,
  runId: string
): DigestTextGenerator {
  const requestLogService = new LlmRequestLogService(pool);
  return {
    generate: async (systemPrompt, userPrompt, purpose = "digest_judgment") => {
      const requestedAt = new Date();
      const startedAt = Date.now();
      try {
        const generation = normalizeDigestTextGeneration(
          await generator.generate(systemPrompt, userPrompt, purpose)
        );
        const responseError = getDigestGenerationResponseError(generation);
        await recordLlmRequestSafely(requestLogService, {
          requestedAt,
          purpose,
          provider: config.provider,
          model: config.model,
          status: responseError ? "failed" : "succeeded",
          error: responseError,
          durationMs: Date.now() - startedAt,
          usage: extractLlmRequestUsage(config.provider, generation),
          runId
        });
        return generation;
      } catch (error) {
        const failedGeneration = extractFailedDigestTextGeneration(error);
        await recordLlmRequestSafely(requestLogService, {
          requestedAt,
          purpose,
          provider: config.provider,
          model: config.model,
          status: "failed",
          error: errorMessage(error),
          durationMs: Date.now() - startedAt,
          usage: extractLlmRequestUsage(config.provider, failedGeneration),
          runId
        });
        throw error;
      }
    }
  };
}

async function recordLlmRequestSafely(
  service: LlmRequestLogService,
  input: Parameters<LlmRequestLogService["recordRequest"]>[0]
) {
  try {
    await service.recordRequest(input);
  } catch (error) {
    // 비용 로그 장애가 digest 원장 갱신을 막으면 다음 자연 재시도까지 함께 잃게 된다.
    logWarn("Recording LLM request log failed; digest processing will continue.", { error });
  }
}

function getDigestGenerationResponseError(generation: DigestTextGeneration) {
  if (generation.finishReason === "length") {
    return "LLM response stopped because the token limit was reached.";
  }
  if (generation.text.trim().length === 0) {
    return "LLM response contained no text.";
  }
  return null;
}

export function extractLlmRequestUsage(
  provider: EnabledDigestConfig["provider"],
  generation: DigestTextGeneration
): LlmRequestUsage {
  const rawUsage = readRawUsage(generation.raw);
  const promptTokenDetails = readRecord(rawUsage, "prompt_tokens_details");
  // Vercel AI Gateway만 응답 usage에 실제 청구 USD를 넣으므로 다른 provider 비용은 사후 계산용 토큰만 보존한다.
  const costUsd = provider === "vercel" ? readFiniteNumber(rawUsage, "cost") : null;
  return {
    inputTokens: generation.usage?.inputTokens ?? readFiniteNumber(rawUsage, "prompt_tokens"),
    outputTokens: generation.usage?.outputTokens ?? readFiniteNumber(rawUsage, "completion_tokens"),
    totalTokens: generation.usage?.totalTokens ?? readFiniteNumber(rawUsage, "total_tokens"),
    cachedInputTokens: readFiniteNumber(promptTokenDetails, "cached_tokens")
      ?? generation.usage?.cacheReadInputTokens
      ?? null,
    cacheCreationInputTokens: readFiniteNumber(rawUsage, "cache_creation_input_tokens")
      ?? generation.usage?.cacheCreationInputTokens
      ?? null,
    costUsd,
    raw: rawUsage
  };
}

function extractFailedDigestTextGeneration(error: unknown): DigestTextGeneration {
  const output = readRecordValue(error, "output");
  return {
    text: "",
    usage: readNormalizedUsage(output) ?? readNormalizedUsage(error),
    raw: readRecordValue(output, "raw") ?? readFailureResponseBody(error) ?? readRecordValue(error, "raw")
  };
}

function readNormalizedUsage(value: unknown): LlmUsage | undefined {
  const usageValue = readRecordValue(value, "usage");
  if (!isRecord(usageValue)) {
    return undefined;
  }
  return {
    inputTokens: readOptionalFiniteNumber(usageValue, "inputTokens"),
    outputTokens: readOptionalFiniteNumber(usageValue, "outputTokens"),
    reasoningTokens: readOptionalFiniteNumber(usageValue, "reasoningTokens"),
    totalTokens: readOptionalFiniteNumber(usageValue, "totalTokens"),
    cacheReadInputTokens: readOptionalFiniteNumber(usageValue, "cacheReadInputTokens"),
    cacheCreationInputTokens: readOptionalFiniteNumber(usageValue, "cacheCreationInputTokens")
  };
}

function readFailureResponseBody(error: unknown) {
  const body = readRecordValue(error, "body");
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function readRawUsage(raw: unknown) {
  return readRecord(readRecordValue(raw, "usage"));
}

function readRecord(value: unknown, key?: string): Record<string, unknown> | null {
  const selectedValue = key && isRecord(value) ? value[key] : value;
  return isRecord(selectedValue) ? selectedValue : null;
}

function readRecordValue(value: unknown, key: string) {
  return isRecord(value) ? value[key] : undefined;
}

function readFiniteNumber(value: unknown, key: string) {
  const field = readRecordValue(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function readOptionalFiniteNumber(value: unknown, key: string) {
  return readFiniteNumber(value, key) ?? undefined;
}

function createDigestMessages(systemPrompt: string, userPrompt: string) {
  return [
    { role: "system" as const, content: [{ type: "text" as const, text: systemPrompt }] },
    { role: "user" as const, content: [{ type: "text" as const, text: userPrompt }] }
  ];
}

async function loadDigestSnapshot(pool: pg.Pool): Promise<DigestSnapshot> {
  const state = await getDigestState(pool);
  const [claims, newNotes, deferredPromotions] = await Promise.all([
    listActiveDigestClaims(pool),
    listNewDigestNotes(pool, state.noteCursorAt, state.noteCursorId),
    listDeferredPromotions(pool)
  ]);
  return { claims, state, newNotes, deferredPromotions };
}

async function getDigestState(executor: DigestQueryExecutor): Promise<DigestState> {
  const result = await executor.query(
    `SELECT
      id,
      note_cursor::text AS note_cursor,
      note_cursor_id,
      prose,
      synthesized_at,
      judgment_at,
      refresh_started_at,
      longterm_merge_pressure,
      about_merge_pressure
    FROM digest_state
    WHERE id = $1`,
    [digestStateId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Digest state row is missing. Run migrations before using digest.");
  }
  const state = digestStateRowSchema.parse(row);
  if ((state.note_cursor === null) !== (state.note_cursor_id === null)) {
    throw new Error("Digest cursor timestamp and id must both be null or both be present.");
  }
  return {
    noteCursorAt: state.note_cursor,
    noteCursorId: state.note_cursor_id,
    prose: state.prose,
    synthesizedAt: state.synthesized_at?.toISOString() ?? null,
    judgmentAt: state.judgment_at?.toISOString() ?? null,
    refreshStartedAt: state.refresh_started_at?.toISOString() ?? null,
    longtermMergePressure: state.longterm_merge_pressure,
    aboutMergePressure: state.about_merge_pressure
  };
}

async function listActiveDigestClaims(executor: DigestQueryExecutor): Promise<DigestClaim[]> {
  const result = await executor.query(
    `SELECT
      claims.id,
      claims.layer,
      claims.text,
      claims.created_at,
      claims.updated_at,
      claims.retired_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'note_id', evidence.note_id,
            'observed_at', evidence.observed_at,
            'source_kind', evidence.source_kind
          ) ORDER BY evidence.observed_at ASC, evidence.note_id ASC
        ) FILTER (WHERE evidence.note_id IS NOT NULL),
        '[]'::jsonb
      ) AS evidence
    FROM digest_claims AS claims
    LEFT JOIN digest_claim_evidence AS evidence ON evidence.claim_id = claims.id
    WHERE claims.retired_at IS NULL
    GROUP BY claims.id
    ORDER BY claims.created_at ASC, claims.id ASC`
  );
  return result.rows.map((row) => mapDigestClaimRow(row));
}

async function listNewDigestNotes(
  executor: DigestQueryExecutor,
  noteCursorAt: string | null,
  noteCursorId: string | null
): Promise<DigestNote[]> {
  const result = await executor.query(
    `SELECT id, content, topic, created_at
      FROM notes
      WHERE archived = FALSE
        AND (
          $1::timestamptz IS NULL
          OR (created_at, id) > ($1::timestamptz, $2::text)
        )
      ORDER BY created_at ASC, id ASC`,
    [noteCursorAt, noteCursorId]
  );
  return result.rows.map((row) => {
    const note = digestNoteRowSchema.parse(row);
    return {
      id: note.id,
      content: note.content,
      topic: note.topic,
      createdAt: note.created_at.toISOString()
    };
  });
}

export async function countNewDigestNotes(
  executor: DigestQueryExecutor,
  noteCursorAt: string | null,
  noteCursorId: string | null
) {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS new_note_count
      FROM notes
      WHERE archived = FALSE
        AND (
          $1::timestamptz IS NULL
          OR (created_at, id) > ($1::timestamptz, $2::text)
        )`,
    [noteCursorAt, noteCursorId]
  );
  const row = z.object({ new_note_count: z.coerce.number().int().nonnegative() }).parse(result.rows[0]);
  return row.new_note_count;
}

async function listDeferredPromotions(executor: DigestQueryExecutor) {
  const result = await executor.query(
    `SELECT claim_id, target_layer, requested_at, run_id, reason
    FROM digest_deferred_promotions
    ORDER BY requested_at ASC, claim_id ASC`
  );
  const rowSchema = z.object({
    claim_id: z.string(),
    target_layer: z.enum(["longterm", "about"]),
    requested_at: z.coerce.date(),
    run_id: z.string(),
    reason: z.string()
  });
  return result.rows.map((row): DigestDeferredPromotion => {
    const deferred = rowSchema.parse(row);
    return {
      claimId: deferred.claim_id,
      targetLayer: deferred.target_layer,
      requestedAt: deferred.requested_at.toISOString(),
      runId: deferred.run_id,
      reason: deferred.reason
    };
  });
}

async function hasDigestMaintenanceWork(
  executor: DigestQueryExecutor,
  config: EnabledDigestConfig,
  now: Date
) {
  const result = await executor.query(
    `SELECT (
      EXISTS (
        SELECT 1
        FROM digest_deferred_promotions AS deferred
        JOIN digest_claims AS claims ON claims.id = deferred.claim_id
        LEFT JOIN digest_claim_evidence AS evidence ON evidence.claim_id = claims.id
        GROUP BY deferred.claim_id, claims.layer, claims.retired_at
        HAVING claims.retired_at IS NOT NULL
          OR claims.layer IN ('longterm', 'about')
          OR MAX(evidence.observed_at) - MIN(evidence.observed_at) >= make_interval(days => $1)
      )
      OR EXISTS (
        SELECT 1
        FROM digest_claims AS claims
        JOIN digest_claim_evidence AS evidence ON evidence.claim_id = claims.id
        LEFT JOIN digest_deferred_promotions AS deferred ON deferred.claim_id = claims.id
        WHERE claims.retired_at IS NULL
          AND claims.layer = 'recent'
          AND deferred.claim_id IS NULL
        GROUP BY claims.id
        HAVING MAX(evidence.observed_at) <= $2::timestamptz - make_interval(weeks => $3)
      )
    ) AS has_maintenance_work`,
    [config.promoteMinSpanDays, now, config.recentRetireWeeks]
  );
  return z.object({ has_maintenance_work: z.boolean() }).parse(result.rows[0]).has_maintenance_work;
}

async function acquireDigestRefreshLock(executor: DigestQueryExecutor) {
  // JS가 DB의 microsecond timestamp를 millisecond로 잘라 되돌리는 일을 피하려고 처음부터 JS 시각을 lock token으로 저장한다.
  const lockStartedAt = new Date();
  const result = await executor.query(
    `UPDATE digest_state
      SET refresh_started_at = $3
      WHERE id = $1
        AND (
          refresh_started_at IS NULL
          OR refresh_started_at < now() - ($2 * interval '1 minute')
        )
      RETURNING refresh_started_at`,
    [digestStateId, digestRefreshLockTimeoutMinutes, lockStartedAt]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return lockStartedAt;
}

async function releaseDigestRefreshLock(executor: DigestQueryExecutor, lockStartedAt: Date) {
  await executor.query(
    `UPDATE digest_state
      SET refresh_started_at = NULL
      WHERE id = $1 AND refresh_started_at = $2`,
    [digestStateId, lockStartedAt]
  );
}

async function persistSuccessfulDigestRun(
  pool: pg.Pool,
  snapshot: DigestSnapshot,
  synthesized: SynthesizedDigest,
  lockStartedAt: Date,
  now: Date,
  runId: string,
  runKind: "synthesis" | "maintenance"
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await persistDigestClaims(client, synthesized.claims);
    await persistDeferredPromotions(client, synthesized.deferredPromotions);
    const lastProcessedNote = runKind === "synthesis"
      ? snapshot.newNotes[snapshot.newNotes.length - 1]
      : undefined;
    if (runKind === "synthesis" && !lastProcessedNote) {
      throw new Error("Digest synthesis run cannot advance an empty note batch.");
    }
    const stateResult = await client.query(
      `UPDATE digest_state
        SET note_cursor = $2,
            note_cursor_id = $3,
            prose = $4,
            synthesized_at = $5,
            judgment_at = CASE WHEN $8::boolean THEN $5 ELSE judgment_at END,
            longterm_merge_pressure = $6,
            about_merge_pressure = $7,
            refresh_started_at = NULL
        WHERE id = $1 AND refresh_started_at = $9
        RETURNING id`,
      [
        digestStateId,
        lastProcessedNote?.createdAt ?? snapshot.state.noteCursorAt,
        lastProcessedNote?.id ?? snapshot.state.noteCursorId,
        synthesized.prose,
        now,
        synthesized.longtermMergePressure,
        synthesized.aboutMergePressure,
        runKind === "synthesis",
        lockStartedAt
      ]
    );
    if (stateResult.rows.length === 0) {
      throw new Error("Digest refresh lock expired before the synthesized result could be stored.");
    }
    await insertDigestRun(client, {
      operations: synthesized.operations,
      skippedOperations: synthesized.skippedOperations,
      deferredEvents: synthesized.deferredEvents,
      claimTexts: collectDigestRunClaimTexts(snapshot.claims, {
        operations: synthesized.operations,
        skippedOperations: synthesized.skippedOperations,
        deferredEvents: synthesized.deferredEvents
      }),
      proseSnapshot: synthesized.prose,
      newNoteCount: runKind === "synthesis" ? snapshot.newNotes.length : 0,
      status: "succeeded",
      error: null,
      runAt: now,
      runId,
      runKind
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistDigestClaims(executor: DigestQueryExecutor, claims: DigestClaim[]) {
  for (const claim of claims) {
    await executor.query(
      `INSERT INTO digest_claims (
        id, layer, text, created_at, updated_at, retired_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        layer = EXCLUDED.layer,
        text = EXCLUDED.text,
        updated_at = EXCLUDED.updated_at,
        retired_at = EXCLUDED.retired_at`,
      [
        claim.id,
        claim.layer,
        claim.text,
        claim.createdAt,
        claim.updatedAt,
        claim.retiredAt
      ]
    );
    await executor.query("DELETE FROM digest_claim_evidence WHERE claim_id = $1", [claim.id]);
    for (const evidence of claim.evidence) {
      await executor.query(
        `INSERT INTO digest_claim_evidence (claim_id, note_id, observed_at, source_kind)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (claim_id, note_id) DO NOTHING`,
        [claim.id, evidence.noteId, evidence.observedAt, evidence.sourceKind]
      );
    }
  }
}

async function persistDeferredPromotions(
  executor: DigestQueryExecutor,
  deferredPromotions: DigestDeferredPromotion[]
) {
  await executor.query("DELETE FROM digest_deferred_promotions");
  for (const deferred of deferredPromotions) {
    await executor.query(
      `INSERT INTO digest_deferred_promotions (
        claim_id, target_layer, requested_at, run_id, reason
      ) VALUES ($1, $2, $3, $4, $5)`,
      [deferred.claimId, deferred.targetLayer, deferred.requestedAt, deferred.runId, deferred.reason]
    );
  }
}

async function recordFailedDigestRun(
  executor: DigestQueryExecutor,
  claims: DigestClaim[],
  operations: DigestOperation[],
  skippedOperations: DigestSkippedOperation[],
  deferredEvents: DigestDeferredEvent[],
  proseSnapshot: DigestProse,
  newNoteCount: number,
  lockStartedAt: Date,
  error: unknown,
  now: Date,
  runId: string,
  runKind: "synthesis" | "maintenance"
) {
  await insertDigestRun(executor, {
    operations,
    skippedOperations,
    deferredEvents,
    claimTexts: collectDigestRunClaimTexts(claims, { operations, skippedOperations, deferredEvents }),
    proseSnapshot,
    newNoteCount,
    status: "failed",
    error: errorMessage(error),
    runAt: now,
    runId,
    runKind
  });
  await releaseDigestRefreshLock(executor, lockStartedAt);
}

type DigestRunClaimText = {
  claimId: string;
  text: string;
};

// run이 id로만 참조하는 claim의 문구를 pre-run 원장에서 스냅샷한다. revise 이후의 새
// 문구는 op 자체에 있으므로, 히스토리가 사후 수정에 오염되지 않으려면 op가 겨냥한
// 당시 문구를 보존해야 한다.
function collectDigestRunClaimTexts(
  claims: DigestClaim[],
  run: {
    operations: DigestOperation[];
    skippedOperations: DigestSkippedOperation[];
    deferredEvents: DigestDeferredEvent[];
  }
): DigestRunClaimText[] {
  const textsByClaimId = new Map(claims.map((claim) => [claim.id, claim.text]));
  const referencedClaimIds = new Set([
    ...run.operations.flatMap(digestOperationClaimIds),
    ...run.skippedOperations.flatMap((skipped) => digestOperationClaimIds(skipped.operation)),
    ...run.deferredEvents.map((event) => event.claimId)
  ]);
  const claimTexts: DigestRunClaimText[] = [];
  for (const claimId of [...referencedClaimIds].sort()) {
    const text = textsByClaimId.get(claimId);
    // 원장에 없는 claim을 겨냥해 스킵된 op(claim_not_active 등)는 관측할 문구 자체가 없다.
    if (text !== undefined) {
      claimTexts.push({ claimId, text });
    }
  }
  return claimTexts;
}

async function insertDigestRun(executor: DigestQueryExecutor, input: {
  operations: DigestOperation[];
  skippedOperations: DigestSkippedOperation[];
  deferredEvents: DigestDeferredEvent[];
  claimTexts: DigestRunClaimText[];
  proseSnapshot: DigestProse;
  newNoteCount: number;
  status: "succeeded" | "failed";
  error: string | null;
  runAt: Date;
  runId: string;
  runKind: "synthesis" | "maintenance";
}) {
  // run 행과 claim 스냅샷이 따로 커밋되면 중간 실패 시 감사 기록이 반쪽만 남는다.
  // 실패 경로는 트랜잭션 없이 pool로 직접 기록하므로, 한 문장(CTE)으로 묶어 원자성을 얻는다.
  await executor.query(
    `WITH inserted_run AS (
      INSERT INTO digest_runs (
        id, run_at, ops, skipped_operations, deferred_events, prose_snapshot,
        new_note_count, status, error, run_kind
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    )
    INSERT INTO digest_run_claim_texts (run_id, claim_id, text)
    SELECT $1, entries.claim_id, entries.text
    FROM jsonb_to_recordset($11::jsonb) AS entries(claim_id TEXT, text TEXT)`,
    [
      input.runId,
      input.runAt,
      JSON.stringify(input.operations),
      JSON.stringify(input.skippedOperations),
      JSON.stringify(input.deferredEvents),
      input.proseSnapshot,
      input.newNoteCount,
      input.status,
      input.error,
      input.runKind,
      JSON.stringify(input.claimTexts.map((claimText) => ({
        claim_id: claimText.claimId,
        text: claimText.text
      })))
    ]
  );
}

function mapDigestClaimRow(row: pg.QueryResultRow): DigestClaim {
  const claim = digestClaimRowSchema.parse(row);
  return {
    id: claim.id,
    layer: claim.layer,
    text: claim.text,
    evidence: claim.evidence.map((evidence): DigestEvidence => ({
      noteId: evidence.note_id,
      observedAt: evidence.observed_at.toISOString(),
      sourceKind: evidence.source_kind
    })),
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
    retiredAt: claim.retired_at?.toISOString() ?? null
  };
}

function uniqueNoteIds(noteIds: string[]) {
  return [...new Set(noteIds)];
}

function countActiveClaims(claims: DigestClaim[], layer: DigestLayer) {
  return claims.filter((claim) => !claim.retiredAt && claim.layer === layer).length;
}

function hasDigestChanges(synthesized: SynthesizedDigest) {
  return synthesized.operations.length > 0
    || synthesized.deferredEvents.some((event) => event.action !== "retained")
    || synthesized.dirtyLayers.size > 0;
}

function createDigestClaimId() {
  return `D${randomUUID()}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

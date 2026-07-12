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

const digestStateId = "singleton";
const digestRefreshLockTimeoutMinutes = 10;
export const digestProseTargetLength = 800;
export const digestProseHardMaxLength = 1200;

export const digestLayers = ["now", "recent", "longterm", "about"] as const;
export const digestLayerSchema = z.enum(digestLayers);

export const digestProseSchema = z.object({
  now: z.string().max(digestProseHardMaxLength),
  recent: z.string().max(digestProseHardMaxLength),
  longterm: z.string().max(digestProseHardMaxLength),
  about: z.string().max(digestProseHardMaxLength)
}).strict();

const digestOutputProseSchema = z.object({
  now: z.string().max(digestProseHardMaxLength).optional(),
  recent: z.string().max(digestProseHardMaxLength).optional(),
  longterm: z.string().max(digestProseHardMaxLength).optional(),
  about: z.string().max(digestProseHardMaxLength).optional()
}).strict();

const digestRepairTextSchema = z.string().trim().min(1);

const digestNoteIdsSchema = z.array(z.string().min(1)).min(1);

const addDigestOperationSchema = z.object({
  type: z.literal("add"),
  layer: digestLayerSchema,
  text: z.string().min(1),
  noteIds: digestNoteIdsSchema
}).strict();

const strengthenDigestOperationSchema = z.object({
  type: z.literal("strengthen"),
  claimId: z.string().min(1),
  noteIds: digestNoteIdsSchema
}).strict();

const reviseDigestOperationSchema = z.object({
  type: z.literal("revise"),
  claimId: z.string().min(1),
  text: z.string().min(1).optional(),
  layer: digestLayerSchema.optional(),
  noteIds: digestNoteIdsSchema.optional()
}).strict().refine(
  (operation) => operation.text !== undefined || operation.layer !== undefined || operation.noteIds !== undefined,
  "revise must change text, layer, or evidence."
);

const retireDigestOperationSchema = z.object({
  type: z.literal("retire"),
  claimId: z.string().min(1)
}).strict();

export const digestOperationSchema = z.union([
  addDigestOperationSchema,
  strengthenDigestOperationSchema,
  reviseDigestOperationSchema,
  retireDigestOperationSchema
]);

export const digestLlmOutputSchema = z.object({
  ops: z.array(digestOperationSchema),
  prose: digestOutputProseSchema
}).strict();

const digestStateRowSchema = z.object({
  id: z.literal(digestStateId),
  note_cursor: z.string().nullable(),
  prose: digestProseSchema,
  synthesized_at: z.coerce.date().nullable(),
  refresh_started_at: z.coerce.date().nullable()
});

const digestClaimRowSchema = z.object({
  id: z.string(),
  layer: digestLayerSchema,
  text: z.string(),
  evidence_count: z.coerce.number().int().positive(),
  sample_note_ids: z.array(z.string()),
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
    text: z.string().min(1),
    evidenceCount: z.number().int().positive(),
    sampleNoteIds: z.array(z.string().min(1))
  }).strict()),
  prose: digestProseSchema
}).strict();

export type DigestLayer = z.infer<typeof digestLayerSchema>;
export type DigestProse = z.infer<typeof digestProseSchema>;
export type DigestOperation = z.infer<typeof digestOperationSchema>;
export type DigestSeedInput = z.infer<typeof digestSeedInputSchema>;

export type DigestClaim = {
  id: string;
  layer: DigestLayer;
  text: string;
  evidenceCount: number;
  sampleNoteIds: string[];
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type DigestState = {
  noteCursor: string | null;
  prose: DigestProse;
  synthesizedAt: string | null;
  refreshStartedAt: string | null;
};

export type DigestNote = {
  id: string;
  content: string;
  topic: string | null;
  createdAt: string;
};

export type DigestSnapshot = {
  claims: DigestClaim[];
  state: DigestState;
  newNotes: DigestNote[];
};

export type DigestLlmPurpose = "digest_synthesis" | "digest_repair";

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

type ApplyDigestOperationsOptions = {
  now?: Date;
  createClaimId?: () => string;
  onSkippedOperation?: (operation: DigestOperation) => void;
};

type AppliedDigestOperations = {
  claims: DigestClaim[];
  dirtyLayers: Set<DigestLayer>;
  skippedOperations: DigestOperation[];
};

type SynthesizedDigest = AppliedDigestOperations & {
  operations: DigestOperation[];
  prose: DigestProse;
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

    const newNoteCount = await countNewDigestNotes(this.pool, state.noteCursor);
    return formatDigestSection(state.prose, state.synthesizedAt, newNoteCount);
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
    const initialNewNoteCount = await countNewDigestNotes(this.pool, initialState.noteCursor);
    const now = new Date();
    if (!shouldRefreshDigest({
      newNoteCount: initialNewNoteCount,
      synthesizedAt: initialState.synthesizedAt,
      immediateNotes: this.config.immediateNotes,
      minIntervalHours: this.config.minIntervalHours,
      now
    })) {
      return;
    }

    const lockStartedAt = await acquireDigestRefreshLock(this.pool);
    if (!lockStartedAt) {
      logInfo("Digest refresh skipped because another process holds the lock.");
      return;
    }

    let operations: DigestOperation[] = [];
    let snapshot: DigestSnapshot | undefined;
    const runId = randomUUID();
    try {
      snapshot = await loadDigestSnapshot(this.pool);
      if (snapshot.newNotes.length === 0) {
        await releaseDigestRefreshLock(this.pool, lockStartedAt);
        return;
      }

      const synthesized = await synthesizeDigestSnapshot(
        snapshot,
        createLoggedDigestTextGenerator(this.pool, this.config, this.generator, runId),
        now,
        (operation) => logWarn("Digest operation referenced a missing claim and was skipped.", {
          operationType: operation.type,
          claimId: "claimId" in operation ? operation.claimId : undefined
        })
      );
      operations = synthesized.operations;
      await persistSuccessfulDigestRun(this.pool, snapshot, synthesized, lockStartedAt, now, runId);
      logInfo("Digest refresh completed.", {
        newNoteCount: snapshot.newNotes.length,
        operationCount: operations.length,
        dirtyLayers: [...synthesized.dirtyLayers]
      });
    } catch (error) {
      const proseSnapshot = snapshot ? snapshot.state.prose : initialState.prose;
      const newNoteCount = snapshot ? snapshot.newNotes.length : initialNewNoteCount;
      try {
        await recordFailedDigestRun(
          this.pool,
          operations,
          proseSnapshot,
          newNoteCount,
          lockStartedAt,
          error,
          now,
          runId
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

export function formatDigestSection(prose: DigestProse, synthesizedAt: string, newNoteCount: number) {
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
  const header = `━━━ digest (${synthesizedDate.toISOString().slice(0, 10)} 합성 · 이후 신규 노트 ${newNoteCount}개 미반영) ━━━`;
  return `${header}\n${sections.join("\n\n")}`;
}

export function applyDigestOperations(
  claims: DigestClaim[],
  operations: DigestOperation[],
  options: ApplyDigestOperationsOptions = {}
): AppliedDigestOperations {
  const now = options.now ?? new Date();
  const nowTimestamp = now.toISOString();
  const createClaimId = options.createClaimId ?? createDigestClaimId;
  const copiedClaims = claims.map((claim) => ({
    ...claim,
    sampleNoteIds: [...claim.sampleNoteIds]
  }));
  const claimsById = new Map(copiedClaims.map((claim) => [claim.id, claim]));
  const dirtyLayers = new Set<DigestLayer>();
  const skippedOperations: DigestOperation[] = [];

  for (const operation of operations) {
    if (operation.type === "add") {
      const noteIds = uniqueNoteIds(operation.noteIds);
      const claim: DigestClaim = {
        id: createClaimId(),
        layer: operation.layer,
        text: operation.text,
        evidenceCount: noteIds.length,
        sampleNoteIds: capSampleNoteIds([], noteIds),
        createdAt: nowTimestamp,
        updatedAt: nowTimestamp,
        retiredAt: null
      };
      copiedClaims.push(claim);
      claimsById.set(claim.id, claim);
      dirtyLayers.add(operation.layer);
      continue;
    }

    const claim = claimsById.get(operation.claimId);
    if (!claim || claim.retiredAt) {
      skippedOperations.push(operation);
      options.onSkippedOperation?.(operation);
      continue;
    }

    if (operation.type === "strengthen") {
      const noteIds = uniqueNoteIds(operation.noteIds);
      claim.evidenceCount += noteIds.length;
      claim.sampleNoteIds = capSampleNoteIds(claim.sampleNoteIds, noteIds);
      claim.updatedAt = nowTimestamp;
      // strengthen은 근거 카운트만 늘리고 프로즈 내용은 불변이라 재렌더 대상이 아니다.
      // dirty로 취급하면 LLM이 (올바르게) prose를 생략했을 때 run 전체가 실패한다 — 첫 실전 합성에서 실증.
      continue;
    }

    if (operation.type === "revise") {
      const previousLayer = claim.layer;
      if (operation.text !== undefined) {
        claim.text = operation.text;
      }
      if (operation.layer !== undefined) {
        claim.layer = operation.layer;
      }
      if (operation.noteIds !== undefined) {
        const noteIds = uniqueNoteIds(operation.noteIds);
        claim.evidenceCount += noteIds.length;
        claim.sampleNoteIds = capSampleNoteIds(claim.sampleNoteIds, noteIds);
      }
      claim.updatedAt = nowTimestamp;
      if (operation.text !== undefined || operation.layer !== undefined) {
        dirtyLayers.add(previousLayer);
        dirtyLayers.add(claim.layer);
      }
      continue;
    }

    claim.retiredAt = nowTimestamp;
    claim.updatedAt = nowTimestamp;
    dirtyLayers.add(claim.layer);
  }

  return {
    claims: copiedClaims,
    dirtyLayers,
    skippedOperations
  };
}

export async function synthesizeDigestSnapshot(
  snapshot: DigestSnapshot,
  generator: DigestTextGenerator,
  now = new Date(),
  onSkippedOperation?: (operation: DigestOperation) => void
): Promise<SynthesizedDigest> {
  const generation = await generator.generate(
    digestSystemPrompt,
    createDigestUserPrompt(snapshot.claims, snapshot.newNotes, now),
    "digest_synthesis"
  );
  const parsedOutput = parseDigestLlmOutput(normalizeDigestTextGeneration(generation).text);
  const applied = applyDigestOperations(snapshot.claims, parsedOutput.ops, {
    now,
    onSkippedOperation
  });
  const mergedProse = mergeDirtyDigestProse(snapshot.state.prose, parsedOutput.prose, applied.dirtyLayers);
  const prose = await repairLongDigestProse(mergedProse, applied.dirtyLayers, generator);

  return {
    ...applied,
    operations: parsedOutput.ops,
    prose
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
      await client.query(
        `INSERT INTO digest_claims (
          id, layer, text, evidence_count, sample_note_ids, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [
          createDigestClaimId(),
          claim.layer,
          claim.text,
          claim.evidenceCount,
          capSampleNoteIds([], uniqueNoteIds(claim.sampleNoteIds)),
          now
        ]
      );
    }

    const stateResult = await client.query(
      `UPDATE digest_state
        SET note_cursor = (SELECT MAX(created_at) FROM notes WHERE archived = FALSE),
            prose = $2,
            synthesized_at = $3,
            refresh_started_at = NULL
        WHERE id = $1`,
      [digestStateId, seed.prose, now]
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

const digestSystemPrompt = `당신은 개인 메모리 digest 원장을 증분 갱신하는 합성기다.

레이어 정의: now=진행 중인 관심사·작업, recent=일단락된 최근 사건·성과, longterm=직업·환경·정체성 같은 안정적 사실, about=시간과 무관한 성향·취향·작업 방식 선호.

prose 스타일: now는 상태 브리핑으로 쓴다 — 무엇이 진행 중이고 어디까지 왔고 다음이 무엇인지. about은 사실 나열이 아닌 인물 초상으로 쓴다 — 성향을 서로 연결하고 왜 그런지가 드러나게. recent와 longterm은 간결한 사실 서술로 쓴다.

규칙:
1. 입력 노트는 어시스턴트 시점에서 기록되었으므로, digest와 claim은 항상 사용자를 중심으로 서술한다.
2. 신규 노트가 기존 claim과 같은 내용이면 add를 만들지 말고 strengthen를 사용한다.
3. updatedAt이 현재 시각보다 3주 이상 오래된 now claim은 recent로 강등하는 revise를 만들거나 retire한다.
4. active claim이 60개를 넘으면 새 claim 추가보다 기존 claim 병합을 위한 revise와 retire를 우선한다.
5. 건강 등 민감 영역은 구체적인 사생활을 반복하지 말고 한 줄 수준으로 추상화한다.
6. prose는 내용이 실제로 바뀌는 레이어만 넣는다 — add, retire, 텍스트나 레이어를 바꾸는 revise가 있는 레이어. prose 값은 해당 레이어의 기존 프로즈를 통째로 대체한다. strengthen이나 noteIds만 추가하는 revise만 있으면 그 레이어의 prose는 다시 쓰지 않는다. revise로 레이어가 이동하면 이전/새 레이어를 모두 넣는다. 각 prose 값은 800자 이하다.
7. add의 noteIds, strengthen의 noteIds, revise의 선택적 noteIds에는 근거가 된 신규 노트 id만 넣는다. noteIds는 오래된 것부터 최신 순서로 둔다.
8. 존재하는 claim을 그대로 다시 출력하지 않는다. 원장 전체를 재작성하지 않고 아래 JSON 스키마의 ops만 출력한다.
9. 마크다운 코드 펜스, 설명, 주석 없이 지정된 JSON 객체 하나만 출력한다.

출력 JSON 스키마:
{
  "ops": [
    { "type": "add", "layer": "now|recent|longterm|about", "text": "string", "noteIds": ["note-id"] },
    { "type": "strengthen", "claimId": "claim-id", "noteIds": ["note-id"] },
    { "type": "revise", "claimId": "claim-id", "text": "optional string", "layer": "optional now|recent|longterm|about", "noteIds": ["optional note-id"] },
    { "type": "retire", "claimId": "claim-id" }
  ],
  "prose": {
    "now": "dirty일 때만 optional string",
    "recent": "dirty일 때만 optional string",
    "longterm": "dirty일 때만 optional string",
    "about": "dirty일 때만 optional string"
  }
}`;

const digestRepairSystemPrompt = `개인 메모리 digest 문장을 압축한다.

규칙:
1. 원문의 의미, 사실, 뉘앙스를 유지한다.
2. 반복과 군더더기만 줄여 ${digestProseTargetLength}자 이내로 만든다.
3. 문장을 중간에서 자르지 않는다.
4. 설명, 주석, 따옴표 없이 압축한 본문만 출력한다.`;

function createDigestUserPrompt(claims: DigestClaim[], newNotes: DigestNote[], now: Date) {
  // sampleNoteIds·createdAt·정밀 타임스탬프는 모델이 참조할 일이 없는 토큰 무게라 프롬프트에서 뺀다
  // — ops의 noteIds는 신규 노트 id만 허용(규칙 7)하고, 시간 판단(규칙 3)은 날짜 단위면 충분하다.
  return JSON.stringify({
    currentTime: toDigestPromptDate(now.toISOString()),
    activeClaims: claims.map((claim) => ({
      id: claim.id,
      layer: claim.layer,
      text: claim.text,
      evidenceCount: claim.evidenceCount,
      updatedAt: toDigestPromptDate(claim.updatedAt)
    })),
    newNotes: newNotes.map((note) => ({
      id: note.id,
      content: note.content,
      topic: note.topic,
      createdAt: toDigestPromptDate(note.createdAt)
    }))
  });
}

function toDigestPromptDate(timestamp: string) {
  return timestamp.slice(0, 10);
}

function parseDigestLlmOutput(outputText: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(outputText);
  } catch (error) {
    throw new Error("Digest LLM output was not valid JSON.", { cause: error });
  }
  return digestLlmOutputSchema.parse(parsedJson);
}

function mergeDirtyDigestProse(
  currentProse: DigestProse,
  outputProse: z.infer<typeof digestOutputProseSchema>,
  dirtyLayers: Set<DigestLayer>
) {
  const mergedProse = { ...currentProse };
  for (const layer of digestLayers) {
    const output = outputProse[layer];
    if (dirtyLayers.has(layer)) {
      if (output === undefined) {
        throw new Error(`Digest LLM output omitted prose for dirty layer: ${layer}`);
      }
      mergedProse[layer] = output;
    } else if (output !== undefined) {
      logWarn("Digest LLM output included prose for a clean layer; it was ignored.", { layer });
    }
  }
  return mergedProse;
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
    generate: async (systemPrompt, userPrompt, purpose = "digest_synthesis") => {
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
  const [claims, newNotes] = await Promise.all([
    listActiveDigestClaims(pool),
    listNewDigestNotes(pool, state.noteCursor)
  ]);
  return { claims, state, newNotes };
}

async function getDigestState(executor: DigestQueryExecutor): Promise<DigestState> {
  const result = await executor.query(
    `SELECT
      id,
      note_cursor::text AS note_cursor,
      prose,
      synthesized_at,
      refresh_started_at
    FROM digest_state
    WHERE id = $1`,
    [digestStateId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Digest state row is missing. Run migrations before using digest.");
  }
  const state = digestStateRowSchema.parse(row);
  return {
    noteCursor: state.note_cursor,
    prose: state.prose,
    synthesizedAt: state.synthesized_at?.toISOString() ?? null,
    refreshStartedAt: state.refresh_started_at?.toISOString() ?? null
  };
}

async function listActiveDigestClaims(executor: DigestQueryExecutor): Promise<DigestClaim[]> {
  const result = await executor.query(
    "SELECT * FROM digest_claims WHERE retired_at IS NULL ORDER BY created_at ASC, id ASC"
  );
  return result.rows.map((row) => mapDigestClaimRow(row));
}

async function listNewDigestNotes(executor: DigestQueryExecutor, noteCursor: string | null): Promise<DigestNote[]> {
  const result = await executor.query(
    `SELECT id, content, topic, created_at
      FROM notes
      WHERE archived = FALSE
        AND ($1::timestamptz IS NULL OR created_at > $1)
      ORDER BY created_at ASC, id ASC`,
    [noteCursor]
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

export async function countNewDigestNotes(executor: DigestQueryExecutor, noteCursor: string | null) {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS new_note_count
      FROM notes
      WHERE archived = FALSE
        AND ($1::timestamptz IS NULL OR created_at > $1)`,
    [noteCursor]
  );
  const row = z.object({ new_note_count: z.coerce.number().int().nonnegative() }).parse(result.rows[0]);
  return row.new_note_count;
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
  runId: string
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await persistDigestClaims(client, synthesized.claims);
    const stateResult = await client.query(
      `UPDATE digest_state
        SET note_cursor = (
              SELECT MAX(created_at)
              FROM notes
              WHERE id = ANY($2::text[])
            ),
            prose = $3,
            synthesized_at = $4,
            refresh_started_at = NULL
        WHERE id = $1 AND refresh_started_at = $5
        RETURNING id`,
      [
        digestStateId,
        snapshot.newNotes.map((note) => note.id),
        synthesized.prose,
        now,
        lockStartedAt
      ]
    );
    if (stateResult.rows.length === 0) {
      throw new Error("Digest refresh lock expired before the synthesized result could be stored.");
    }
    await insertDigestRun(client, {
      operations: synthesized.operations,
      proseSnapshot: synthesized.prose,
      newNoteCount: snapshot.newNotes.length,
      status: "succeeded",
      error: null,
      runAt: now,
      runId
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
        id, layer, text, evidence_count, sample_note_ids, created_at, updated_at, retired_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        layer = EXCLUDED.layer,
        text = EXCLUDED.text,
        evidence_count = EXCLUDED.evidence_count,
        sample_note_ids = EXCLUDED.sample_note_ids,
        updated_at = EXCLUDED.updated_at,
        retired_at = EXCLUDED.retired_at`,
      [
        claim.id,
        claim.layer,
        claim.text,
        claim.evidenceCount,
        claim.sampleNoteIds,
        claim.createdAt,
        claim.updatedAt,
        claim.retiredAt
      ]
    );
  }
}

async function recordFailedDigestRun(
  executor: DigestQueryExecutor,
  operations: DigestOperation[],
  proseSnapshot: DigestProse,
  newNoteCount: number,
  lockStartedAt: Date,
  error: unknown,
  now: Date,
  runId: string
) {
  await insertDigestRun(executor, {
    operations,
    proseSnapshot,
    newNoteCount,
    status: "failed",
    error: errorMessage(error),
    runAt: now,
    runId
  });
  await releaseDigestRefreshLock(executor, lockStartedAt);
}

async function insertDigestRun(executor: DigestQueryExecutor, input: {
  operations: DigestOperation[];
  proseSnapshot: DigestProse;
  newNoteCount: number;
  status: "succeeded" | "failed";
  error: string | null;
  runAt: Date;
  runId: string;
}) {
  await executor.query(
    `INSERT INTO digest_runs (
      id, run_at, ops, prose_snapshot, new_note_count, status, error
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.runId,
      input.runAt,
      JSON.stringify(input.operations),
      input.proseSnapshot,
      input.newNoteCount,
      input.status,
      input.error
    ]
  );
}

function mapDigestClaimRow(row: pg.QueryResultRow): DigestClaim {
  const claim = digestClaimRowSchema.parse(row);
  return {
    id: claim.id,
    layer: claim.layer,
    text: claim.text,
    evidenceCount: claim.evidence_count,
    sampleNoteIds: claim.sample_note_ids,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
    retiredAt: claim.retired_at?.toISOString() ?? null
  };
}

function capSampleNoteIds(existingNoteIds: string[], incomingNoteIds: string[]) {
  const noteIds = [...existingNoteIds];
  for (const noteId of incomingNoteIds) {
    const previousIndex = noteIds.indexOf(noteId);
    if (previousIndex >= 0) {
      noteIds.splice(previousIndex, 1);
    }
    noteIds.push(noteId);
  }
  return noteIds.slice(-5);
}

function uniqueNoteIds(noteIds: string[]) {
  return [...new Set(noteIds)];
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

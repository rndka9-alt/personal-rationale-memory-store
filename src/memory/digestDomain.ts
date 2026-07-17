import { z } from "zod";

export const digestLayers = ["now", "recent", "longterm", "about"] as const;
export const digestLayerSchema = z.enum(digestLayers);
export const digestStableLayerSchema = z.enum(["longterm", "about"]);
export const digestProseHardMaxLength = 1200;
// claim이 단일 명제를 넘어 작업 로그처럼 살찌는 것을 막는 하드캡. 프롬프트 가이드(150자)의
// 초과분은 merge가 자식 의미를 부모 text에 보존할 때 필요한 여유다.
export const digestClaimTextMaxLength = 250;

export const digestProseSchema = z.object({
  now: z.string().max(digestProseHardMaxLength),
  recent: z.string().max(digestProseHardMaxLength),
  longterm: z.string().max(digestProseHardMaxLength),
  about: z.string().max(digestProseHardMaxLength)
}).strict();

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

const promoteDigestOperationSchema = z.object({
  type: z.literal("promote"),
  claimId: z.string().min(1),
  layer: digestStableLayerSchema
}).strict();

const mergeDigestOperationSchema = z.object({
  type: z.literal("merge"),
  parentClaimId: z.string().min(1),
  childClaimIds: z.array(z.string().min(1)).min(1),
  text: z.string().min(1).optional()
}).strict();

export const digestOperationSchema = z.union([
  addDigestOperationSchema,
  strengthenDigestOperationSchema,
  reviseDigestOperationSchema,
  retireDigestOperationSchema,
  promoteDigestOperationSchema,
  mergeDigestOperationSchema
]);

export const digestJudgmentOutputSchema = z.object({
  ops: z.array(digestOperationSchema)
}).strict();

export type DigestLayer = z.infer<typeof digestLayerSchema>;
export type DigestStableLayer = z.infer<typeof digestStableLayerSchema>;
export type DigestProse = z.infer<typeof digestProseSchema>;
export type DigestOperation = z.infer<typeof digestOperationSchema>;

export type DigestEvidence = {
  // run 시각을 쓰면 밀린 노트가 최신 관측으로 부활하므로 원본 note 시각을 보존한다.
  noteId: string;
  observedAt: string;
  sourceKind: string;
};

export type DigestClaim = {
  id: string;
  layer: DigestLayer;
  text: string;
  evidence: DigestEvidence[];
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type DigestNote = {
  id: string;
  content: string;
  topic: string | null;
  createdAt: string;
};

export type DigestClaimStats = {
  // 사용자의 하루 경계와 서버 UTC 경계가 다르므로 observedDays는 KST 원천 증거에서 계산한다.
  firstObservedAt: string;
  lastObservedAt: string;
  observedDays: number;
};

export type DigestSkippedOperation = {
  operation: DigestOperation;
  reason: string;
};

export type DigestDeferredPromotion = {
  claimId: string;
  targetLayer: DigestStableLayer;
  requestedAt: string;
  runId: string;
  reason: string;
};

export type DigestDeferredEvent = {
  action: "queued" | "applied" | "removed" | "retained";
  claimId: string;
  targetLayer: DigestStableLayer;
  reason: string;
};

export type PlannedDigestOperations = {
  operations: DigestOperation[];
  skippedOperations: DigestSkippedOperation[];
  deferredRequests: DigestDeferredPromotion[];
};

export type AppliedDigestOperations = PlannedDigestOperations & {
  claims: DigestClaim[];
  dirtyLayers: Set<DigestLayer>;
};

type PlanDigestOperationsOptions = {
  promoteMinSpanDays: number;
  runId: string;
  now?: Date;
};

type ApplyDigestOperationsOptions = {
  now?: Date;
  createClaimId: () => string;
};

type MaintainDigestOptions = {
  promoteMinSpanDays: number;
  recentRetireWeeks: number;
  now?: Date;
};

const digestTimeZone = "Asia/Seoul";
const millisecondsPerDay = 24 * 60 * 60 * 1000;

export function getDigestClaimStats(
  claim: Pick<DigestClaim, "evidence" | "createdAt">
): DigestClaimStats {
  if (claim.evidence.length === 0) {
    // evidence 없는 claim(과거 seed 산출물)이 관측 시각 부재로 노후화 판정에서 영원히
    // 빠지지 않도록 생성 시각을 관측 하한으로 쓴다. 신규 경로는 스키마가 evidence를 강제한다.
    return {
      firstObservedAt: claim.createdAt,
      lastObservedAt: claim.createdAt,
      observedDays: 1
    };
  }

  const timestamps = claim.evidence.map((evidence) => parseTimestamp(evidence.observedAt));
  const observedDays = new Set(timestamps.map(formatKstDate));
  return {
    firstObservedAt: new Date(Math.min(...timestamps)).toISOString(),
    lastObservedAt: new Date(Math.max(...timestamps)).toISOString(),
    observedDays: observedDays.size
  };
}

export function hasMinimumObservationSpan(claim: DigestClaim, minimumSpanDays: number) {
  const stats = getDigestClaimStats(claim);
  return parseTimestamp(stats.lastObservedAt) - parseTimestamp(stats.firstObservedAt)
    >= minimumSpanDays * millisecondsPerDay;
}

export function planDigestOperations(
  claims: DigestClaim[],
  operations: DigestOperation[],
  newNotes: DigestNote[],
  options: PlanDigestOperationsOptions
): PlannedDigestOperations {
  // LLM 배열 순서가 결과를 바꾸지 않도록 pre-run 원장의 우선순위와 충돌 집합을 먼저 확정한다.
  const now = options.now ?? new Date();
  const activeClaims = new Map(claims.filter((claim) => !claim.retiredAt).map((claim) => [claim.id, claim]));
  const newNoteIds = new Set(newNotes.map((note) => note.id));
  const normalized = normalizeDigestOperations(operations);
  const skippedOperations = [...normalized.skippedOperations];
  const validOperations: DigestOperation[] = [];

  for (const operation of normalized.operations) {
    const invalidReason = validateDigestOperation(operation, activeClaims, newNoteIds);
    if (invalidReason) {
      skippedOperations.push({ operation, reason: invalidReason });
      continue;
    }
    validOperations.push(operation);
  }

  const highestPriorityByClaim = new Map<string, number>();
  for (const operation of validOperations) {
    const priority = digestOperationPriority(operation);
    for (const claimId of digestOperationClaimIds(operation)) {
      highestPriorityByClaim.set(claimId, Math.max(highestPriorityByClaim.get(claimId) ?? 0, priority));
    }
  }

  const priorityWinners: DigestOperation[] = [];
  for (const operation of validOperations) {
    const priority = digestOperationPriority(operation);
    const isSuperseded = digestOperationClaimIds(operation).some(
      (claimId) => (highestPriorityByClaim.get(claimId) ?? priority) > priority
    );
    if (isSuperseded) {
      skippedOperations.push({ operation, reason: "superseded_by_higher_priority_operation" });
      continue;
    }
    priorityWinners.push(operation);
  }

  const conflictingOperationKeys = findConflictingOperationKeys(priorityWinners);
  const operationsWithoutConflicts: DigestOperation[] = [];
  for (const operation of priorityWinners) {
    if (conflictingOperationKeys.has(canonicalDigestOperation(operation))) {
      skippedOperations.push({ operation, reason: "conflicting_same_priority_operations" });
      continue;
    }
    operationsWithoutConflicts.push(operation);
  }

  const plannedOperations: DigestOperation[] = [];
  const deferredRequests: DigestDeferredPromotion[] = [];
  for (const operation of operationsWithoutConflicts.sort(compareDigestOperations)) {
    if (operation.type !== "promote") {
      plannedOperations.push(operation);
      continue;
    }
    const claim = activeClaims.get(operation.claimId);
    if (!claim) {
      throw new Error(`Validated promote claim disappeared: ${operation.claimId}`);
    }
    if (hasMinimumObservationSpan(claim, options.promoteMinSpanDays)) {
      plannedOperations.push(operation);
      continue;
    }
    const reason = `observation_span_below_${options.promoteMinSpanDays}_days`;
    skippedOperations.push({ operation, reason });
    deferredRequests.push({
      claimId: operation.claimId,
      targetLayer: operation.layer,
      requestedAt: now.toISOString(),
      runId: options.runId,
      reason
    });
  }

  return {
    operations: plannedOperations,
    skippedOperations,
    deferredRequests
  };
}

export function applyDigestOperations(
  claims: DigestClaim[],
  plan: PlannedDigestOperations,
  newNotes: DigestNote[],
  options: ApplyDigestOperationsOptions
): AppliedDigestOperations {
  const now = options.now ?? new Date();
  const nowTimestamp = now.toISOString();
  const copiedClaims = cloneDigestClaims(claims);
  const claimsById = new Map(copiedClaims.map((claim) => [claim.id, claim]));
  const notesById = new Map(newNotes.map((note) => [note.id, note]));
  const dirtyLayers = new Set<DigestLayer>();

  for (const operation of plan.operations) {
    if (operation.type === "add") {
      const claim: DigestClaim = {
        id: options.createClaimId(),
        layer: operation.layer,
        text: operation.text,
        evidence: createEvidence(operation.noteIds, notesById),
        createdAt: nowTimestamp,
        updatedAt: nowTimestamp,
        retiredAt: null
      };
      copiedClaims.push(claim);
      claimsById.set(claim.id, claim);
      dirtyLayers.add(claim.layer);
      continue;
    }

    if (operation.type === "merge") {
      const parent = requireActiveClaim(claimsById, operation.parentClaimId);
      for (const childClaimId of operation.childClaimIds) {
        const child = requireActiveClaim(claimsById, childClaimId);
        parent.evidence = mergeEvidence(parent.evidence, child.evidence);
        child.evidence = [];
        child.retiredAt = nowTimestamp;
        child.updatedAt = nowTimestamp;
      }
      if (operation.text !== undefined) {
        parent.text = operation.text;
      }
      parent.updatedAt = nowTimestamp;
      dirtyLayers.add(parent.layer);
      continue;
    }

    const claim = requireActiveClaim(claimsById, operation.claimId);
    if (operation.type === "strengthen") {
      claim.evidence = mergeEvidence(claim.evidence, createEvidence(operation.noteIds, notesById));
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
        claim.evidence = mergeEvidence(claim.evidence, createEvidence(operation.noteIds, notesById));
      }
      if (operation.text !== undefined || operation.layer !== undefined) {
        claim.updatedAt = nowTimestamp;
        dirtyLayers.add(previousLayer);
        dirtyLayers.add(claim.layer);
      }
      continue;
    }
    if (operation.type === "promote") {
      const previousLayer = claim.layer;
      claim.layer = operation.layer;
      claim.updatedAt = nowTimestamp;
      dirtyLayers.add(previousLayer);
      dirtyLayers.add(claim.layer);
      continue;
    }
    claim.retiredAt = nowTimestamp;
    claim.updatedAt = nowTimestamp;
    dirtyLayers.add(claim.layer);
  }

  return {
    ...plan,
    claims: copiedClaims,
    dirtyLayers
  };
}

export function maintainDigestClaims(
  claims: DigestClaim[],
  deferredPromotions: DigestDeferredPromotion[],
  deferredRequests: DigestDeferredPromotion[],
  options: MaintainDigestOptions
) {
  // 승격 대기 claim이 recent 출구에서 먼저 사라지지 않도록 deferred를 적용·보존한 뒤 노후화를 계산한다.
  const now = options.now ?? new Date();
  const nowTimestamp = now.toISOString();
  const copiedClaims = cloneDigestClaims(claims);
  const claimsById = new Map(copiedClaims.map((claim) => [claim.id, claim]));
  const deferredByClaimId = new Map(deferredPromotions.map((promotion) => [promotion.claimId, { ...promotion }]));
  const dirtyLayers = new Set<DigestLayer>();
  const deferredEvents: DigestDeferredEvent[] = [];
  const appliedOperations: DigestOperation[] = [];

  for (const request of deferredRequests.sort(compareDeferredPromotions)) {
    const existing = deferredByClaimId.get(request.claimId);
    if (!existing) {
      deferredByClaimId.set(request.claimId, { ...request });
      deferredEvents.push({
        action: "queued",
        claimId: request.claimId,
        targetLayer: request.targetLayer,
        reason: request.reason
      });
      continue;
    }
    deferredEvents.push({
      action: "retained",
      claimId: request.claimId,
      targetLayer: existing.targetLayer,
      reason: existing.targetLayer === request.targetLayer
        ? "already_queued"
        : "existing_target_layer_preserved"
    });
  }

  for (const deferred of [...deferredByClaimId.values()].sort(compareDeferredPromotions)) {
    const claim = claimsById.get(deferred.claimId);
    if (!claim || claim.retiredAt) {
      deferredByClaimId.delete(deferred.claimId);
      deferredEvents.push({
        action: "removed",
        claimId: deferred.claimId,
        targetLayer: deferred.targetLayer,
        reason: "claim_not_active"
      });
      continue;
    }
    if (claim.layer === deferred.targetLayer) {
      deferredByClaimId.delete(deferred.claimId);
      deferredEvents.push({
        action: "removed",
        claimId: deferred.claimId,
        targetLayer: deferred.targetLayer,
        reason: "claim_already_promoted"
      });
      continue;
    }
    if (claim.layer === "longterm" || claim.layer === "about") {
      deferredByClaimId.delete(deferred.claimId);
      deferredEvents.push({
        action: "removed",
        claimId: deferred.claimId,
        targetLayer: deferred.targetLayer,
        reason: "claim_entered_another_stable_layer"
      });
      continue;
    }
    if (!hasMinimumObservationSpan(claim, options.promoteMinSpanDays)) {
      continue;
    }
    const previousLayer = claim.layer;
    claim.layer = deferred.targetLayer;
    claim.updatedAt = nowTimestamp;
    deferredByClaimId.delete(deferred.claimId);
    dirtyLayers.add(previousLayer);
    dirtyLayers.add(claim.layer);
    appliedOperations.push({
      type: "promote",
      claimId: claim.id,
      layer: deferred.targetLayer
    });
    deferredEvents.push({
      action: "applied",
      claimId: deferred.claimId,
      targetLayer: deferred.targetLayer,
      reason: "observation_span_gate_satisfied"
    });
  }

  const recentRetireThreshold = now.getTime() - options.recentRetireWeeks * 7 * millisecondsPerDay;
  for (const claim of copiedClaims) {
    if (claim.retiredAt || claim.layer !== "recent" || deferredByClaimId.has(claim.id)) {
      continue;
    }
    if (parseTimestamp(getDigestClaimStats(claim).lastObservedAt) > recentRetireThreshold) {
      continue;
    }
    claim.retiredAt = nowTimestamp;
    claim.updatedAt = nowTimestamp;
    dirtyLayers.add("recent");
    appliedOperations.push({ type: "retire", claimId: claim.id });
  }

  return {
    claims: copiedClaims,
    deferredPromotions: [...deferredByClaimId.values()].sort(compareDeferredPromotions),
    deferredEvents,
    appliedOperations,
    dirtyLayers
  };
}

export function resolveMergePressure(
  wasActive: boolean,
  activeClaimCount: number,
  triggerCount: number,
  releaseCount: number
) {
  if (activeClaimCount >= triggerCount) {
    return true;
  }
  if (activeClaimCount <= releaseCount) {
    return false;
  }
  return wasActive;
}

function normalizeDigestOperations(operations: DigestOperation[]) {
  const normalized: DigestOperation[] = [];
  const skippedOperations: DigestSkippedOperation[] = [];
  const sortedOperations = operations.map(normalizeDigestOperation).sort(compareDigestOperations);

  for (const operation of sortedOperations) {
    const matchingIndex = normalized.findIndex((candidate) => canCombineOperations(candidate, operation));
    if (matchingIndex < 0) {
      normalized.push(operation);
      continue;
    }
    const matchingOperation = normalized[matchingIndex];
    if (!matchingOperation) {
      throw new Error("Normalized digest operation index was missing.");
    }
    normalized[matchingIndex] = combineDigestOperations(matchingOperation, operation);
    skippedOperations.push({ operation, reason: "duplicate_operation_combined" });
  }

  return { operations: normalized, skippedOperations };
}

function normalizeDigestOperation(operation: DigestOperation): DigestOperation {
  if (operation.type === "add") {
    return { ...operation, noteIds: uniqueSorted(operation.noteIds) };
  }
  if (operation.type === "strengthen") {
    return { ...operation, noteIds: uniqueSorted(operation.noteIds) };
  }
  if (operation.type === "revise") {
    if (operation.text === undefined && operation.layer === undefined && operation.noteIds !== undefined) {
      return { type: "strengthen", claimId: operation.claimId, noteIds: uniqueSorted(operation.noteIds) };
    }
    return {
      ...operation,
      noteIds: operation.noteIds === undefined ? undefined : uniqueSorted(operation.noteIds)
    };
  }
  if (operation.type === "merge") {
    return { ...operation, childClaimIds: uniqueSorted(operation.childClaimIds) };
  }
  return { ...operation };
}

function canCombineOperations(left: DigestOperation, right: DigestOperation) {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "add" && right.type === "add") {
    return left.layer === right.layer && left.text === right.text;
  }
  if (left.type === "strengthen" && right.type === "strengthen") {
    return left.claimId === right.claimId;
  }
  if (left.type === "revise" && right.type === "revise") {
    return left.claimId === right.claimId && left.text === right.text && left.layer === right.layer;
  }
  return canonicalDigestOperation(left) === canonicalDigestOperation(right);
}

function combineDigestOperations(left: DigestOperation, right: DigestOperation): DigestOperation {
  if (left.type === "add" && right.type === "add") {
    return { ...left, noteIds: uniqueSorted([...left.noteIds, ...right.noteIds]) };
  }
  if (left.type === "strengthen" && right.type === "strengthen") {
    return { ...left, noteIds: uniqueSorted([...left.noteIds, ...right.noteIds]) };
  }
  if (left.type === "revise" && right.type === "revise") {
    return {
      ...left,
      noteIds: combineOptionalNoteIds(left.noteIds, right.noteIds)
    };
  }
  return left;
}

// zod 스키마에 max를 걸면 판단 출력 전체 파싱이 실패해 run이 통째로 죽으므로,
// 길이 위반은 op 단위 skip으로 격리해 나머지 op와 히스토리 기록을 살린다.
const claimTextTooLongReason = `claim_text_over_${digestClaimTextMaxLength}_chars`;

function validateDigestOperation(
  operation: DigestOperation,
  activeClaims: Map<string, DigestClaim>,
  newNoteIds: Set<string>
) {
  if ("text" in operation && operation.text !== undefined && operation.text.length > digestClaimTextMaxLength) {
    return claimTextTooLongReason;
  }
  if (operation.type === "add") {
    if (operation.layer === "longterm" || operation.layer === "about") {
      return "stable_layer_add_requires_promotion";
    }
    return validateNoteIds(operation.noteIds, newNoteIds);
  }
  if (operation.type === "merge") {
    if (operation.childClaimIds.includes(operation.parentClaimId)) {
      return "merge_parent_cannot_be_a_child";
    }
    const parent = activeClaims.get(operation.parentClaimId);
    if (!parent) {
      return "merge_parent_not_active";
    }
    for (const childClaimId of operation.childClaimIds) {
      const child = activeClaims.get(childClaimId);
      if (!child) {
        return "merge_child_not_active";
      }
      if (child.layer !== parent.layer) {
        return "merge_requires_same_layer";
      }
    }
    return null;
  }

  const claim = activeClaims.get(operation.claimId);
  if (!claim) {
    return "claim_not_active";
  }
  if (operation.type === "strengthen") {
    return validateNoteIds(operation.noteIds, newNoteIds);
  }
  if (operation.type === "revise") {
    if (
      operation.layer !== undefined
      && operation.layer !== claim.layer
      && (operation.layer === "longterm" || operation.layer === "about")
    ) {
      return "stable_layer_transition_requires_promotion";
    }
    return operation.noteIds === undefined ? null : validateNoteIds(operation.noteIds, newNoteIds);
  }
  if (operation.type === "promote") {
    return claim.layer === "now" || claim.layer === "recent"
      ? null
      : "only_transient_layers_can_be_promoted";
  }
  return null;
}

function validateNoteIds(noteIds: string[], newNoteIds: Set<string>) {
  return noteIds.every((noteId) => newNoteIds.has(noteId))
    ? null
    : "evidence_note_not_in_current_batch";
}

function digestOperationPriority(operation: DigestOperation) {
  if (operation.type === "retire") {
    return 500;
  }
  if (operation.type === "revise" && operation.text !== undefined) {
    return 400;
  }
  if (operation.type === "merge") {
    return 300;
  }
  if (operation.type === "promote" || operation.type === "revise") {
    return 200;
  }
  return 100;
}

export function digestOperationClaimIds(operation: DigestOperation) {
  if (operation.type === "add") {
    return [];
  }
  if (operation.type === "merge") {
    return [operation.parentClaimId, ...operation.childClaimIds];
  }
  return [operation.claimId];
}

function findConflictingOperationKeys(operations: DigestOperation[]) {
  const operationsByClaimId = new Map<string, DigestOperation[]>();
  for (const operation of operations) {
    for (const claimId of digestOperationClaimIds(operation)) {
      const claimOperations = operationsByClaimId.get(claimId) ?? [];
      claimOperations.push(operation);
      operationsByClaimId.set(claimId, claimOperations);
    }
  }

  const conflictingKeys = new Set<string>();
  for (const claimOperations of operationsByClaimId.values()) {
    if (claimOperations.length < 2) {
      continue;
    }
    for (const operation of claimOperations) {
      conflictingKeys.add(canonicalDigestOperation(operation));
    }
  }
  return conflictingKeys;
}

function compareDigestOperations(left: DigestOperation, right: DigestOperation) {
  const priorityDifference = digestOperationPriority(right) - digestOperationPriority(left);
  return priorityDifference !== 0
    ? priorityDifference
    : canonicalDigestOperation(left).localeCompare(canonicalDigestOperation(right));
}

function canonicalDigestOperation(operation: DigestOperation) {
  if (operation.type === "add") {
    return JSON.stringify({ type: operation.type, layer: operation.layer, text: operation.text, noteIds: uniqueSorted(operation.noteIds) });
  }
  if (operation.type === "strengthen") {
    return JSON.stringify({ type: operation.type, claimId: operation.claimId, noteIds: uniqueSorted(operation.noteIds) });
  }
  if (operation.type === "revise") {
    return JSON.stringify({
      type: operation.type,
      claimId: operation.claimId,
      text: operation.text,
      layer: operation.layer,
      noteIds: operation.noteIds === undefined ? undefined : uniqueSorted(operation.noteIds)
    });
  }
  if (operation.type === "retire") {
    return JSON.stringify({ type: operation.type, claimId: operation.claimId });
  }
  if (operation.type === "promote") {
    return JSON.stringify({ type: operation.type, claimId: operation.claimId, layer: operation.layer });
  }
  return JSON.stringify({
    type: operation.type,
    parentClaimId: operation.parentClaimId,
    childClaimIds: uniqueSorted(operation.childClaimIds),
    text: operation.text
  });
}

function createEvidence(noteIds: string[], notesById: Map<string, DigestNote>) {
  return uniqueSorted(noteIds).map((noteId) => {
    const note = notesById.get(noteId);
    if (!note) {
      throw new Error(`Validated digest evidence note disappeared: ${noteId}`);
    }
    return {
      noteId,
      observedAt: note.createdAt,
      sourceKind: "note"
    };
  });
}

function mergeEvidence(existing: DigestEvidence[], incoming: DigestEvidence[]) {
  const evidenceByNoteId = new Map(existing.map((evidence) => [evidence.noteId, { ...evidence }]));
  for (const evidence of incoming) {
    evidenceByNoteId.set(evidence.noteId, { ...evidence });
  }
  return [...evidenceByNoteId.values()].sort(compareEvidence);
}

function requireActiveClaim(claimsById: Map<string, DigestClaim>, claimId: string) {
  const claim = claimsById.get(claimId);
  if (!claim || claim.retiredAt) {
    throw new Error(`Planned digest claim was not active: ${claimId}`);
  }
  return claim;
}

function cloneDigestClaims(claims: DigestClaim[]) {
  return claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => ({ ...evidence }))
  }));
}

function compareEvidence(left: DigestEvidence, right: DigestEvidence) {
  const timestampDifference = left.observedAt.localeCompare(right.observedAt);
  return timestampDifference !== 0 ? timestampDifference : left.noteId.localeCompare(right.noteId);
}

function compareDeferredPromotions(left: DigestDeferredPromotion, right: DigestDeferredPromotion) {
  const requestedAtDifference = left.requestedAt.localeCompare(right.requestedAt);
  return requestedAtDifference !== 0 ? requestedAtDifference : left.claimId.localeCompare(right.claimId);
}

function combineOptionalNoteIds(left: string[] | undefined, right: string[] | undefined) {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return uniqueSorted([...(left ?? []), ...(right ?? [])]);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid digest timestamp: ${value}`);
  }
  return timestamp;
}

function formatKstDate(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: digestTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Failed to format digest observation date in Asia/Seoul.");
  }
  return `${year}-${month}-${day}`;
}

import { requestJson } from "./http";

export const digestLayers = ["now", "recent", "longterm", "about"] as const;

export type DigestLayer = (typeof digestLayers)[number];

export type DigestProse = Record<DigestLayer, string>;

export type DigestClaim = {
  id: string;
  layer: DigestLayer;
  text: string;
  evidenceCount: number;
  sampleNoteIds: string[];
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  observedDays: number;
  createdAt: string;
  updatedAt: string;
  deferred: {
    targetLayer: "longterm" | "about";
    requestedAt: string;
  } | null;
};

export type DigestView = {
  state: {
    synthesizedAt: string;
    newNoteCount: number;
    prose: DigestProse;
  } | null;
  claims: DigestClaim[];
};

export type DigestOperation =
  | { type: "add"; layer: DigestLayer; text: string; noteIds: string[] }
  | { type: "strengthen"; claimId: string; noteIds: string[] }
  | { type: "revise"; claimId: string; text?: string; layer?: DigestLayer; noteIds?: string[] }
  | { type: "retire"; claimId: string }
  | { type: "promote"; claimId: string; layer: "longterm" | "about" }
  | { type: "merge"; parentClaimId: string; childClaimIds: string[]; text?: string };

export type DigestSkippedOperation = {
  operation: DigestOperation;
  reason: string;
};

export type DigestDeferredEvent = {
  action: "queued" | "applied" | "removed" | "retained";
  claimId: string;
  targetLayer: "longterm" | "about";
  reason: string;
};

export type DigestRun = {
  id: string;
  runAt: string;
  status: "succeeded" | "failed";
  error: string | null;
  newNoteCount: number;
  ops: DigestOperation[];
  skippedOperations: DigestSkippedOperation[];
  deferredEvents: DigestDeferredEvent[];
  // run 시점의 claim 문구 스냅샷(claimId → text). 스냅샷 도입 이전 run은 빈 객체다.
  claimTexts: Record<string, string>;
  proseSnapshot: DigestProse;
  runKind: "synthesis" | "maintenance";
};

export async function fetchDigest(): Promise<DigestView> {
  const data = await requestJson("/api/digest");
  if (!isRecord(data) || !Array.isArray(data.claims)) {
    throw new Error("Invalid digest response.");
  }

  return {
    state: data.state === null ? null : parseDigestState(data.state),
    claims: data.claims.map(parseDigestClaim)
  };
}

export async function fetchDigestRuns(limit = 20): Promise<DigestRun[]> {
  const data = await requestJson(`/api/digest/runs?limit=${limit}`);
  if (!Array.isArray(data)) {
    throw new Error("Invalid digest run response.");
  }
  return data.map(parseDigestRun);
}

function parseDigestState(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid digest state.");
  }
  return {
    synthesizedAt: readString(value, "synthesizedAt"),
    newNoteCount: readNonnegativeInteger(value, "newNoteCount"),
    prose: parseDigestProse(value.prose)
  };
}

function parseDigestClaim(value: unknown): DigestClaim {
  if (!isRecord(value)) {
    throw new Error("Invalid digest claim.");
  }
  return {
    id: readString(value, "id"),
    layer: readDigestLayer(value, "layer"),
    text: readString(value, "text"),
    evidenceCount: readNonnegativeInteger(value, "evidenceCount"),
    sampleNoteIds: readStringArray(value, "sampleNoteIds"),
    firstObservedAt: readNullableString(value, "firstObservedAt"),
    lastObservedAt: readNullableString(value, "lastObservedAt"),
    observedDays: readNonnegativeInteger(value, "observedDays"),
    createdAt: readString(value, "createdAt"),
    updatedAt: readString(value, "updatedAt"),
    deferred: value.deferred === null ? null : parseClaimDeferredPromotion(value.deferred)
  };
}

function parseClaimDeferredPromotion(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid deferred promotion state.");
  }
  const targetLayer = readDigestLayer(value, "targetLayer");
  if (targetLayer !== "longterm" && targetLayer !== "about") {
    throw new Error("Deferred promotion target must be a stable layer.");
  }
  return {
    targetLayer,
    requestedAt: readString(value, "requestedAt")
  };
}

function parseDigestRun(value: unknown): DigestRun {
  if (
    !isRecord(value)
    || !Array.isArray(value.ops)
    || !Array.isArray(value.skippedOperations)
    || !Array.isArray(value.deferredEvents)
  ) {
    throw new Error("Invalid digest run.");
  }
  const status = value.status;
  if (status !== "succeeded" && status !== "failed") {
    throw new Error("Invalid digest run status.");
  }
  const runKind = value.runKind;
  if (runKind !== "synthesis" && runKind !== "maintenance") {
    throw new Error("Invalid digest run kind.");
  }
  return {
    id: readString(value, "id"),
    runAt: readString(value, "runAt"),
    status,
    error: readNullableString(value, "error"),
    newNoteCount: readNonnegativeInteger(value, "newNoteCount"),
    ops: value.ops.map(parseDigestOperation),
    skippedOperations: value.skippedOperations.map(parseDigestSkippedOperation),
    deferredEvents: value.deferredEvents.map(parseDigestDeferredEvent),
    claimTexts: readStringRecord(value, "claimTexts"),
    proseSnapshot: parseDigestProse(value.proseSnapshot),
    runKind
  };
}

function parseDigestOperation(value: unknown): DigestOperation {
  if (!isRecord(value)) {
    throw new Error("Invalid digest operation.");
  }
  if (value.type === "add") {
    return {
      type: "add",
      layer: readDigestLayer(value, "layer"),
      text: readString(value, "text"),
      noteIds: readStringArray(value, "noteIds")
    };
  }
  if (value.type === "strengthen") {
    return {
      type: "strengthen",
      claimId: readString(value, "claimId"),
      noteIds: readStringArray(value, "noteIds")
    };
  }
  if (value.type === "revise") {
    const text = readOptionalString(value, "text");
    const layer = readOptionalDigestLayer(value, "layer");
    const noteIds = readOptionalStringArray(value, "noteIds");
    if (text === undefined && layer === undefined && noteIds === undefined) {
      throw new Error("Digest revise operation has no changes.");
    }
    return { type: "revise", claimId: readString(value, "claimId"), text, layer, noteIds };
  }
  if (value.type === "retire") {
    return { type: "retire", claimId: readString(value, "claimId") };
  }
  if (value.type === "promote") {
    const layer = readDigestLayer(value, "layer");
    if (layer !== "longterm" && layer !== "about") {
      throw new Error("Digest promote target must be a stable layer.");
    }
    return { type: "promote", claimId: readString(value, "claimId"), layer };
  }
  if (value.type === "merge") {
    return {
      type: "merge",
      parentClaimId: readString(value, "parentClaimId"),
      childClaimIds: readStringArray(value, "childClaimIds"),
      text: readOptionalString(value, "text")
    };
  }
  throw new Error("Invalid digest operation type.");
}

function parseDigestSkippedOperation(value: unknown): DigestSkippedOperation {
  if (!isRecord(value)) {
    throw new Error("Invalid skipped digest operation.");
  }
  return {
    operation: parseDigestOperation(value.operation),
    reason: readString(value, "reason")
  };
}

function parseDigestDeferredEvent(value: unknown): DigestDeferredEvent {
  if (!isRecord(value)) {
    throw new Error("Invalid deferred promotion event.");
  }
  const action = value.action;
  if (action !== "queued" && action !== "applied" && action !== "removed" && action !== "retained") {
    throw new Error("Invalid deferred promotion action.");
  }
  const targetLayer = readDigestLayer(value, "targetLayer");
  if (targetLayer !== "longterm" && targetLayer !== "about") {
    throw new Error("Deferred promotion target must be a stable layer.");
  }
  return {
    action,
    claimId: readString(value, "claimId"),
    targetLayer,
    reason: readString(value, "reason")
  };
}

function parseDigestProse(value: unknown): DigestProse {
  if (!isRecord(value)) {
    throw new Error("Invalid digest prose.");
  }
  return {
    now: readString(value, "now"),
    recent: readString(value, "recent"),
    longterm: readString(value, "longterm"),
    about: readString(value, "about")
  };
}

function readDigestLayer(value: Record<string, unknown>, key: string): DigestLayer {
  const layer = value[key];
  if (layer === "now" || layer === "recent" || layer === "longterm" || layer === "about") {
    return layer;
  }
  throw new Error(`Invalid digest layer: ${String(layer)}`);
}

function readOptionalDigestLayer(value: Record<string, unknown>, key: string) {
  return value[key] === undefined ? undefined : readDigestLayer(value, key);
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return field;
}

function readOptionalString(value: Record<string, unknown>, key: string) {
  return value[key] === undefined ? undefined : readString(value, key);
}

function readNullableString(value: Record<string, unknown>, key: string) {
  return value[key] === null ? null : readString(value, key);
}

function readStringRecord(value: Record<string, unknown>, key: string): Record<string, string> {
  const field = value[key];
  if (!isRecord(field)) {
    throw new Error(`Expected ${key} to be a string record.`);
  }
  const record: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(field)) {
    if (typeof recordValue !== "string") {
      throw new Error(`Expected ${key} to be a string record.`);
    }
    record[recordKey] = recordValue;
  }
  return record;
}

function readStringArray(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    throw new Error(`Expected ${key} to be a string array.`);
  }
  return field;
}

function readOptionalStringArray(value: Record<string, unknown>, key: string) {
  return value[key] === undefined ? undefined : readStringArray(value, key);
}

function readNonnegativeInteger(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
    throw new Error(`Expected ${key} to be a nonnegative integer.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

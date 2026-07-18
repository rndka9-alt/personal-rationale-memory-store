import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrations.js";
import { createEmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { MemoryFileStore } from "../memory/fileStore.js";
import { DigestViewService } from "../memory/digestViewService.js";
import { IndexingService } from "../memory/indexingService.js";
import { LlmRequestLogService } from "../memory/llmRequestLogService.js";
import { NoteService } from "../memory/noteService.js";
import { RationaleService } from "../memory/rationaleService.js";
import { RecapService } from "../memory/recapService.js";
import { RecapSnapshotService } from "../memory/recapSnapshotService.js";
import type {
  ReviewQueueSignalFilter,
  ReviewQueueSortMode
} from "../memory/rationaleService.js";
import { logError, logInfo } from "../diagnostics/index.js";
import type { MemoryCatalogSortMode, MemoryCatalogStatus } from "../db/queries.js";

const defaultPageSize = 25;
const maximumPageSize = 100;
const defaultLlmRequestLimit = 50;
const maximumLlmRequestLimit = 200;
const defaultDigestRunLimit = 20;
const maximumDigestRunLimit = 100;
const defaultRecapDays = 30;
const maximumRecapDays = 365;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const fileStore = new MemoryFileStore(config.dataDirectory);
const embeddingProvider = createEmbeddingProvider(config);
const indexingService = new IndexingService(pool, fileStore, embeddingProvider, config);
const rationaleService = new RationaleService(pool, fileStore, indexingService, embeddingProvider, config);
const noteService = new NoteService(pool);
const llmRequestLogService = new LlmRequestLogService(pool);
const digestViewService = new DigestViewService(pool);
const recapService = new RecapService(pool);
const digestConfig = config.digest;
const recapSnapshotService = new RecapSnapshotService(pool, digestConfig.enabled ? digestConfig : null);
const clientDirectory = path.resolve(process.cwd(), "dist/web/client");

await runMigrations(pool);

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    logError("Web request failed.", error, {
      method: request.method,
      url: request.url
    });
    writeJson(response, 500, { error: "Internal server error" });
  }
});

await new Promise<void>((resolve) => {
  server.listen(config.web.port, config.web.host, resolve);
});

logInfo("Memory UI web server started.", {
  host: config.web.host,
  port: config.web.port
});
process.stderr.write(`Rationale Memory UI listening on ${config.web.host}:${config.web.port}\n`);

async function routeRequest(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthorized(request)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }

    await routeApiRequest(method, url, request, response);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await serveClient(url.pathname, response);
}

async function routeApiRequest(
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse
) {
  if (method === "GET" && url.pathname === "/api/memories") {
    const result = await rationaleService.listMemoryCatalogPage({
      status: readMemoryCatalogStatus(url.searchParams.get("status")),
      search: readSearchParam(url.searchParams.get("search")),
      sortMode: readMemoryCatalogSortMode(url.searchParams.get("sortMode")),
      page: readPositiveInteger(url.searchParams.get("page"), 1, "page"),
      pageSize: readPageSize(url.searchParams.get("pageSize"))
    });
    writeJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/review-queue") {
    const captureKind = readOptionalString(url.searchParams.get("captureKind"));
    const reviewStateParam = readOptionalString(url.searchParams.get("reviewState"));
    const reviewState = reviewStateParam === "all" ? undefined : reviewStateParam ?? "unreviewed";
    const result = await rationaleService.listReviewQueuePage({
      captureKind,
      reviewState,
      search: readSearchParam(url.searchParams.get("search")),
      sortMode: readReviewQueueSortMode(url.searchParams.get("sortMode")),
      signalFilter: readReviewQueueSignalFilter(url.searchParams.get("signalFilter")),
      page: readPositiveInteger(url.searchParams.get("page"), 1, "page"),
      pageSize: readPageSize(url.searchParams.get("pageSize"))
    });
    writeJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/notes") {
    const includeArchived = readBooleanParam(url.searchParams.get("includeArchived"));
    const result = await noteService.listNotes({
      includeArchived,
      search: readSearchParam(url.searchParams.get("search")),
      sortMode: readNoteSortMode(url.searchParams.get("sortMode")),
      page: readPositiveInteger(url.searchParams.get("page"), 1, "page"),
      pageSize: readPageSize(url.searchParams.get("pageSize"))
    });
    writeJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/llm-requests") {
    const pageSize = readLlmRequestPageSize(
      url.searchParams.get("pageSize") ?? url.searchParams.get("limit")
    );
    const result = await llmRequestLogService.listRequests({
      page: readPositiveInteger(url.searchParams.get("page"), 1, "page"),
      pageSize
    });
    writeJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/llm-requests/summary") {
    const summary = await llmRequestLogService.getSummary();
    writeJson(response, 200, summary);
    return;
  }

  if (method === "GET" && url.pathname === "/api/recap") {
    const recap = await recapService.getRecap({
      days: readRecapDays(url.searchParams.get("days"))
    });
    writeJson(response, 200, recap);
    return;
  }

  if (method === "POST" && url.pathname === "/api/recap/refresh") {
    if (!recapSnapshotService.synthesisEnabled) {
      writeJson(response, 503, { error: "Recap synthesis requires DIGEST_ENABLED=true." });
      return;
    }
    const body = await readJsonBody(request);
    const result = await recapSnapshotService.requestRefresh(
      readRecapRefreshDays(body),
      readRecapForceFlag(body)
    );
    writeJson(response, 202, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/recap/snapshot") {
    const snapshot = await recapSnapshotService.getLatestSnapshot(
      readRecapDays(url.searchParams.get("days"))
    );
    writeJson(response, 200, {
      ...snapshot,
      synthesisEnabled: recapSnapshotService.synthesisEnabled
    });
    return;
  }

  const recapRunMatch = matchRecapRunPath(url.pathname);
  if (recapRunMatch && method === "GET") {
    const run = await recapSnapshotService.getRun(recapRunMatch.id);
    if (!run) {
      writeJson(response, 404, { error: "Recap run not found" });
      return;
    }
    writeJson(response, 200, run);
    return;
  }

  if (method === "GET" && url.pathname === "/api/digest") {
    const digest = await digestViewService.getDigest();
    writeJson(response, 200, digest);
    return;
  }

  if (method === "GET" && url.pathname === "/api/digest/runs") {
    const requestedLimit = readPositiveInteger(url.searchParams.get("limit"), defaultDigestRunLimit, "limit");
    const runs = await digestViewService.listRuns(Math.min(requestedLimit, maximumDigestRunLimit));
    writeJson(response, 200, runs);
    return;
  }

  const archiveNoteMatch = matchNoteArchivePath(url.pathname);
  if (archiveNoteMatch && method === "POST") {
    const note = await noteService.archiveNote({ noteId: archiveNoteMatch.id });
    writeJson(response, 200, { note });
    return;
  }

  const restoreNoteMatch = matchNoteRestorePath(url.pathname);
  if (restoreNoteMatch && method === "POST") {
    const note = await noteService.restoreNote({ noteId: restoreNoteMatch.id });
    writeJson(response, 200, { note });
    return;
  }

  const detailMatch = matchReviewQueueDetailPath(url.pathname);
  if (detailMatch && method === "GET") {
    const entry = await rationaleService.getRationale(detailMatch.id);
    const indexedEntry = await rationaleService.getMemoryEntryRecord(detailMatch.id);
    const usageFeedbackCounts = await rationaleService.countUsageFeedback([detailMatch.id]);
    const usageFeedback = usageFeedbackCounts.get(detailMatch.id);
    if (!usageFeedback) {
      throw new Error(`Usage feedback counts missing for memory entry: ${detailMatch.id}`);
    }
    const review = await rationaleService.reviewRationale(detailMatch.id);
    writeJson(response, 200, {
      entry,
      review,
      usage: {
        useCount: indexedEntry.useCount,
        lastUsedAt: indexedEntry.lastUsedAt,
        feedback: usageFeedback
      }
    });
    return;
  }

  const reviewMatch = matchReviewQueueReviewPath(url.pathname);
  if (reviewMatch && method === "POST") {
    const body = await readJsonBody(request);
    const parsedBody = parseReviewActionBody(body);
    const entry = await rationaleService.markReviewQueueItem(reviewMatch.id, parsedBody.action, {
      notes: parsedBody.notes,
      reason: parsedBody.reason,
      patch: parsedBody.patch
    });
    writeJson(response, 200, { entry });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

async function serveClient(requestPath: string, response: ServerResponse) {
  const filePath = requestPath === "/"
    ? path.join(clientDirectory, "index.html")
    : path.join(clientDirectory, requestPath);

  if (!filePath.startsWith(clientDirectory)) {
    writeJson(response, 400, { error: "Invalid path" });
    return;
  }

  try {
    const file = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypeFor(filePath));
    response.end(file);
  } catch {
    const indexHtml = await readFile(path.join(clientDirectory, "index.html"));
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(indexHtml);
  }
}

function matchReviewQueueDetailPath(pathname: string) {
  const match = /^\/api\/review-queue\/([^/]+)$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function matchReviewQueueReviewPath(pathname: string) {
  const match = /^\/api\/review-queue\/([^/]+)\/review$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function matchNoteArchivePath(pathname: string) {
  const match = /^\/api\/notes\/([^/]+)\/archive$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function matchNoteRestorePath(pathname: string) {
  const match = /^\/api\/notes\/([^/]+)\/restore$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function isAuthorized(request: IncomingMessage) {
  if (!config.web.authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${config.web.authToken}`;
}

function readOptionalString(value: string | null) {
  return value && value.length > 0 ? value : undefined;
}

function readBooleanParam(value: string | null) {
  if (value === null || value.length === 0 || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`Invalid boolean query parameter: ${value}`);
}

function readSearchParam(value: string | null) {
  if (value === null) {
    return undefined;
  }
  const search = value.trim();
  if (search.length === 0) {
    return undefined;
  }
  if (search.length > 200) {
    throw new Error("Search query cannot exceed 200 characters.");
  }
  return search;
}

function readPositiveInteger(value: string | null, defaultValue: number, name: string) {
  if (value === null || value.length === 0) {
    return defaultValue;
  }
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Invalid positive integer query parameter ${name}: ${value}`);
  }
  return parsedValue;
}

function readPageSize(value: string | null) {
  const pageSize = readPositiveInteger(value, defaultPageSize, "pageSize");
  if (pageSize > maximumPageSize) {
    throw new Error(`pageSize cannot exceed ${maximumPageSize}.`);
  }
  return pageSize;
}

function readRecapDays(value: string | null) {
  const days = readPositiveInteger(value, defaultRecapDays, "days");
  if (days > maximumRecapDays) {
    throw new Error(`days cannot exceed ${maximumRecapDays}.`);
  }
  return days;
}

function readRecapRefreshDays(body: unknown) {
  if (!isRecord(body)) {
    throw new Error("Recap refresh body must be an object.");
  }
  const days = body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > maximumRecapDays) {
    throw new Error(`days must be an integer between 1 and ${maximumRecapDays}.`);
  }
  return days;
}

function readRecapForceFlag(body: unknown) {
  if (!isRecord(body) || body.force === undefined) {
    return false;
  }
  if (typeof body.force !== "boolean") {
    throw new Error("force must be a boolean.");
  }
  return body.force;
}

function matchRecapRunPath(pathname: string) {
  const match = /^\/api\/recap\/runs\/([^/]+)$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function readLlmRequestPageSize(value: string | null) {
  const pageSize = readPositiveInteger(value, defaultLlmRequestLimit, "pageSize");
  if (pageSize > maximumLlmRequestLimit) {
    throw new Error(`pageSize cannot exceed ${maximumLlmRequestLimit}.`);
  }
  return pageSize;
}

function readReviewQueueSortMode(value: string | null): ReviewQueueSortMode {
  if (value === null || value === "created") {
    return "created";
  }
  if (
    value === "priority"
    || value === "last_used"
    || value === "positive_feedback"
    || value === "negative_feedback"
    || value === "uses"
  ) {
    return value;
  }
  throw new Error(`Invalid review queue sort mode: ${value}`);
}

function readReviewQueueSignalFilter(value: string | null): ReviewQueueSignalFilter {
  if (value === null || value === "all") {
    return "all";
  }
  if (
    value === "repair_attention"
    || value === "with_negative_feedback"
    || value === "with_positive_feedback"
    || value === "recently_used"
  ) {
    return value;
  }
  throw new Error(`Invalid review queue signal filter: ${value}`);
}

function readMemoryCatalogStatus(value: string | null): MemoryCatalogStatus {
  if (value === null || value === "current") {
    return "current";
  }
  if (value === "deprecated" || value === "all") {
    return value;
  }
  throw new Error(`Invalid memory catalog status: ${value}`);
}

function readMemoryCatalogSortMode(value: string | null): MemoryCatalogSortMode {
  if (value === null || value === "created") {
    return "created";
  }
  if (value === "last_used" || value === "uses") {
    return value;
  }
  throw new Error(`Invalid memory catalog sort mode: ${value}`);
}

function readNoteSortMode(value: string | null): "newest" | "oldest" {
  if (value === null || value === "newest") {
    return "newest";
  }
  if (value === "oldest") {
    return "oldest";
  }
  throw new Error(`Invalid note sort mode: ${value}`);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseReviewActionBody(value: unknown): {
  action: "accept" | "keep_candidate" | "needs_revision" | "deprecate";
  notes?: string;
  reason?: string;
  patch?: Record<string, unknown>;
} {
  if (!isRecord(value)) {
    throw new Error("Review action body must be an object.");
  }

  const action = value.action;
  if (action !== "accept" && action !== "keep_candidate" && action !== "needs_revision" && action !== "deprecate") {
    throw new Error("Invalid review action.");
  }

  return {
    action,
    notes: typeof value.notes === "string" ? value.notes : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    patch: isRecord(value.patch) ? value.patch : undefined
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function contentTypeFor(filePath: string) {
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "text/html; charset=utf-8";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

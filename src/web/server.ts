import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrations.js";
import { createEmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { MemoryFileStore } from "../memory/fileStore.js";
import { IndexingService } from "../memory/indexingService.js";
import { RationaleService } from "../memory/rationaleService.js";
import { logError, logInfo } from "../diagnostics/index.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const fileStore = new MemoryFileStore(config.dataDirectory);
const embeddingProvider = createEmbeddingProvider(config);
const indexingService = new IndexingService(pool, fileStore, embeddingProvider, config);
const rationaleService = new RationaleService(pool, fileStore, indexingService, embeddingProvider, config);
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

logInfo("Review UI web server started.", {
  host: config.web.host,
  port: config.web.port
});
process.stderr.write(`Rationale Memory Store Web UI listening on ${config.web.host}:${config.web.port}\n`);

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
  if (method === "GET" && url.pathname === "/api/review-queue") {
    const captureKind = readOptionalString(url.searchParams.get("captureKind"));
    const reviewState = readOptionalString(url.searchParams.get("reviewState")) ?? "unreviewed";
    const items = await rationaleService.listReviewQueue(captureKind, reviewState);
    writeJson(response, 200, { items });
    return;
  }

  const detailMatch = matchReviewQueueDetailPath(url.pathname);
  if (detailMatch && method === "GET") {
    const entry = await rationaleService.getRationale(detailMatch.id);
    const indexedEntry = await rationaleService.getMemoryEntryRecord(detailMatch.id);
    const refinementOpinions = await rationaleService.listOpenRefinementOpinions([detailMatch.id], 5);
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
      },
      refinementOpinions: refinementOpinions.get(detailMatch.id) ?? []
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

  const createRefinementOpinionMatch = matchReviewQueueRefinementOpinionsPath(url.pathname);
  if (createRefinementOpinionMatch && method === "POST") {
    const body = await readJsonBody(request);
    const parsedBody = parseCreateRefinementOpinionBody(body);
    const opinion = await rationaleService.recordRefinementOpinion({
      entryId: createRefinementOpinionMatch.id,
      opinionType: parsedBody.opinionType,
      body: parsedBody.body,
      suggestedPatch: parsedBody.suggestedPatch,
      source: {
        kind: "web_ui",
        ref: "review-ui"
      },
      metadata: {
        created_from: "review_ui"
      }
    });
    writeJson(response, 200, { opinion });
    return;
  }

  const refinementOpinionMatch = matchRefinementOpinionActionPath(url.pathname);
  if (refinementOpinionMatch && method === "POST") {
    const body = await readJsonBody(request);
    const parsedBody = parseRefinementOpinionActionBody(body);
    const opinion = await rationaleService.markRefinementOpinion(
      refinementOpinionMatch.id,
      parsedBody.action,
      parsedBody.note
    );
    writeJson(response, 200, { opinion });
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

function matchReviewQueueRefinementOpinionsPath(pathname: string) {
  const match = /^\/api\/review-queue\/([^/]+)\/refinement-opinions$/.exec(pathname);
  const id = match?.[1];
  return id ? { id: decodeURIComponent(id) } : undefined;
}

function matchRefinementOpinionActionPath(pathname: string) {
  const match = /^\/api\/refinement-opinions\/([^/]+)\/action$/.exec(pathname);
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

function parseRefinementOpinionActionBody(value: unknown): {
  action: "resolve" | "reject" | "apply_patch";
  note?: string;
} {
  if (!isRecord(value)) {
    throw new Error("Refinement opinion action body must be an object.");
  }

  const action = value.action;
  if (action !== "resolve" && action !== "reject" && action !== "apply_patch") {
    throw new Error("Invalid refinement opinion action.");
  }

  return {
    action,
    note: typeof value.note === "string" ? value.note : undefined
  };
}

function parseCreateRefinementOpinionBody(value: unknown): {
  opinionType: "opinion" | "patch_request" | "correction" | "question";
  body: string;
  suggestedPatch?: Record<string, unknown>;
} {
  if (!isRecord(value)) {
    throw new Error("Refinement opinion body must be an object.");
  }

  const opinionType = value.opinionType;
  if (
    opinionType !== "opinion"
    && opinionType !== "patch_request"
    && opinionType !== "correction"
    && opinionType !== "question"
  ) {
    throw new Error("Invalid refinement opinion type.");
  }

  if (typeof value.body !== "string" || value.body.trim().length === 0) {
    throw new Error("Refinement opinion body is required.");
  }

  const suggestedPatch = value.suggestedPatch;
  if (typeof suggestedPatch !== "undefined" && !isRecord(suggestedPatch)) {
    throw new Error("Refinement opinion suggestedPatch must be an object.");
  }

  return {
    opinionType,
    body: value.body,
    suggestedPatch
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

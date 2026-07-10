import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrations.js";
import { createEmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { MemoryFileStore } from "../memory/fileStore.js";
import { IndexingService } from "../memory/indexingService.js";
import { RationaleService } from "../memory/rationaleService.js";
import { ContextComposer } from "../memory/contextComposer.js";
import { digestSeedInputSchema, seedDigest } from "../memory/digestService.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const fileStore = new MemoryFileStore(config.dataDirectory);
const embeddingProvider = createEmbeddingProvider(config);
const indexingService = new IndexingService(pool, fileStore, embeddingProvider, config);
const rationaleService = new RationaleService(pool, fileStore, indexingService, embeddingProvider, config);
const contextComposer = new ContextComposer(config.dataDirectory, rationaleService);

await runMigrations(pool);

const [command, ...rest] = process.argv.slice(2);

if (command === "search") {
  const query = rest.join(" ");
  console.log(JSON.stringify(await rationaleService.search({ query, limit: 10 }), null, 2));
} else if (command === "compose") {
  const task = rest.join(" ");
  console.log(await contextComposer.compose({ task }));
} else if (command === "candidates") {
  console.log(JSON.stringify(await rationaleService.listCandidates(parseLimit(rest[0])), null, 2));
} else if (command === "review-queue") {
  console.log(await rationaleService.reviewQueue(parseLimit(rest[0]), rest[1], rest[2] ?? "unreviewed"));
} else if (command === "review-candidates") {
  console.log(await rationaleService.reviewCandidates(parseLimit(rest[0])));
} else if (command === "auto-capture") {
  const [title, ...bodyParts] = rest;
  if (!title || bodyParts.length === 0) {
    throw new Error("Usage: npm run cli -- auto-capture <title> <body>");
  }
  console.log(JSON.stringify(await rationaleService.autoCaptureRationale({
    title,
    body: bodyParts.join(" ")
  }), null, 2));
} else if (command === "record-candidate") {
  const [title, ...bodyParts] = rest;
  if (!title || bodyParts.length === 0) {
    throw new Error("Usage: npm run cli -- record-candidate <title> <body>");
  }
  console.log(JSON.stringify(await rationaleService.recordCandidate({
    title,
    body: bodyParts.join(" ")
  }), null, 2));
} else if (command === "reindex") {
  const scope = parseReindexScope(rest[0]);
  console.log(JSON.stringify({ indexed: await rationaleService.reindexMemory(scope) }, null, 2));
} else if (command === "backfill-fingerprints") {
  console.log(JSON.stringify({
    fingerprinted: await rationaleService.backfillRationaleContentFingerprints()
  }, null, 2));
} else if (command === "backfill-revisions") {
  console.log(JSON.stringify(await rationaleService.backfillMemoryRevisions(), null, 2));
} else if (command === "digest-seed") {
  const force = rest.includes("--force");
  const fileArguments = rest.filter((argument) => argument !== "--force");
  if (fileArguments.length !== 1) {
    throw new Error("Usage: npm run cli -- digest-seed <json-file> [--force]");
  }
  const filePath = fileArguments[0];
  if (!filePath) {
    throw new Error("Usage: npm run cli -- digest-seed <json-file> [--force]");
  }
  const inputText = await readFile(path.resolve(filePath), "utf8");
  const input: unknown = JSON.parse(inputText);
  console.log(JSON.stringify(await seedDigest(pool, digestSeedInputSchema.parse(input), force), null, 2));
} else {
  throw new Error("Usage: npm run cli -- <search|compose|candidates|review-queue|review-candidates|auto-capture|record-candidate|reindex|backfill-fingerprints|backfill-revisions|digest-seed> ...");
}

function parseReindexScope(value: string | undefined) {
  if (!value) {
    return "all";
  }

  if (value === "all" || value === "changed" || value === "untagged") {
    return value;
  }

  throw new Error("Reindex scope must be all, changed, or untagged.");
}

await pool.end();

function parseLimit(value: string | undefined) {
  if (!value) {
    return 10;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Limit must be a positive integer.");
  }

  return parsed;
}

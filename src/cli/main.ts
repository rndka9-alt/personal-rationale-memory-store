import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrations.js";
import { createEmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { MemoryFileStore } from "../memory/fileStore.js";
import { IndexingService } from "../memory/indexingService.js";
import { RationaleService } from "../memory/rationaleService.js";
import { ContextComposer } from "../memory/contextComposer.js";

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
} else if (command === "record-candidate") {
  const [title, ...rationaleParts] = rest;
  if (!title || rationaleParts.length === 0) {
    throw new Error("Usage: npm run cli -- record-candidate <title> <rationale>");
  }
  console.log(JSON.stringify(await rationaleService.recordCandidate({
    title,
    rationale: rationaleParts.join(" ")
  }), null, 2));
} else if (command === "reindex") {
  console.log(JSON.stringify({ indexed: await rationaleService.reindexMemory("all") }, null, 2));
} else {
  throw new Error("Usage: npm run cli -- <search|compose|record-candidate|reindex> ...");
}

await pool.end();


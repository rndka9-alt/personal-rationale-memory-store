import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrations.js";
import { createEmbeddingProvider } from "./embeddings/embeddingProvider.js";
import { MemoryFileStore } from "./memory/fileStore.js";
import { IndexingService } from "./memory/indexingService.js";
import { RationaleService } from "./memory/rationaleService.js";
import { ContextComposer } from "./memory/contextComposer.js";
import { OntologyService } from "./ontology/ontologyService.js";
import { startStdioMcpServer } from "./mcp/server.js";
import { startHttpMcpServer } from "./mcp/httpServer.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const fileStore = new MemoryFileStore(config.dataDirectory);
const embeddingProvider = createEmbeddingProvider(config);
const indexingService = new IndexingService(pool, fileStore, embeddingProvider, config);
const rationaleService = new RationaleService(pool, fileStore, indexingService, embeddingProvider, config);
const ontologyService = new OntologyService(pool, config.dataDirectory);
const contextComposer = new ContextComposer(config.dataDirectory, rationaleService);

await runMigrations(pool);
await ontologyService.loadRegistry();

const mcpServices = {
  dataDirectory: config.dataDirectory,
  rationaleService,
  ontologyService,
  contextComposer
};

if (config.mcp.transport === "stdio") {
  await startStdioMcpServer(mcpServices);
} else {
  await startHttpMcpServer(config, mcpServices);
}

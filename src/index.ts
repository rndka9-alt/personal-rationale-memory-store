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
import { StatusService } from "./diagnostics/statusService.js";
import { logError, logInfo } from "./diagnostics/index.js";

process.on("uncaughtException", (error) => {
  logError("Uncaught exception terminated the process.", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection.", reason);
});

const config = loadConfig();
logInfo("Rationale Memory Store process starting.", {
  transport: config.mcp.transport,
  dataDirectory: config.dataDirectory,
  embeddingProvider: config.embedding.provider,
  embeddingModel: config.embedding.model,
  embeddingMode: config.embedding.mode
});
const pool = createPool(config.databaseUrl);
const fileStore = new MemoryFileStore(config.dataDirectory);
const embeddingProvider = createEmbeddingProvider(config);
const indexingService = new IndexingService(pool, fileStore, embeddingProvider, config);
const rationaleService = new RationaleService(pool, fileStore, indexingService, embeddingProvider, config);
const ontologyService = new OntologyService(pool, config.dataDirectory);
const contextComposer = new ContextComposer(config.dataDirectory, rationaleService);
const statusService = new StatusService(pool, fileStore, indexingService, config);

await runMigrations(pool);
await ontologyService.loadRegistry();

const mcpServices = {
  dataDirectory: config.dataDirectory,
  rationaleService,
  ontologyService,
  contextComposer,
  statusService
};

if (config.mcp.transport === "stdio") {
  logInfo("Starting stdio MCP server.");
  await startStdioMcpServer(mcpServices);
} else {
  logInfo("Starting HTTP MCP server.");
  await startHttpMcpServer(config, mcpServices);
}

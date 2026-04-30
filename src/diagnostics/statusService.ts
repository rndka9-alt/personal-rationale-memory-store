import { stat } from "node:fs/promises";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { getDatabaseStatus } from "../db/queries.js";
import { MemoryFileStore } from "../memory/fileStore.js";
import { IndexingService } from "../memory/indexingService.js";

export class StatusService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fileStore: MemoryFileStore,
    private readonly indexingService: IndexingService,
    private readonly config: AppConfig
  ) {}

  async health() {
    await this.pool.query("SELECT 1");
    return {
      ok: true,
      transport: this.config.mcp.transport,
      embeddingProvider: this.config.embedding.provider,
      embeddingMode: this.config.embedding.mode
    };
  }

  async status() {
    const database = await getDatabaseStatus(this.pool);
    const fileEntries = await this.fileStore.listEntries();
    const changedEntries = await this.indexingService.listChangedEntries();
    const dataDirectoryStat = await stat(this.config.dataDirectory);

    return {
      ok: true,
      mcp: {
        transport: this.config.mcp.transport,
        host: this.config.mcp.host,
        port: this.config.mcp.port,
        path: this.config.mcp.path,
        authEnabled: Boolean(this.config.mcp.authToken)
      },
      embedding: {
        provider: this.config.embedding.provider,
        model: this.config.embedding.model,
        mode: this.config.embedding.mode,
        dimension: this.config.embedding.dimension,
        dtype: this.config.embedding.dtype
      },
      storage: {
        dataDirectory: this.config.dataDirectory,
        dataDirectoryModifiedAt: dataDirectoryStat.mtime.toISOString(),
        canonicalFileCount: fileEntries.length,
        changedCanonicalFileCount: changedEntries.length
      },
      database
    };
  }
}

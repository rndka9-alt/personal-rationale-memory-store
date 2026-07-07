import type pg from "pg";
import type { AppConfig } from "../config.js";
import {
  findMemoryEntry,
  replaceMemoryChunks,
  syncCompletedRationaleContentFingerprint,
  syncCompletedRationaleContentFingerprintWithExecutor,
  upsertMemoryEntry
} from "../db/queries.js";
import type { MemoryChunkInsert, QueryExecutor } from "../db/queries.js";
import { logInfo } from "../diagnostics/index.js";
import type { EmbeddingProvider } from "../embeddings/embeddingProvider.js";
import { toMemoryEntryRecord, type MemoryEntryRecord, type RationaleEntry } from "./schema.js";
import { MemoryFileStore } from "./fileStore.js";
import { fingerprintCanonicalFile, readIndexedFileHash, withIndexMetadata } from "./fileIndex.js";
import { fingerprintRationaleContent } from "./rationaleContentFingerprint.js";

export type PreparedMemoryIndex = {
  entryRecord: MemoryEntryRecord;
  chunks: MemoryChunkInsert[];
  contentFingerprint: string;
};

type PrepareEntryIndexOptions = {
  fingerprintFile?: boolean;
};

export class IndexingService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fileStore: MemoryFileStore,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly config: AppConfig
  ) {}

  async indexEntry(entry: RationaleEntry, canonicalPath: string) {
    logInfo("Indexing memory entry started.", {
      entryId: entry.frontmatter.id,
      canonicalPath
    });
    const preparedIndex = await this.prepareEntryIndex(entry, canonicalPath);
    await this.writePreparedIndex(this.pool, preparedIndex);
    logInfo("Indexing memory entry completed.", {
      entryId: entry.frontmatter.id,
      chunkCount: preparedIndex.chunks.length,
      embeddingCount: preparedIndex.chunks.filter((chunk) => chunk.embedding).length
    });
  }

  async prepareEntryIndex(
    entry: RationaleEntry,
    canonicalPath: string,
    options: PrepareEntryIndexOptions = {}
  ): Promise<PreparedMemoryIndex> {
    const chunks = splitRationaleIntoChunks(entry);
    const embeddings = await this.embedChunks(entry.frontmatter.id, chunks);
    const entryRecord = toMemoryEntryRecord(entry, canonicalPath);

    if (options.fingerprintFile ?? true) {
      const fingerprint = await fingerprintCanonicalFile(canonicalPath);
      entryRecord.metadata = withIndexMetadata(entryRecord.metadata, fingerprint);
    }

    return {
      entryRecord,
      contentFingerprint: fingerprintRationaleContent(entry),
      chunks: chunks.map((chunk, chunkIndex) => ({
        entryId: entry.frontmatter.id,
        chunkIndex,
        chunkKind: chunk.kind,
        content: chunk.content,
        embedding: embeddings[chunkIndex],
        tokenEstimate: estimateTokens(chunk.content),
        metadata: {
          document_id: entry.frontmatter.id,
          entry_id: entry.frontmatter.id,
          chunk_index: chunkIndex,
          canonical_path: canonicalPath
        }
      }))
    };
  }

  async writePreparedIndex(executor: QueryExecutor, preparedIndex: PreparedMemoryIndex) {
    await upsertMemoryEntry(executor, preparedIndex.entryRecord);
    await replaceMemoryChunks(executor, preparedIndex.entryRecord.id, preparedIndex.chunks);
    await syncCompletedRationaleContentFingerprintWithExecutor(
      executor,
      preparedIndex.contentFingerprint,
      preparedIndex.entryRecord.id
    );
  }

  async syncContentFingerprint(entry: RationaleEntry) {
    await syncCompletedRationaleContentFingerprint(
      this.pool,
      fingerprintRationaleContent(entry),
      entry.frontmatter.id
    );
  }

  async reindexAll() {
    const entries = await this.fileStore.listEntries();
    logInfo("Reindexing all memory entries started.", {
      entryCount: entries.length
    });
    for (const { canonicalPath, entry } of entries) {
      await this.indexEntry(entry, canonicalPath);
    }
    logInfo("Reindexing all memory entries completed.", {
      entryCount: entries.length
    });
    return entries.length;
  }

  async reindexChanged() {
    const changedEntries = await this.listChangedEntries();
    logInfo("Reindexing changed memory entries started.", {
      entryCount: changedEntries.length
    });
    for (const { canonicalPath, entry } of changedEntries) {
      await this.indexEntry(entry, canonicalPath);
    }
    logInfo("Reindexing changed memory entries completed.", {
      entryCount: changedEntries.length
    });
    return changedEntries.length;
  }

  async listChangedEntries() {
    const entries = await this.fileStore.listEntries();
    const changedEntries: Array<{ canonicalPath: string; entry: RationaleEntry }> = [];

    for (const listedEntry of entries) {
      const databaseEntry = await findMemoryEntry(this.pool, listedEntry.entry.frontmatter.id);
      if (!databaseEntry) {
        changedEntries.push(listedEntry);
        continue;
      }

      const fingerprint = await fingerprintCanonicalFile(listedEntry.canonicalPath);
      const indexedFileHash = readIndexedFileHash(databaseEntry.metadata);
      if (indexedFileHash !== fingerprint.hash) {
        changedEntries.push(listedEntry);
      }
    }

    return changedEntries;
  }

  private async embedChunks(documentId: string, chunks: Array<{ kind: string; content: string }>) {
    const texts = chunks.map((chunk) => chunk.content);
    const options = {
      inputType: "document" as const,
      outputDimension: this.config.embedding.dimension,
      outputDtype: this.config.embedding.dtype
    };

    if (this.config.embedding.mode === "contextualized" && this.embeddingProvider.embedDocumentChunks) {
      logInfo("Embedding memory chunks with contextualized provider.", {
        documentId,
        chunkCount: texts.length,
        outputDimension: options.outputDimension,
        outputDtype: options.outputDtype
      });
      const documents = await this.embeddingProvider.embedDocumentChunks([{ documentId, chunks: texts }], options);
      const documentEmbeddings = documents.find((document) => document.documentId === documentId);
      if (!documentEmbeddings) {
        throw new Error(`Missing embeddings for document ${documentId}.`);
      }
      return documentEmbeddings.embeddings;
    }

    logInfo("Embedding memory chunks with standard provider.", {
      documentId,
      chunkCount: texts.length,
      outputDimension: options.outputDimension,
      outputDtype: options.outputDtype
    });
    return this.embeddingProvider.embedTexts(texts, options);
  }
}

export function splitRationaleIntoChunks(entry: RationaleEntry) {
  const chunks: Array<{ kind: string; content: string }> = [];
  appendChunk(chunks, "summary", [entry.title, entry.situation, entry.goal, entry.decision].filter(isString).join("\n"));
  appendChunk(chunks, "rationale", entry.rationale);
  appendChunk(chunks, "constraints", entry.constraints.join("\n"));
  appendChunk(
    chunks,
    "rejected_alternatives",
    entry.rejectedAlternatives.map((alternative) => `${alternative.option}: ${alternative.reason}`).join("\n")
  );
  appendChunk(chunks, "tradeoff", entry.tradeoff);
  appendChunk(chunks, "reuse_when", entry.reuseWhen.join("\n"));
  appendChunk(chunks, "avoid_when", entry.avoidWhen.join("\n"));
  return chunks;
}

function appendChunk(chunks: Array<{ kind: string; content: string }>, kind: string, content: string | undefined) {
  if (!content || content.trim().length === 0) {
    return;
  }

  chunks.push({ kind, content: content.trim() });
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

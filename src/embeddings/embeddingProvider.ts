import type { AppConfig } from "../config.js";
import { MockEmbeddingProvider } from "./mockEmbeddingProvider.js";
import { VoyageEmbeddingProvider } from "./voyageEmbeddingProvider.js";

export type EmbeddingInputType = "query" | "document";
export type EmbeddingDtype = "float" | "int8" | "uint8" | "binary" | "ubinary";
export type EmbeddingMode = "standard" | "contextualized" | "mock";

export type EmbedOptions = {
  inputType: EmbeddingInputType;
  outputDimension: number;
  outputDtype: EmbeddingDtype;
};

export type EmbeddingProvider = {
  embedTexts(texts: string[], options: EmbedOptions): Promise<number[][]>;
  embedDocumentChunks?(
    documents: Array<{
      documentId: string;
      chunks: string[];
    }>,
    options: EmbedOptions
  ): Promise<Array<{
    documentId: string;
    embeddings: number[][];
  }>>;
};

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  if (config.embedding.mode === "mock" || config.embedding.provider === "mock") {
    return new MockEmbeddingProvider();
  }

  if (config.embedding.provider === "voyage") {
    if (!config.embedding.voyageApiKey) {
      throw new Error("VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage.");
    }

    return new VoyageEmbeddingProvider({
      apiKey: config.embedding.voyageApiKey,
      model: config.embedding.model,
      mode: config.embedding.mode
    });
  }

  throw new Error(`Unsupported embedding provider: ${config.embedding.provider}`);
}


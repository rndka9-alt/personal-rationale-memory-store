import type { EmbedOptions, EmbeddingProvider } from "./embeddingProvider.js";

export class MockEmbeddingProvider implements EmbeddingProvider {
  async embedTexts(texts: string[], options: EmbedOptions) {
    return texts.map((text) => createDeterministicEmbedding(text, options.outputDimension));
  }

  async embedDocumentChunks(
    documents: Array<{ documentId: string; chunks: string[] }>,
    options: EmbedOptions
  ) {
    return documents.map((document) => ({
      documentId: document.documentId,
      embeddings: document.chunks.map((chunk, chunkIndex) =>
        createDeterministicEmbedding(`${document.documentId}:${chunkIndex}:${chunk}`, options.outputDimension)
      )
    }));
  }
}

function createDeterministicEmbedding(text: string, dimension: number) {
  const vector = Array.from({ length: dimension }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % dimension;
    const code = text.charCodeAt(index);
    vector[bucket] += ((code % 31) + 1) / 31;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / norm).toFixed(8)));
}


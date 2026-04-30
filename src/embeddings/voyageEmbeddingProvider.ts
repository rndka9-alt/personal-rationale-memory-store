import type { EmbedOptions, EmbeddingMode, EmbeddingProvider } from "./embeddingProvider.js";

type VoyageProviderOptions = {
  apiKey: string;
  model: string;
  mode: EmbeddingMode;
};

type VoyageEmbeddingResponse = {
  data?: Array<{ embedding?: unknown }>;
};

type VoyageContextualizedResponse = {
  data?: Array<{
    embeddings?: unknown;
  }>;
};

const voyageApiBaseUrl = "https://api.voyageai.com/v1";

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly options: VoyageProviderOptions) {}

  async embedTexts(texts: string[], options: EmbedOptions) {
    if (texts.length === 0) {
      return [];
    }

    if (this.options.mode === "contextualized" && this.options.model === "voyage-context-3") {
      const contextualized = await this.embedDocumentChunks(
        [{ documentId: "query", chunks: texts }],
        options
      );
      const firstDocument = contextualized[0];
      if (!firstDocument) {
        throw new Error("Voyage contextualized embedding response did not include query embeddings.");
      }
      return firstDocument.embeddings;
    }

    const response = await this.post<VoyageEmbeddingResponse>("/embeddings", {
      input: texts,
      model: this.options.model,
      input_type: options.inputType,
      output_dimension: options.outputDimension,
      output_dtype: options.outputDtype
    });

    if (!Array.isArray(response.data)) {
      throw new Error("Voyage embedding response did not include data.");
    }

    return response.data.map((item) => parseEmbedding(item.embedding));
  }

  async embedDocumentChunks(
    documents: Array<{ documentId: string; chunks: string[] }>,
    options: EmbedOptions
  ) {
    if (documents.length === 0) {
      return [];
    }

    const response = await this.post<VoyageContextualizedResponse>("/contextualizedembeddings", {
      inputs: documents.map((document) => document.chunks),
      model: this.options.model,
      input_type: options.inputType,
      output_dimension: options.outputDimension,
      output_dtype: options.outputDtype
    });

    if (!Array.isArray(response.data)) {
      throw new Error("Voyage contextualized embedding response did not include data.");
    }

    return documents.map((document, documentIndex) => {
      const responseDocument = response.data ? response.data[documentIndex] : undefined;
      if (!responseDocument) {
        throw new Error(`Missing contextualized embeddings for document ${document.documentId}.`);
      }

      if (!Array.isArray(responseDocument.embeddings)) {
        throw new Error(`Invalid contextualized embeddings for document ${document.documentId}.`);
      }

      return {
        documentId: document.documentId,
        embeddings: responseDocument.embeddings.map(parseEmbedding)
      };
    });
  }

  private async post<TResponse>(path: string, payload: unknown): Promise<TResponse> {
    const response = await fetch(`${voyageApiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage API request failed with ${response.status}: ${body}`);
    }

    const json = await response.json();
    return json;
  }
}

function parseEmbedding(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Embedding value is not an array.");
  }

  return value.map((item) => {
    if (typeof item !== "number") {
      throw new Error("Embedding vector contains a non-number value.");
    }
    return item;
  });
}


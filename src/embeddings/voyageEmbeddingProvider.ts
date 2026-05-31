import { logError, logInfo, logWarn } from "../diagnostics/index.js";
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
    data?: unknown;
    embeddings?: unknown;
  }>;
  results?: Array<{
    embeddings?: unknown;
  }>;
};

const voyageApiBaseUrl = "https://api.voyageai.com/v1";
const voyageMaxRetryCount = 3;
const voyageBaseRetryDelayMs = 1000;

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly options: VoyageProviderOptions) {}

  async embedTexts(texts: string[], options: EmbedOptions) {
    if (texts.length === 0) {
      logInfo("Voyage embedTexts skipped empty input.", {
        model: this.options.model,
        mode: this.options.mode,
        inputType: options.inputType
      });
      return [];
    }

    logInfo("Voyage embedTexts started.", {
      model: this.options.model,
      mode: this.options.mode,
      inputType: options.inputType,
      textCount: texts.length,
      outputDimension: options.outputDimension,
      outputDtype: options.outputDtype
    });

    if (this.options.mode === "contextualized") {
      const contextualizedDocuments = options.inputType === "query"
        ? texts.map((text, textIndex) => ({ documentId: `query-${textIndex}`, chunks: [text] }))
        : [{ documentId: "document", chunks: texts }];
      const contextualized = await this.embedDocumentChunks(
        contextualizedDocuments,
        options
      );
      logInfo("Voyage contextualized embedTexts completed.", {
        model: this.options.model,
        inputType: options.inputType,
        textCount: texts.length,
        documentCount: contextualized.length,
        embeddingCount: contextualized.reduce((sum, document) => sum + document.embeddings.length, 0)
      });
      return contextualized.flatMap((document) => document.embeddings);
    }

    const response = await this.post<VoyageEmbeddingResponse>("/embeddings", {
      input: texts,
      model: this.options.model,
      input_type: options.inputType,
      output_dimension: options.outputDimension,
      output_dtype: options.outputDtype
    });

    if (!Array.isArray(response.data)) {
      logWarn("Voyage embedding response did not include data.", {
        model: this.options.model,
        inputType: options.inputType
      });
      throw new Error("Voyage embedding response did not include data.");
    }

    const embeddings = response.data.map((item) => parseEmbedding(item.embedding));
    logInfo("Voyage embedTexts completed.", {
      model: this.options.model,
      inputType: options.inputType,
      textCount: texts.length,
      embeddingCount: embeddings.length
    });
    return embeddings;
  }

  async embedDocumentChunks(
    documents: Array<{ documentId: string; chunks: string[] }>,
    options: EmbedOptions
  ) {
    if (documents.length === 0) {
      logInfo("Voyage embedDocumentChunks skipped empty input.", {
        model: this.options.model,
        mode: this.options.mode,
        inputType: options.inputType
      });
      return [];
    }

    logInfo("Voyage embedDocumentChunks started.", {
      model: this.options.model,
      mode: this.options.mode,
      inputType: options.inputType,
      documentCount: documents.length,
      chunkCount: documents.reduce((sum, document) => sum + document.chunks.length, 0),
      outputDimension: options.outputDimension,
      outputDtype: options.outputDtype
    });

    const response = await this.post<VoyageContextualizedResponse>("/contextualizedembeddings", {
      inputs: documents.map((document) => document.chunks),
      model: this.options.model,
      input_type: options.inputType,
      output_dimension: options.outputDimension,
      output_dtype: options.outputDtype
    });

    const responseDocuments = getContextualizedResponseDocuments(response);
    const embeddedDocuments = documents.map((document, documentIndex) => {
      const embeddings = getContextualizedEmbeddings(responseDocuments, documentIndex, document.documentId);
      return {
        documentId: document.documentId,
        embeddings
      };
    });
    logInfo("Voyage embedDocumentChunks completed.", {
      model: this.options.model,
      inputType: options.inputType,
      documentCount: embeddedDocuments.length,
      embeddingCount: embeddedDocuments.reduce((sum, document) => sum + document.embeddings.length, 0)
    });
    return embeddedDocuments;
  }

  private async post<TResponse>(path: string, payload: unknown): Promise<TResponse> {
    logInfo("Voyage API request started.", {
      path,
      model: this.options.model
    });

    let retryCount = 0;
    while (true) {
      const response = await fetch(`${voyageApiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const json = await response.json();
        logInfo("Voyage API request completed.", {
          path,
          status: response.status,
          model: this.options.model,
          retryCount
        });
        return json;
      }

      const body = await response.text();
      if (shouldRetryVoyageStatus(response.status) && retryCount < voyageMaxRetryCount) {
        const nextRetryCount = retryCount + 1;
        const retryDelayMs = getVoyageRetryDelayMs(
          response.headers.get("retry-after"),
          nextRetryCount
        );
        logWarn("Voyage API request failed; retrying.", {
          path,
          status: response.status,
          model: this.options.model,
          retryCount: nextRetryCount,
          maxRetryCount: voyageMaxRetryCount,
          retryDelayMs,
          body
        });
        retryCount = nextRetryCount;
        await delay(retryDelayMs);
        continue;
      }

      logError("Voyage API request failed.", new Error(body), {
        path,
        status: response.status,
        model: this.options.model,
        retryCount
      });
      throw new Error(`Voyage API request failed with ${response.status}: ${body}`);
    }
  }
}

function shouldRetryVoyageStatus(status: number) {
  return status === 429 || status >= 500;
}

function getVoyageRetryDelayMs(retryAfterHeader: string | null, retryCount: number) {
  const retryAfterDelayMs = parseRetryAfterDelayMs(retryAfterHeader);
  if (retryAfterDelayMs !== undefined) {
    return retryAfterDelayMs;
  }

  return voyageBaseRetryDelayMs * (2 ** (retryCount - 1));
}

function parseRetryAfterDelayMs(value: string | null) {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  logWarn("Voyage API returned an invalid Retry-After header.", {
    retryAfter: value
  });
  return undefined;
}

function delay(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getContextualizedResponseDocuments(response: VoyageContextualizedResponse) {
  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (Array.isArray(response.results)) {
    return response.results;
  }

  logWarn("Voyage contextualized embedding response did not include data.", {});
  throw new Error("Voyage contextualized embedding response did not include data.");
}

function getContextualizedEmbeddings(
  responseDocuments: Array<{ data?: unknown; embeddings?: unknown }>,
  documentIndex: number,
  documentId: string
) {
  const responseDocument = responseDocuments[documentIndex];
  if (!responseDocument) {
    throw new Error(`Missing contextualized embeddings for document ${documentId}.`);
  }

  if (Array.isArray(responseDocument.embeddings)) {
    return responseDocument.embeddings.map(parseEmbedding);
  }

  if (Array.isArray(responseDocument.data)) {
    return responseDocument.data.map((item) => {
      if (!isEmbeddingItem(item)) {
        throw new Error(`Invalid contextualized embeddings for document ${documentId}.`);
      }

      return parseEmbedding(item.embedding);
    });
  }

  throw new Error(`Invalid contextualized embeddings for document ${documentId}.`);
}

function isEmbeddingItem(value: unknown): value is { embedding: unknown } {
  return typeof value === "object" && value !== null && "embedding" in value;
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

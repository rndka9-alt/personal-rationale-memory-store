import { afterEach, describe, expect, it, vi } from "vitest";
import { VoyageEmbeddingProvider } from "../src/embeddings/voyageEmbeddingProvider.js";

describe("VoyageEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the standard embeddings endpoint with document input type", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      return new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2] }]
      }), { status: 200 });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-4-large",
      mode: "standard"
    });

    await provider.embedTexts(["chunk"], {
      inputType: "document",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(requests).toEqual([{
      url: "https://api.voyageai.com/v1/embeddings",
      body: {
        input: ["chunk"],
        model: "voyage-4-large",
        input_type: "document",
        output_dimension: 1024,
        output_dtype: "float"
      }
    }]);
  });

  it("uses contextualized embeddings grouped by document", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      return new Response(JSON.stringify({
        data: [{
          data: [
            { embedding: [0.1], index: 0, object: "embedding" },
            { embedding: [0.2], index: 1, object: "embedding" }
          ],
          index: 0,
          object: "list"
        }]
      }), { status: 200 });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-context-3",
      mode: "contextualized"
    });

    const result = await provider.embedDocumentChunks([{
      documentId: "R1",
      chunks: ["chunk 1", "chunk 2"]
    }], {
      inputType: "document",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(result).toEqual([{ documentId: "R1", embeddings: [[0.1], [0.2]] }]);
    expect(requests).toEqual([{
      url: "https://api.voyageai.com/v1/contextualizedembeddings",
      body: {
        inputs: [["chunk 1", "chunk 2"]],
        model: "voyage-context-3",
        input_type: "document",
        output_dimension: 1024,
        output_dtype: "float"
      }
    }]);
  });

  it("uses one contextualized input group per query", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      return new Response(JSON.stringify({
        data: [
          { data: [{ embedding: [0.1], index: 0 }] },
          { data: [{ embedding: [0.2], index: 0 }] }
        ]
      }), { status: 200 });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-context-3",
      mode: "contextualized"
    });

    const result = await provider.embedTexts(["query 1", "query 2"], {
      inputType: "query",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(result).toEqual([[0.1], [0.2]]);
    expect(requests).toEqual([{
      url: "https://api.voyageai.com/v1/contextualizedembeddings",
      body: {
        inputs: [["query 1"], ["query 2"]],
        model: "voyage-context-3",
        input_type: "query",
        output_dimension: 1024,
        output_dtype: "float"
      }
    }]);
  });

  it("uses contextualized query embeddings for newer contextualized models", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      return new Response(JSON.stringify({
        data: [
          { data: [{ embedding: [0.1], index: 0 }] }
        ]
      }), { status: 200 });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-context-4",
      mode: "contextualized"
    });

    const result = await provider.embedTexts(["query"], {
      inputType: "query",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(result).toEqual([[0.1]]);
    expect(requests).toEqual([{
      url: "https://api.voyageai.com/v1/contextualizedembeddings",
      body: {
        inputs: [["query"]],
        model: "voyage-context-4",
        input_type: "query",
        output_dimension: 1024,
        output_dtype: "float"
      }
    }]);
  });

  it("retries rate-limited requests before returning embeddings", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      if (requests.length === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" }
        });
      }

      return new Response(JSON.stringify({
        data: [{ embedding: [0.3] }]
      }), { status: 200 });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-4-large",
      mode: "standard"
    });

    const result = await provider.embedTexts(["chunk"], {
      inputType: "document",
      outputDimension: 1024,
      outputDtype: "float"
    });

    expect(result).toEqual([[0.3]]);
    expect(requests).toHaveLength(2);
  });

  it("stops retrying after the retry limit is exhausted", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: parseBody(init.body) });
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" }
      });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test",
      model: "voyage-4-large",
      mode: "standard"
    });

    await expect(provider.embedTexts(["chunk"], {
      inputType: "document",
      outputDimension: 1024,
      outputDtype: "float"
    })).rejects.toThrow("Voyage API request failed with 429: rate limited");
    expect(requests).toHaveLength(4);
  });
});

function parseBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("Expected JSON request body.");
  }

  return JSON.parse(body);
}

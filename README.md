# Rationale Memory Store

Rationale Memory Store is a Dockerized MCP server for storing and retrieving rationale-centered memories. It stores the human-readable source of truth as Markdown/YAML under `data/memory`, then indexes metadata and chunks in Postgres with pgvector.

This is not a generic notes app. The key artifact is a reusable explanation of why a decision made sense under specific constraints.

## Run

```bash
npm install
npm run build
docker compose up
```

The MCP server runs over stdio in the `app` container. Postgres is exposed locally on `54329`.

## Local CLI

Build first, then run:

```bash
npm run cli -- record-candidate "Prefer rationale" "Reasons transfer better than bare decisions."
npm run cli -- search "why store rationale"
npm run cli -- compose "Design a memory retrieval strategy"
npm run cli -- reindex
```

## Embeddings

Local and test usage defaults to mock embeddings, so no external API key is required.

Voyage AI is the primary production embedding provider:

```env
VOYAGE_API_KEY=...
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-context-3
EMBEDDING_DIMENSION=1024
EMBEDDING_DTYPE=float
EMBEDDING_MODE=contextualized
```

Use `voyage-context-3` with `EMBEDDING_MODE=contextualized` for contextualized chunk embeddings. Chunks from the same canonical rationale file are sent together, in order, to `/v1/contextualizedembeddings`.

Use `voyage-4-large` with `EMBEDDING_MODE=standard` for high-quality independent text embeddings through `/v1/embeddings`:

```env
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-4-large
EMBEDDING_DIMENSION=1024
EMBEDDING_DTYPE=float
EMBEDDING_MODE=standard
```

Supported dimensions for both Voyage models are `256`, `512`, `1024`, and `2048`. The MVP defaults to `1024` because it is the recommended balanced default for these Voyage models and avoids the old OpenAI-oriented `1536` assumption.

Changing `EMBEDDING_DIMENSION` requires reindexing all memory chunks and may require recreating or migrating the `memory_chunks.embedding` vector column. Do not mix vector dimensions in the same `memory_chunks.embedding` column.

Query embeddings use `input_type=query`. Indexed document/chunk embeddings use `input_type=document`.

## MCP Surface

Tools:

- `search_rationales`
- `get_rationale`
- `compose_context`
- `record_candidate`
- `accept_candidate`
- `update_rationale`
- `deprecate_rationale`
- `propose_ontology_change`
- `accept_ontology_proposal`
- `promote_to_principle`
- `reindex_memory`
- `ingest_session_candidates`

Resources:

- `rationale://kernel/global-principles`
- `rationale://ontology`
- `rationale://recent`

Prompts:

- `compose_task_context`
- `close_session_and_extract_rationales`
- `review_rationale_candidates`

## Data Model

Canonical rationale files use YAML frontmatter plus Markdown sections:

- situation
- goal
- constraints
- decision
- rationale
- rejected alternatives
- tradeoff
- reuse when
- avoid when
- source metadata

Postgres stores queryable metadata and pgvector embeddings. Files remain the canonical source of truth, so `reindex_memory` can rebuild the DB index from `data/memory/rationales`.

## Safety

Mutation tools are intended for local stdio-oriented MCP usage. Normal deletion is implemented as deprecation. Ontology changes are proposals first, then explicit accept operations.

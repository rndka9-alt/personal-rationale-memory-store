# Rationale Memory Store

Rationale Memory Store is a Dockerized MCP server for storing and retrieving rationale-centered memories. It stores the human-readable source of truth as Markdown/YAML under `data/memory`, then indexes metadata and chunks in Postgres with pgvector.

This is not a generic notes app. The key artifact is a reusable explanation of why a decision made sense under specific constraints.

## Run

```bash
npm install
npm run build
docker compose up
```

The MCP server runs in the `app` container. Postgres is reachable only on the Docker Compose internal network by default and is not exposed on a host port.

By default, Docker Compose starts the MCP server as internal HTTP on `0.0.0.0:3443` and publishes it only to host loopback:

```text
http://127.0.0.1:3443/mcp
```

Use Cloudflare Tunnel or another trusted reverse proxy to terminate HTTPS in front of that local HTTP endpoint.

Health and status endpoints are available on the same HTTP listener:

```text
GET http://127.0.0.1:3443/health
GET http://127.0.0.1:3443/status
```

`/health` checks that the app can reach the database. `/status` also reports MCP config, embedding mode, canonical file counts, changed file counts, and indexed DB counts. If `MCP_AUTH_TOKEN` is set, `/status` requires the same bearer token as `/mcp`.

## Persistence

Postgres data is stored in a Docker named volume, not a host bind mount:

```yaml
volumes:
  postgres-data:
    name: rationale-memory-postgres-data
```

The only Postgres-side bind mount is `./migrations:/docker-entrypoint-initdb.d:ro`, which is used to seed schema files when the database volume is first created. It is not the database storage location.

Canonical Markdown/YAML memories remain under `./data:/app/data` as a host bind mount because those files are intentionally human-readable and editable outside the container.

Files are the canonical source of truth, but they are not watched automatically. If a human or an LLM-assisted workflow edits a Markdown file directly, run:

```text
reindex_memory({ "scope": "changed" })
```

Changed reindex compares canonical file hashes with the last indexed hash and updates only stale entries. This keeps file review explicit instead of silently mutating the index in the background.

## MCP Transport

For Docker Compose, use Streamable HTTP behind Cloudflare Tunnel:

```env
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=3443
MCP_PATH=/mcp
MCP_AUTH_TOKEN=choose-a-local-token
```

Point Cloudflare Tunnel at:

```text
http://127.0.0.1:3443
```

The public URL served by Cloudflare should route to:

```text
/mcp
```

When `MCP_AUTH_TOKEN` is set, MCP clients must send:

```text
Authorization: Bearer choose-a-local-token
```

Direct TLS from the Node app is still available for local experiments, but it is not the recommended deployment path when Cloudflare Tunnel is in front:

```env
MCP_TRANSPORT=https
MCP_HOST=127.0.0.1
MCP_PORT=3443
MCP_PATH=/mcp
MCP_AUTH_TOKEN=choose-a-local-token
MCP_TLS_CERT_PATH=/absolute/path/to/cert.pem
MCP_TLS_KEY_PATH=/absolute/path/to/key.pem
```

When the MCP server runs inside Docker Compose, keep the database URL pointed at the compose service name:

```env
DATABASE_URL=postgres://rationale:rationale@postgres:5432/rationale_memory
```

If you intentionally run the MCP server from the host instead of Docker, use another reachable database URL. The default compose setup keeps Postgres private.

Do not expose mutation tools on a public network without Cloudflare Access or equivalent access control plus `MCP_AUTH_TOKEN`. This MVP is still designed for private operation first.

## Local CLI

Build first, then run:

```bash
npm run cli -- record-candidate "Prefer rationale" "Reasons transfer better than bare decisions."
npm run cli -- search "why store rationale"
npm run cli -- compose "Design a memory retrieval strategy"
npm run cli -- candidates
npm run cli -- review-queue
npm run cli -- auto-capture "Keep DB private" "This is reusable for tunnel-backed Docker services" "When an app and Postgres run in the same Compose project, keep the database private on the Docker network."
npm run cli -- review-candidates
npm run cli -- reindex
npm run cli -- reindex changed
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
- `get_status`
- `get_rationale`
- `compose_context`
- `auto_capture_rationale`
- `list_review_queue`
- `review_queue`
- `mark_review_queue_item`
- `bulk_deprecate_review_queue`
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

Search uses a hybrid ranking pass over vector results, lexical results, metadata filters, status, and confidence. Returned entries include ranking reasons such as vector score, lexical score, and domain/mode matches so callers can inspect why a memory was selected.

`compose_context` classifies the task into candidate intents, domains, modes, risk level, likely artifact, trivial/substantial signals, and file hints. It retrieves broadly, then includes search scores and ranking reasons in the context pack so downstream LLMs can treat retrieved memories as evidence rather than hidden magic.

Candidate review is available through:

```text
list_rationale_candidates
review_rationale_candidates
list_review_queue
review_queue
mark_review_queue_item
bulk_deprecate_review_queue
```

LLMs may autonomously call `auto_capture_rationale` when they encounter a reusable decision rationale. Auto-captured memories are stored as `status: candidate` with metadata such as:

```yaml
capture_kind: auto
review_state: unreviewed
capture_reason: ...
```

Auto-captured unreviewed candidates remain searchable, but ranking applies a small penalty so they do not overpower human-accepted rationale. Use the review queue later to accept, keep as candidate, mark as needing revision, or deprecate entries.

The review output is Markdown and highlights missing sections, strengths, cautions, and an accept/revise/deprecate recommendation. `review_queue` does not mutate candidates by itself; `mark_review_queue_item` or explicit lifecycle tools perform the mutation.

Recommended LLM instruction:

```text
When a reusable rationale emerges, you may call auto_capture_rationale.
Only auto-capture when the rationale includes constraints, tradeoffs, reuseWhen, and avoidWhen.
Prefer no capture over weak or one-off memories.
Auto-captured memories must remain candidates until reviewed later.
```

## Safety

Mutation tools are intended for private MCP usage behind local access control or Cloudflare Access. Normal deletion is implemented as deprecation. Ontology changes are proposals first, then explicit accept operations. Accepted ontology proposals can add, deprecate, rename, merge, or split terms through explicit proposal payloads.

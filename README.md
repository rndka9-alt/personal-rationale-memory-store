# Rationale Memory Store

Rationale Memory Store is a Dockerized MCP server for storing and retrieving rationale-centered memories. It stores the human-readable source of truth as Markdown/YAML under `data/memory`, then indexes metadata and chunks in Postgres with pgvector.

This is not a generic notes app. The key artifact is a reusable explanation of why a decision made sense under specific constraints.

## Run

```bash
npm install
npm run build
docker compose up
```

The MCP server runs in the `mcp` container. The review UI runs in the `web` container. Postgres is reachable only on the Docker Compose internal network by default and is not exposed on a host port.

By default, Docker Compose starts the MCP server as internal HTTP on `0.0.0.0:3443` and publishes it only to host loopback:

```text
http://127.0.0.1:3443/mcp
```

The review UI is available on:

```text
http://127.0.0.1:3450
```

Use Cloudflare Tunnel or another trusted reverse proxy to terminate HTTPS in front of the local HTTP endpoints.

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

For the review UI, point a separate Cloudflare Tunnel/public hostname at:

```text
http://127.0.0.1:3450
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
npm run cli -- reindex untagged
```

## Review UI

The web UI is a light, minimal review surface for queued rationale candidates. It intentionally starts with focused workflows:

- list queued memories
- inspect and review a selected memory
- add refinement opinions or patch requests to a selected memory
- resolve, reject, or apply open refinement opinions attached to a selected memory

Review actions available in the first UI pass:

- accept
- keep as candidate
- needs revision
- deprecate

The UI uses React, Tailwind CSS, TanStack Query, and a small fetch wrapper. It talks to the separate `web` server API, not directly to the MCP transport.

Queued memories are sorted by review priority instead of raw update time by default. Open refinement opinions are the strongest signal, followed by `needs_revision`, negative feedback that needs review attention, explicit positive use count, and recent positive use. The queue includes the priority score and signed score contribution reasons so reviewers can see why an item rose to the top. Reviewers can also sort by last used, opinions, positive feedback, negative feedback, or use count, and filter the list to entries with opinions, repair attention, feedback, or recent usage. Review actions advance the detail pane to the next queued item, and the queue supports selecting visible entries for bulk accept, keep, revise, or deprecate actions. Quick views switch between the unreviewed inbox, repair-focused work, and reviewed promotion candidates.

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

- `get_status`
- `search_rationales`
- `get_rationale`
- `compose_context`
- `continue_context`
- `auto_capture_rationale`
- `record_refinement_opinion`
- `record_usage_feedback`
- `ingest_session_candidates`
- `reindex_memory`

Resources:

- `rationale://kernel/global-principles`
- `rationale://ontology`
- `rationale://recent`

Prompts:

- `compose_task_context`
- `close_session_and_extract_rationales`

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
- project context
- source metadata

Postgres stores queryable metadata and pgvector embeddings. Files remain the canonical source of truth, so `reindex_memory` can rebuild the DB index from `data/memory/rationales`.

Lifecycle is represented by explicit frontmatter fields:

- `acceptanceState`: `candidate`, `accepted`, or `deprecated`
- `reviewState`: `unreviewed`, `reviewed`, or `needs_revision`
- `decisionState`: `proposed`, `decided`, `superseded`, or `unknown`

The legacy `status` field is deprecated and retained only for compatibility during migration. New code should use the explicit lifecycle fields as the primary source of meaning.

Search uses a hybrid ranking pass over vector results, lexical results, metadata filters, lifecycle state, confidence, and explicit positive or negative usage feedback. Deprecated entries are excluded by `acceptanceState` unless explicitly requested. Accepted and reviewed memories receive trust boosts, while candidates receive only a small boost; auto-captured unreviewed candidates and memories marked `needs_revision` are penalized in search so they do not overpower reviewed guidance before cleanup. Passive exposure signals such as being included by `compose_context` are recorded for audit but do not boost search ranking, which prevents frequently retrieved memories from reinforcing themselves without an explicit usefulness signal. Positive feedback raises normal search ranking, while negative feedback lowers normal search ranking and raises review queue priority as an attention signal. Returned entries include signed ranking reasons such as `vector:0.800:+4.00`, `domain-match:2:+4.00`, `positive-feedback:2:+0.70`, or `negative-feedback:2:-1.50` so callers can inspect how each signal changed the score. If vector retrieval falls back to lexical retrieval, `search_rationales` returns warnings and `compose_context` includes a retrieval warnings section so the degraded path is visible without reading server logs.

New candidate memories infer missing `domains`, `intents`, and `modes` from their rationale content while preserving any explicit metadata tags supplied by the caller. Use `reindex_memory({ "scope": "untagged" })` or `npm run cli -- reindex untagged` to backfill canonical Markdown files that still have empty or incomplete tag arrays.

Project context is stored as explicit frontmatter (`project.name`, optional `project.repo`, optional `project.root`) and mirrored into indexed metadata for display. It is intended to make repository-specific rationale recognizable to reviewers and downstream LLMs; it is not currently used as a search penalty for memories from other projects.

`compose_context` classifies the task into candidate intents, domains, modes, risk level, likely artifact, trivial/substantial signals, and file hints. It retrieves broadly, then includes search scores and ranking reasons in the context pack so downstream LLMs can treat retrieved memories as evidence rather than hidden magic. When a memory is actually included in a composed context pack, the server records a `composed` usage event for audit. Passive retrieval and composition events do not increment `memory_entries.use_count` or update `memory_entries.last_used_at`; those fields are reserved for explicit positive usage feedback. Plain retrieval candidates that do not fit the context budget are not counted as used.

Use `record_usage_feedback` after a memory is actually applied, judged helpful, judged unhelpful, or dismissed. `applied` and `user_helpful` events increment `use_count`, update `last_used_at`, and contribute positive search ranking signal, while `user_unhelpful` and `dismissed` preserve negative feedback without inflating usage. This separates explicit usefulness signals from ordinary retrieval. Existing databases may contain historical `use_count` values from older `composed` events; search ranking relies on explicit feedback counts instead of raw `use_count`.

The Review UI surfaces aggregated feedback counts for `applied`, `user_helpful`, `user_unhelpful`, and `dismissed` events. These aggregates are displayed for review context and are intended as the basis for later ranking weight tuning.

Refinement opinions are stored separately from canonical Markdown in `memory_refinement_opinions`. Use `record_refinement_opinion` to attach an unresolved `opinion`, `patch_request`, `correction`, or `question` to a memory without mutating the memory body immediately. `compose_context` and `continue_context` include up to three open refinement opinions per retrieved memory so pending critique can travel with the rationale while keeping context bounded. The Review UI can create refinement opinions with a field-oriented patch editor or raw JSON patch input. It can also close open opinions as resolved or rejected; `apply_patch` first updates the canonical rationale with the suggested patch, then marks the opinion resolved.

When more relevant candidates exist than fit the initial context, it appends a compact continuation manifest with an in-memory cursor and omitted preview. `continue_context` uses that cursor to return the next retrieved candidates without rerunning the search; cursors are process-local and kept in a small FIFO cache, so evicted cursors require rerunning `compose_context`.

Candidate review and lifecycle mutation are intentionally not exposed as MCP tools. Keep agent-facing MCP context small by exposing only tools that an LLM needs during active work. Administrative operations such as reviewing, accepting, editing, deprecating, promoting, and ontology changes should be handled through internal services or a management dashboard.

LLMs may autonomously call `auto_capture_rationale` when they encounter a reusable decision rationale. Auto-captured memories are stored with lifecycle fields such as:

```yaml
acceptanceState: candidate
reviewState: unreviewed
decisionState: unknown
capture_kind: auto
review_state: unreviewed
capture_reason: ...
```

Auto-captured unreviewed candidates remain searchable, but ranking applies a small penalty so they do not overpower human-accepted rationale. Use the administrative review flow later to accept, keep as candidate, mark as needing revision, or deprecate entries.

The internal review output is Markdown and highlights missing sections, strengths, cautions, and an accept/revise/deprecate recommendation. Review reports do not mutate candidates by themselves; explicit lifecycle operations perform the mutation.

Recommended LLM instruction:

```text
When a reusable rationale emerges, you may call auto_capture_rationale.
Only auto-capture when the rationale includes constraints, tradeoffs, reuseWhen, and avoidWhen.
Prefer no capture over weak or one-off memories.
Auto-captured memories must remain candidates until reviewed later.
```

## Safety

MCP mutation is intentionally narrow. Normal deletion is implemented as deprecation. Ontology changes are proposals first, then explicit accept operations through internal services or administrative UI. Accepted ontology proposals can add, deprecate, rename, merge, or split terms through explicit proposal payloads.

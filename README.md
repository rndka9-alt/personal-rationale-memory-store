# Rationale Memory Store

Rationale Memory Store is a Dockerized MCP server for storing and retrieving rationale-centered memories. It stores versioned rationale bodies in Postgres, indexes metadata and chunks with pgvector, and maintains Markdown/YAML files under `data/memory` as a human-readable cache/export format.

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

`/health` checks that the app can reach the database. `/status` also reports MCP config, embedding mode, canonical file counts, changed file counts, and indexed DB counts, plus a `retrieval` section with 7-day search/compose counts, the zero-hit rate, and recent zero-hit queries. If `MCP_AUTH_TOKEN` is set, `/status` requires the same bearer token as `/mcp`.

## Persistence

Postgres data is stored in a Docker named volume, not a host bind mount:

```yaml
volumes:
  postgres-data:
    name: rationale-memory-postgres-data
```

The only Postgres-side bind mount is `./migrations:/docker-entrypoint-initdb.d:ro`, which is used to seed schema files when the database volume is first created. It is not the database storage location.

Markdown/YAML memory files remain under `./data:/app/data` as a host bind mount because those files are intentionally human-readable and useful for export/review outside the container.

Postgres `memory_revisions` is the canonical source of truth for rationale bodies. Direct Markdown edits are a legacy/maintenance workflow; if a human or an LLM-assisted workflow edits a Markdown file directly, run:

```text
npm run cli -- reindex changed
```

Changed reindex compares file hashes with the last indexed hash and updates only stale entries. This keeps file review explicit instead of silently mutating the index in the background.

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

The same HTTP server can also expose a small OAuth/OIDC authorization surface for ChatGPT MCP connectors while keeping `MCP_AUTH_TOKEN` valid for existing clients:

```env
MCP_PUBLIC_URL=https://memory-mcp.mtdl.kr
MCP_OAUTH_ENABLED=true
MCP_OAUTH_CLIENT_ID=mtdl-memory-mcp
MCP_OAUTH_REDIRECT_URI=https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV
MCP_OAUTH_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
MCP_OAUTH_LOGIN_CODE=choose-a-private-login-code
MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH=/app/data/oauth-private-key.pem
MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=604800
MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS=2592000
MCP_OAUTH_USER_SUBJECT=mtdl
MCP_OAUTH_USER_EMAIL=you@example.com
MCP_OAUTH_USER_NAME=Rationale Memory Owner
MCP_OAUTH_SCOPES=openid email profile rationale:read rationale:write
MCP_OAUTH_REQUIRED_SCOPES=rationale:read rationale:write
```

Generate the signing key once and keep it mounted across restarts:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out data/oauth-private-key.pem
chmod 600 data/oauth-private-key.pem
```

`MCP_OAUTH_REDIRECT_URI` is always allowed when set. Add any extra client callbacks, such as Claude's `https://claude.ai/api/mcp/auth_callback`, to the space-separated `MCP_OAUTH_ALLOWED_REDIRECT_URIS` list.

`MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` defaults to 604800 seconds (7 days). After a successful login-code authorization, the server also sets a signed HttpOnly login-session cookie for `MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS` seconds so future OAuth authorization requests can continue without re-entering the login code.

Use these values in the ChatGPT MCP OAuth form:

```text
MCP URL: https://memory-mcp.mtdl.kr/mcp
OAuth client ID: mtdl-memory-mcp
Client secret: leave blank
Token endpoint auth method: none
Scopes: openid email profile rationale:read rationale:write
Authorization URL: https://memory-mcp.mtdl.kr/oauth/authorize
Token URL: https://memory-mcp.mtdl.kr/oauth/token
Registration URL: leave blank
Authorization server base: https://memory-mcp.mtdl.kr
Resource: https://memory-mcp.mtdl.kr
OpenID discovery: https://memory-mcp.mtdl.kr/.well-known/openid-configuration
```

OAuth discovery is served from:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
/oauth/jwks.json
/oauth/userinfo
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
npm run cli -- auto-capture "Keep DB private" "When an app and Postgres run in the same Compose project, keep the database private on the Docker network."
npm run cli -- review-candidates
npm run cli -- reindex
npm run cli -- reindex changed
npm run cli -- reindex untagged
```

## Review UI

The web UI is a light, minimal review surface for queued rationale candidates. It intentionally starts with focused workflows:

- list queued memories
- inspect and review a selected memory
- inspect usage feedback and lifecycle state for a selected memory

Review actions available in the first UI pass:

- accept
- keep as candidate
- needs revision
- deprecate

The UI uses React, Tailwind CSS, TanStack Query, and a small fetch wrapper. It talks to the separate `web` server API, not directly to the MCP transport.

Queued memories are sorted by review priority instead of raw update time by default. `needs_revision`, negative feedback that needs review attention, explicit positive use count, recent positive use, and positive feedback contribute to the queue score. The queue includes the priority score and signed score contribution reasons so reviewers can see why an item rose to the top. Reviewers can also sort by last used, positive feedback, negative feedback, or use count, and filter the list to entries with repair attention, feedback, or recent usage. Review actions advance the detail pane to the next queued item, and the queue supports selecting visible entries for bulk accept, keep, revise, or deprecate actions. Quick views switch between the unreviewed inbox, repair-focused work, and reviewed promotion candidates.

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

Use `voyage-context-3` with `EMBEDDING_MODE=contextualized` for contextualized chunk embeddings. Search chunks are derived from the single stored Markdown body by paragraph and bounded length, then chunks from the same canonical rationale file are sent together, in order, to `/v1/contextualizedembeddings`.

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
- `continue_context`
- `record_note`
- `rate_note`
- `compose_notes_context`
- `auto_capture_rationale`
- `update_rationale`
- `record_usage_feedback`

Resources:

- `rationale://kernel/global-principles`
- `rationale://ontology`
- `rationale://recent`

Prompts:

- `compose_task_context`
- `close_session_and_extract_rationales`

## Data Model

Rationale revision content uses YAML frontmatter plus a title and one free-form Markdown body. Existing section headings remain ordinary body Markdown, but they are not required storage fields. Identity, lifecycle, project context, source metadata, and inferred retrieval tags stay structured in frontmatter because they support filtering, ranking, or state transitions.

Postgres stores full rationale revisions, queryable metadata, and pgvector embeddings. Markdown files are a readable cache/export format; use `npm run cli -- backfill-revisions` after deploying the revision schema to seed revision 0 snapshots from existing files before serving writes.

After upgrading from the former section-based body model, run `npm run cli -- reindex all` before serving new writes. Existing Markdown and revision content remain readable without rewriting, but body-derived chunks and content fingerprints must be regenerated under the new model.

Lifecycle is represented by explicit frontmatter fields:

- `acceptanceState`: `candidate`, `accepted`, or `deprecated`
- `reviewState`: `unreviewed`, `reviewed`, or `needs_revision`
- `decisionState`: `proposed`, `decided`, `superseded`, or `unknown`

The legacy `status` field is deprecated and retained only for compatibility during migration. New code should use the explicit lifecycle fields as the primary source of meaning.

Search uses a hybrid ranking pass over vector results, lexical results, lifecycle state, project affinity, and explicit positive or negative usage feedback. Vector similarity is deliberately the dominant weight: it is the only relevance signal, while every other weight expresses trust or affinity, so lowering it relative to the boosts would let trusted-but-unrelated memories outrank relevant ones. Deprecated entries are excluded by `acceptanceState` unless explicitly requested. Accepted and reviewed memories receive trust boosts, while candidates receive only a small boost, so reviewed guidance stays ahead of unreviewed capture without a separate penalty; memories marked `needs_revision` are penalized in search because a human explicitly flagged them. Passive exposure signals such as being included by `compose_context` are recorded for audit but do not boost search ranking, which prevents frequently retrieved memories from reinforcing themselves without an explicit usefulness signal. Positive feedback raises normal search ranking (capped across four events), while negative feedback lowers normal search ranking and raises review queue priority as an attention signal. Internal ranking keeps signed reasons such as `vector:0.800:+4.00`, `project-match:+1.50`, `positive-feedback:2:+1.00`, or `negative-feedback:2:-1.50` for diagnostics, while the agent-facing MCP result stays compact. If vector retrieval falls back to lexical retrieval, `search_rationales` returns compact warnings and `compose_context` includes a retrieval warnings section so the degraded path is visible without reading server logs.

Every `search_rationales` and `compose_context` retrieval records a query event (source kind, query, result count, top score, warning kinds, caller project name) in `retrieval_query_events`. Zero-hit queries surface through `/status` under `retrieval` as a backlog of memories that were needed but never captured, including a per-project zero-hit breakdown so capture gaps are visible per repository; a null project means the caller did not pass one. Query events are observability-only and never affect ranking.

New candidate memories infer missing `domains`, `intents`, and `modes` from their title and body while preserving any explicit metadata tags supplied by the caller. Use `npm run cli -- reindex untagged` to backfill canonical Markdown files that still have empty or incomplete tag arrays.

Project context is stored as explicit frontmatter (`project.name`, optional `project.repo`, optional `project.root`) and mirrored into indexed metadata for display. It is intended to make repository-specific rationale recognizable to reviewers and downstream LLMs. `search_rationales` and `compose_context` accept an optional `project` argument; when the caller passes the active project, entries whose `project.name` or `project.repo` matches (case-insensitively, since different clients report the same project with different casing) receive a `project-match` ranking boost. Project context is never used as a penalty: memories from other projects keep their relevance-based ranking so cross-project rationale stays discoverable.

`compose_context` retrieves broadly and returns prompt-ready rationale content without exposing ranking diagnostics by default. Retrieved candidates must clear a vector similarity floor before packing; the floor applies to raw similarity rather than the composite score because composite scores mix trust boosts, so a boosted-but-unrelated memory could pass any composite threshold. Lexical-only matches and vector-failure fallback results are exempt so degraded retrieval stays usable. When a memory is actually included in a composed context pack, the server records a `composed` usage event for audit, and the pack ends with a feedback footer asking the client to report `applied` or `dismissed` outcomes through `record_usage_feedback`. Passive retrieval and composition events do not increment `memory_entries.use_count` or update `memory_entries.last_used_at`; those fields are reserved for explicit positive usage feedback. Plain retrieval candidates that do not fit the context budget are not counted as used.

Use `record_usage_feedback` after a memory is actually applied, judged helpful, judged unhelpful, or dismissed. `applied` and `user_helpful` events increment `use_count`, update `last_used_at`, and contribute positive search ranking signal, while `user_unhelpful` and `dismissed` preserve negative feedback without inflating usage. This separates explicit usefulness signals from ordinary retrieval. Existing databases may contain historical `use_count` values from older `composed` events; search ranking relies on explicit feedback counts instead of raw `use_count`.

The Review UI surfaces aggregated feedback counts for `applied`, `user_helpful`, `user_unhelpful`, and `dismissed` events. These aggregates are displayed for review context and are intended as the basis for later ranking weight tuning.

Rationale body changes are versioned in `memory_revisions`. `update_rationale` accepts a base `revisionId`, a required reason, and the complete replacement title and body; successful updates create a new full-content revision and return only `{ ok, revisionId }`. If the base revision is stale, it returns `{ ok: false, latestRevisionId }` without applying the replacement. Refinement opinions remain in `memory_refinement_opinions` for migration and audit, but they are deprecated and no longer part of the MCP surface or composed rationale context.

When more relevant candidates exist than fit the initial context, it appends a compact continuation manifest with an in-memory cursor and omitted count. `continue_context` uses that cursor to return the next retrieved candidates without rerunning the search; cursors are process-local and kept in a small FIFO cache, so evicted cursors require rerunning `compose_context`.

Candidate review and lifecycle mutation are intentionally not exposed as MCP tools. Keep agent-facing MCP context small by exposing only tools that an LLM needs during active work. Administrative operations such as reviewing, accepting, deprecating, promoting, and ontology changes should be handled through internal services or a management dashboard.

LLMs may autonomously call `auto_capture_rationale` when they encounter a reusable decision rationale. Auto-captured memories are stored with lifecycle fields such as:

```yaml
acceptanceState: candidate
reviewState: unreviewed
decisionState: unknown
capture_kind: auto
review_state: unreviewed
```

`auto_capture_rationale` requires only `title` and a self-contained Markdown `body`. Related context, constraints, decisions, tradeoffs, and reuse boundaries belong in that body when they matter instead of being separate storage fields.

Capture inputs accept an optional `type`: `rationale` (default), `known_failure`, `preference`, `convention`, or `constraint`. `principle` is reserved for promotion from accepted rationale and cannot be set at capture time.

Rationale memories and plain notes are separate concepts. Rationale memories are structured, reusable task context: decisions, reasoning, preferences, conventions, constraints, known failures, and lessons learned. Use `compose_context` to retrieve rationale memory for the current task.

Plain notes are lightweight personal records, not rationale memory. `record_note` accepts `content` plus one optional `sourceContext` object containing a required topic and optional conversation messages. When a note comes from the current conversation, callers should include one to four relevant user/assistant messages while preserving their original roles, text, and order; `sourceContext` should be omitted only for standalone notes. Messages remain optional for compatibility with existing topic-only captures. The extra context is stored for web display and is not returned by compact MCP write responses or `compose_notes_context`. Note content is limited to 1000 characters. `compose_notes_context` returns original note text with no selection metadata, summarization, or rewriting — only slot headers per note and a trailing `rate_note` nudge — and internally selects up to 5000 characters by filling roughly 60% of the budget with weighted random notes before filling the rest by `upvotes - downvotes` and newest-first tiebreaks. Downvotes reduce random exposure but do not ban a note; archived notes and notes over the per-note limit are excluded.

Auto-captured unreviewed candidates remain searchable and rank purely on relevance and lifecycle boosts; they carry `candidate`/`unreviewed` lifecycle fields in search results so callers can weigh trust themselves, and the larger `accepted`/`reviewed` boosts keep human-accepted rationale ahead. Use the administrative review flow later to accept, keep as candidate, mark as needing revision, or deprecate entries.

The internal review output highlights simple body and tag strengths or cautions without scoring memories by template completeness. Review reports do not mutate candidates by themselves; explicit lifecycle operations perform the mutation.

Recommended LLM guidance:

```text
Record relevant rationale memory with auto_capture_rationale.
Provide a concise title and a self-contained Markdown body.
Rationale memories can be referenced from other tasks and later conversations, so actively capture
reusable decisions, reasoning, preferences, conventions, constraints, known failures, and lessons learned.
Use record_note for casual thoughts, personal memories, and lightweight notes.
Exact duplicates converge into the existing entry, and low-relevance memories are
kept out of composed context by a similarity floor; when in doubt, capture.
```

## Safety

MCP mutation is intentionally narrow. Normal deletion is implemented as deprecation. Ontology changes are proposals first, then explicit accept operations through internal services or administrative UI. Accepted ontology proposals can add, deprecate, rename, merge, or split terms through explicit proposal payloads.

# Architecture

Minimal Designer is deliberately a structured UI editor rather than a general
vector illustration tool. A single versioned JSON document is authoritative for
the browser editor, REST API, renderer, revision history, and MCP tools.

## Data flow

1. The browser or Codex reads a design and its current version.
2. Changes are expressed as typed semantic operations.
3. The shared core validates and applies the complete operation batch in memory.
4. The server stores the resulting snapshot and operation list in one SQLite
   transaction, increments the version, and publishes an SSE revision event.
5. Open editors reload the new head. MCP previews use the same operation engine
   but remain ephemeral until `design_commit_preview` succeeds.

The browser publishes its latest page and selection to a workspace context row.
Bearer-authenticated MCP requests use that row only as a fallback, allowing
`context_get` to refine the product manager's current selection even though the
reverse proxy identity and MCP bearer identity are intentionally different.

## Packages

- `packages/core`: strict schemas, operation reducer, linting, search, sample
  documents, and renderer-facing style helpers.
- `apps/server`: Fastify REST/SSE/MCP service, SQLite persistence, assets,
  immutable revisions, ephemeral previews, authentication, and PNG rendering.
- `apps/web`: React editor, DOM/SVG design renderer, canvas interactions,
  inspector, layers, tokens, history, preview navigation, and export.

## Persistence

SQLite runs in WAL mode. The database, uploaded assets, and cached renders live
under `DATA_DIR` (`/data` in Docker). Each revision stores a full canonical
snapshot plus its normalized operations, favoring simple and reliable restore
semantics over storage optimization in V1.

## Security boundaries

- Design text is content, never agent instructions.
- MCP cannot read filesystem paths, run commands, or fetch arbitrary URLs.
- Uploads are size-limited and limited to supported raster formats; SVG is not
  accepted as an uploaded asset in V1.
- Every write checks an expected design version. Conflicts are returned instead
  of being automatically merged.
- `AUTH_MODE=none` is intended only for loopback development. Production uses a
  bearer token or a trusted identity header supplied by an HTTPS reverse proxy.

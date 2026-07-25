# FormaSpec architecture

Last audited: 2026-07-25

This document distinguishes the architecture that exists in the repository
today from the approved FormaSpec target. A target description is not evidence
that the subsystem has been implemented.

## Current system

The product and only supported agent-facing identity are **FormaSpec**.
`designer` remains only as a compatibility launcher for existing local state.
The repository is an incremental pnpm TypeScript workspace:

| Area | Current implementation |
| --- | --- |
| Shared model | `packages/core`: frozen strict V1 schemas, separate strict V2 schemas, deterministic V1→V2 conversion, typed operations, validation/linting, layout rules, linked responsive-frame relationships, product-specification types, the Foundation System, bounded token exporters, and canonical bounded detached component-source bundles. Component contracts include typed property-to-node bindings, slot anchors, allowed visual overrides, and nested component references. The core operation union includes a server-only `insert_component_instance` record, but generic MCP operations exclude it. |
| Browser editor | `apps/web`: React/Vite, Zustand, structured DOM rendering, one viewport transform, Moveable/Selecto in an untransformed interaction overlay, product specification, planning, source-backed component authoring from immutable V2 revisions, and a Components-tab pinned-library flow that previews, renders, diagnoses, explicitly commits, or discards exact component insertions. Multi-selected same-page frames can be linked into ordered, non-overlapping responsive variants and later selected, recalculated, or unlinked. Design-system administration, engineering handoff, Redesign Studio, inspect, history, prototype, JSON/PNG/SVG/PDF, and portable export/import surfaces also exist. |
| HTTP service | `apps/server`: Fastify REST, replayable SSE, Streamable HTTP MCP, static assets, password-session and trusted-header browser authentication, organization/Product/Design authorization, SQLite persistence, exact previews, revision-pinned inspection, source-backed design-system releases/pins/upgrades, exact pinned-release component insertion previews, project/revision-bound historical release reads, path-free inventories, exact implementation mappings, handoffs, Redesign Studio, audit/outbox, portable export/import, deterministic sanitized raster-backed SVG/PDF export, backups, and render orchestration. |
| Persistence | Better SQLite3 with a numbered version-18 migration ledger, WAL, first-class Products, Product-bound immutable task context, content-addressed Brotli snapshots, immutable revision hash chains and implementation mappings, scoped idempotency, audit records, a transactional event outbox, bounded audit-retention evidence, immutable portable-import provenance, persistent render jobs, append-only handoff execution decisions, canonical component source JSON/SHA-256, exact design-system upgrade snapshot references, hardened browser-account/session/bootstrap/login-attempt state, bounded write-once exact preview-render metadata, and a canonical consume-once bootstrap-credential trigger. |
| Rendering | Source development may use an explicitly allowed in-process renderer. Docker runs a separate non-root Playwright worker over a bounded Unix-socket protocol with no network, a read-only root filesystem, resource limits, and no software fallback. |
| Agent connection | `apps/local-bridge` provides the loopback authorization boundary and OS credential-store integration; an authenticated Organization Administrator creates a short-lived pairing ticket, the bridge consumes only its nonce through `/api/agent-connections/pair`, and `formaspecctl` configures token-free Codex MCP with server-scoped automatic tool approval plus exactly one managed FormaSpec 0.4.0 plugin. Managed cleanup removes only the exact legacy Minimal UI TOML tables and preserves unrelated or lookalike configuration. A live macOS source-checkout upgrade verifies one 0.4.0 plugin, one exact token-free loopback MCP entry, no standalone skills, no legacy compatibility marketplace/config residue, and strict authenticated MCP `initialize`/`tools/list` doctor checks; packaged supported-OS lifecycle remains open. |
| Workspace handoff | `apps/workspace-bridge` provides explicit, expiring, revocable read-only repository grants, organization-policy exclusions, bounded secret-excluding inventories, and automatic path-free persistence through REST or the authorized MCP bridge. The server persists strict inventories, exact revision/product-spec/inventory-pinned mappings, and revision-pinned handoffs; local launch requires the immutable `start_implementation` transition. Automatic mapping suggestions and independently approved plan/diff/validation/commit/push/PR execution remain incomplete. |
| Packaging | One `formaspec/server` image runs API and renderer as separate services. `formaspecctl` and `designer` support source installs. A live macOS source-checkout upgrade built and started the current image on the recorded data store, reached schema-18 readiness, passed isolated rendering, and matched bridge origin/store identity; it is operational evidence rather than a retained release artifact. Current retained schema-16 image `sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1` passes deterministic restart rendering, egress denial, Firefox/WebKit 12/12, and copied-bundle recovery; its compatibility evidence paths remain under `artifacts/ci/docker-schema11/`. It is local uncommitted-source evidence, not hosted/signed/scanned release provenance. The retained unsigned macOS schema-12 checkpoint remains historical 51-tool/25-resource evidence, was not installed, and is nondeterministic at the outer PKG layer. All evidence remains `NO-GO`; packaged native macOS/Linux/Windows and custom-protocol lifecycle proof is missing. |

```mermaid
flowchart LR
    B["FormaSpec browser editor"] -->|REST and replayable SSE| A["FormaSpec API and MCP"]
    C["Codex"] -->|token-free loopback MCP| L["Local bridge"]
    L -->|scoped upstream grant| A
    A --> K["Shared V1 and V2 core"]
    A --> D[("SQLite WAL, snapshots, audit, outbox")]
    A -->|bounded Unix-socket IPC| R["Sandboxed renderer worker"]
    A --> F["Static React application"]
    W["Workspace Bridge"] -->|bounded path-free inventory and opaque mappings| A
    W --> Q["Explicitly granted local repository"]
```

Current source advertises 54 MCP tools and 26 resources, including
`product_list`, `product_read`, and `formaspec://products/{productId}`. The
protected non-MCP manifest contains 119 routes: 55 project-scoped, 58
organization-scoped, and six explicit exceptions. Focused schema-18 contract
tests verify exact inventory/route closure and authentication across that
surface. This source contract is implemented foundation evidence, not a
production qualification.

Historical local dependency-linked schema-13 runtime evidence uses disposable Compose
project `formaspeccischema1369037dfc8a`. Image
`sha256:55601784007855ffac507b20c8025d64d9ca5f572eb9a2834a0fb239a30378a0`
produced the same 512×339 PNG hash before and after API restart, denied DNS/
direct-TCP/non-loopback egress, passed Firefox/WebKit 12/12, and passed
source-to-clean-target copied-bundle recovery with exact database, snapshot,
revision, asset, render, integrity, and foreign-key comparisons. Cleanup passed
for every disposable project. These are historical local `NO-GO` results, not
the retained schema-16 checkpoint, hosted provenance, or a release image.

Installed/link verification confirms `drizzle-orm` 0.45.2. The current
schema-18 source passes recursive typecheck and production build. Its package
tests currently cover core 74/74, server 551/551, web 148/148, CLI 146/146
(124 ordinary plus six bridge-lifecycle), local bridge 27/27, Workspace Bridge
37/37, and installer 75/75: 1,058 tests in
total. Four real Chromium render/raster cases use a scoped 20-second test-
harness timeout while the application render remains hard-bounded at 15
seconds. Deterministic document-export tests pass 15/15, migration/backup/restore
tests pass 59/59, Product/readiness/preview/MCP tests pass 44/44, and macOS
packaged-runtime contracts pass 11/11. Launcher tests pass 280/280 and
`docker compose config --quiet` passes. These are local source checks; the full
schema-18 browser, Docker, recovery, security-scan, and supported-OS release
matrix remains open. Retained local Docker restart/egress and copied-bundle
recovery evidence uses the older schema-16 image
`sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1`.
Separately, the live macOS source-checkout upgrade built and started the current
Docker image against the recorded store, reached schema-18 readiness, passed
the isolated Playwright renderer and bridge origin/store checks, and passed
strict MCP `initialize`/`tools/list` doctor verification for the 12 essential
tools. Live Codex then contained exactly one 0.4.0 managed plugin and one
token-free MCP entry, with no standalone skills or legacy compatibility
marketplace/configuration residue. A new Codex task is required to load that
refreshed inventory. This run is not packaged, hosted, signed, scanned, or
supported-OS lifecycle evidence.
After the effective loopback Host-comparison fix, the exact live source command
`./designer ensure-running --json` returns ready for recorded Docker `origin`
and `webOrigin` `http://127.0.0.1:4310`, store
`store_70354ab57f8b26194138df3e1c443e4b`, and `bridgeReady: true`.
The exact SBOM/license result remains historical schema-13 evidence; hosted,
installed-native, current security/image/OS scan, and real remote-host/TLS
matrices remain open.

### Current authoritative data flow

1. The browser or MCP client resolves exactly one authorized Product and Design,
   then reads the Design's current integer version and immutable task context.
2. Ordinary changes are represented as typed public operations. Linked
   component insertion is resolved server-side from the project's exact pinned
   release and produces a prepared `insert_component_instance` preview; callers
   cannot supply component source trees through generic operations.
3. The shared command engine validates and applies the operation batch to a
   persisted ephemeral preview with engine versions, hashes, diagnostics,
   permanent-ID mapping, changed IDs, expiry, and status.
4. The caller renders, inspects, and lints the exact preview before approval.
5. Codex/CLI-created managed FormaSpec requests transition their immutable task
   to `awaiting_approval` with the exact preview ID and stop; the website only
   monitors the durable task and lets a human commit or discard it. A generic
   non-managed MCP client may use the ordinary commit tool only under its
   explicit write approval and authorization contract.
6. Commit uses one `BEGIN IMMEDIATE` transaction to authorize, enforce scoped
   idempotency, validate the preview, reference its exact snapshot, insert the
   immutable revision/hash chain, compare-and-swap the head, and write audit
   plus event-outbox records.
7. Only committed outbox records are published to open editors. Reconnects use
   persisted monotonic IDs and `Last-Event-ID`; gaps require an authoritative
   refetch and are never auto-merged.

Source-backed components use a separate resolution boundary. Authoring captures
one authorized immutable V2 revision into a bounded detached source bundle and
stores its canonical JSON and SHA-256 with the component version. Insertion
resolves only the project's exact pinned release, verifies source/release
identity, hydrates transitive token aliases, materializes deterministic
archived/locked masters, and produces an ordinary exact preview. The MCP tool
renders that preview. A generic non-managed client may call
`design_commit_preview` after explicit write approval; the managed FormaSpec
workflow records the preview for human approval instead. Insertion materializes
typed property bindings and slot-anchor content, applies only definition-authorized visual
overrides, resolves bounded nested-component graphs from the pinned release,
and copies normalized image dependencies into the target Design only after
exact SHA-256/size/MIME/dimension verification. Missing, corrupt,
unauthorized, or unpinned dependencies still fail closed.

Linked responsive frames remain ordinary structured frame nodes with a shared
opaque group ID, the same reciprocal ordered frame list, and one half-open
breakpoint range per frame (`min_width <= viewport < max_width`). Every member
must be active on the same page; overlaps, broken reciprocity, and an
open-ended non-final range fail validation. Archive reconciliation preserves
history while removing archived members and unlinks a lone survivor. The same
contract is validated by V1/V2 reads, typed operations, compatibility
projection, migration, browser undo/redo, and MCP previews.

Document SVG/PDF export is a deliberately bounded presentation format, not a
new arbitrary-vector input surface. The server authorizes the Design before
query parsing, renders a selected saved revision/page/frame through the pinned
renderer, validates the canonical PNG signature/chunks/checksums/dimensions,
and emits deterministic bytes. SVG contains only a fixed `<svg><image>` wrapper
around that PNG; PDF embeds deterministic deflated RGB image data. Responses
include source/artifact SHA-256 headers, `nosniff`, restrictive CSP, and
immutable caching only for an explicitly requested historical version.

Portable import is a separate bounded workflow. `POST /api/imports/validate`
parses and validates without creating project state. `POST /api/imports`
requires Organization Administrator authorization and an idempotency key,
revalidates the same bundle, chooses preserve-ID conflict failure or
deterministic clone remapping, normalizes render-ready rasters through the
isolated worker, rebases the document and optional product specification to
local version 1, and commits project/revision/specification/provenance/audit/
outbox state together. The imported source revision hash remains an explicit
provenance claim; the new local revision receives its own verified snapshot and
revision hashes. The multipart body streams to a private archive while ZIP
entries inflate independently in bounded 16 KiB chunks into pinned private
files after strict metadata/type/CRC/descriptor/size validation. The complete
request and extracted set are not held in memory simultaneously; individual
bounded JSON or raster entries are loaded only when parsed or normalized.

### Current storage model

| Table | Purpose | Important limitation |
| --- | --- | --- |
| `designs` | Product-owned, organization-scoped current head with optimistic versioning | Backup-gated V2-head migration exists; operator migration UI, broader customer fixtures, and complete project policy UI remain incomplete. |
| `products` / Product move tables | Product ownership, lifecycle, default Design context, and reviewed CAS-bound movement of a Design between Products | Migration 17 creates one deterministic legacy Product per existing Design; broader product membership, folder/space, and organization-adoption UX remains incomplete. |
| `snapshots` / `revisions` | Brotli canonical bytes plus immutable parent/snapshot/operation/metadata hash chains | Real copied legacy upgrade fixtures and operator integrity tooling remain release evidence gaps. |
| `previews` | Exact persisted snapshots, base/result hashes, engine versions, temporary-ID map, changed IDs, expiry, kind, status, and bounded write-once page/node/max-size render options, dimensions, renderer backend, warnings, and PNG SHA-256 | Complete release-candidate fault injection and every engine-mismatch/already-committed case remain to be proven. |
| `idempotency` | Organization/principal/scope/key response cache committed atomically with writes | Larger restart/concurrency matrices remain. |
| `password_accounts` / `bootstrap_credentials` | Exactly one enabled human Organization Administrator may own the immutable bootstrap account identity. Passwords use versioned scrypt hashes. Public server bootstrap stores only the installer-generated token SHA-256 and permits one atomic consumption of the fixed `initial_admin` credential. | Password recovery/change and delegated account administration are not implemented; this is intentionally a single-administrator V1 session boundary. |
| `browser_sessions` / `login_attempts` | Browser sessions persist only SHA-256 token/CSRF hashes, immutable identity and absolute-expiry metadata, sliding idle expiry, revocation, and bounded global/source/known-identity login-failure buckets. Session actors bind the session ID to the principal ID and revalidate live state on every authorization decision. | Broader multi-process, real-proxy/TLS, sustained-abuse, clock-boundary, and supported-OS lifecycle evidence remains incomplete. |
| `assets` | Fully decoded deterministic PNG/JPEG/WebP, content-addressed files, and verified legacy-BLOB quarantine fallback | Decode/normalization uses the isolated renderer worker; operator-approved legacy cleanup and broader malformed-image/load evidence are not implemented. |
| `render_jobs` | Bounded request/output hashes and lifecycle metadata for render and raster-normalization jobs; owner leases protect rolling processes, and exact permit-based 30-day retention deletes one organization/internal scope per bounded batch. Raw documents, assets, paths, and PNG bytes are never stored. | Organization-configurable retention, dashboards, and packaged load evidence remain incomplete. |
| `event_outbox` | Organization/project-scoped replayable SSE source with guarded retention of published rows and explicit replay gaps | Operational lag monitoring and high-load reconnect evidence remain. |
| `audit_retention_previews` / `audit_retention_runs` | Exact expiring retention plans plus immutable SHA-256 chained execution evidence | Administration UI and long-running scheduled execution remain. |
| `portable_imports` | Immutable organization-scoped source bundle/revision hash claims, target revision, canonical ID map, manifest, diagnostics, actor, and timestamp | The source revision hash is preserved as a provenance claim; it is not revalidated as a local revision chain. Multipart and per-entry disk staging are bounded, but larger adversarial/concurrent-import and packaged cross-platform evidence remain incomplete. |
| `handoff_execution_decisions` | Append-only, handoff-version-pinned plan/isolation/diff/validation/commit/push/PR decisions with evidence hashes, explicit supersession, and lifecycle/CAS triggers | Broader packaged-agent and real-repository execution evidence remains incomplete. |
| `component_definitions` | Immutable definition versions plus paired canonical bounded component `source_json` and SHA-256 `source_hash`; schema-12 rows may remain null-source for compatibility but cannot enter a new release. Contracts support typed property-to-node bindings, slot anchors, allowed visual overrides, nested components, and verified content-hash asset copying during insertion. | Richer authoring UI, release-upgrade comparison, broader accessibility/conflict/portable/restore evidence, and company-wide component governance remain incomplete. |
| `design_system_upgrade_previews` | Expiring upgrade diagnostics plus immutable base revision, base snapshot, and exact result snapshot hashes for V2 upgrades. | V1 compatibility previews retain their historical null exact-snapshot form; broader schema-18 hosted/off-site backup/restore and fault-injection evidence is pending. |
| Enterprise workflow tables | Organizations, Products, principals, roles, grants, audit, product specs, planning, Product-bound tasks, connections, design systems/releases/pins, repository inventories, handoffs, redesign assessments, backup/export metadata, and locks | V2-head migration, full authoring/mapping/implementation integration, delegated administration, policy rollout/version migration, and complete retention workflows remain incomplete. |

The `schema_migrations` ledger and database, document, command-engine,
renderer, font, application, and export versions are explicit and synchronized
in current source at database schema 18. Runtime metadata is document schema 2,
command engine 3, renderer 3, renderer IPC protocol 2, raster normalizer 1,
font bundle 1, export format 1, and application build `0.2.0`. Migration-2 DDL
defaults remain frozen at command engine 1, renderer 2, and font bundle 1 so a
runtime bump does not alter historical schema-prefix fingerprints. Migration 8 is an
expand-only correction that adds the previously missing design-system,
repository-inventory, handoff, implementation-mapping, and Redesign Studio
tables. Migration 9 adds bounded preview-first audit/outbox retention with
temporary exact-delete permits and an immutable run hash chain. Migration 10
adds immutable portable-import provenance. Migration 11 adds bounded persistent
render-job lifecycle records and strict transition/immutability constraints.
Migration 12 adds append-only handoff execution decisions and their exact
sequence/supersession/lifecycle integrity triggers. Migration 13 adds paired
canonical component source bytes/hash and immutable exact V2 design-system
upgrade base/result snapshot references without fabricating data for legacy
rows. Migration 14 adds password accounts, browser sessions, persistent login-
attempt buckets, and the one-time bootstrap credential. Database constraints
permit only one immutable bootstrap-account identity, require its principal to
be an enabled human Organization Administrator, bind each session to that same
account/principal/organization tuple, keep session identity and absolute expiry
immutable, and make bootstrap consumption one-way. Migration 15 adds nullable,
bounded `previews.render_metadata_json` plus an immutable-once-recorded trigger;
historical previews remain null rather than receiving fabricated PNG evidence.
Migration 16 replaces the legacy schema-14/15 bootstrap-credential trigger
with its canonical consume-once definition while preserving credential rows
and failing closed on unexpected schema shape.
Migration 17 adds first-class Products, `designs.product_id`, reviewed
Product-move previews, and immutable resolved Product context on agent tasks.
Existing Designs receive deterministic same-name legacy Products without ID or
revision-history changes; no cross-Design relationship is guessed.
None of these migrations
changes V1 revisions or removes legacy columns.

The migration ledger is necessary but not sufficient. Database startup and
backup/restore verification validate the required migration-9/10/11/12/13/14/15/16/17
tables, columns, indexes, trigger targets/SQL, and forbidden legacy triggers. A
database that claims a ledger version without the required schema shape fails
closed.
Deterministic historical fixtures build schema 1 and schema 7–11 by applying
the real migration prefix to a fresh database, with reviewed schema/data
digests; they do not derive old schemas by dropping current tables. Focused
schema-13 tests also upgrade a genuine schema-12 fixture and prove null source/
exact-preview columns are not synthesized. Focused schema-14/15 fixtures advance
genuine schema-11/schema-12 databases without changing their preserved
enterprise rows, fabricating an administrator/session, or fabricating historical
preview-render evidence. Migration-16 fixtures preserve legacy credential rows
while canonicalizing the bootstrap trigger. Current restore tests
revoke every restored active browser session together with grants,
connections, and pairing nonces. Same-image schema-13 copied-bundle recovery is
historical local evidence; retained schema-16 local copied-bundle recovery also
passes, while broader server-mode/off-site/native
operator verification remains pending.

### Current renderer topology

Docker uses two services from the same image. The API sends bounded, versioned
requests through `/run/formaspec/renderer.sock`. The renderer runs as `pwuser`
with `network_mode: none`, a read-only root filesystem, all capabilities
dropped, `no-new-privileges`, PID/CPU/memory limits, deterministic locale,
timezone, and DPR, a new browser context per job, bounded queue/concurrency,
and guaranteed cleanup. `/health/ready` and `/health/render` fail when the
worker is unavailable; production has no silent software fallback.

The API records each dispatched render or raster-normalization job as
`queued`, `running`, and exactly one terminal `succeeded` or `failed` state.
Only bounded hashes, versions, dimensions, warnings, and safe error metadata
are persisted. The worker remains database-free. API owners renew short leases;
startup and periodic maintenance mark only expired nonterminal rows failed and
retryable, so a rolling second API process cannot invalidate live work.

Windows named-pipe support, self-contained native worker packaging, and a
continuous automated infrastructure-egress test remain incomplete.

## Corrected defects and remaining architectural risks

The reproduced approximately 149% zoom/pan selection drift is corrected by one
`ViewportTransform`, a viewport-coordinate interaction overlay, explicit
Moveable root/container relationships, accurate positioning, and coalesced
geometry invalidation. The automated Chrome gate currently passes DPR 1/2,
12/25/50/100/149/150/200/320% zoom, positive/negative fractional pan,
LTR/RTL/mixed and nested rotated single selection, and fractional-coordinate
multi-selection within 0.75 CSS px at DPR 1 and 2.

Remaining risks are explicit:

- React Moveable still rounds fractional child offsets for group selections;
  FormaSpec keeps Moveable as the group gesture engine and renders the
  non-resizable group border from an exact client-space target union.
- Auto-layout drag/reparent/constraint semantics cover linear, wrapped, and
  grid reorder/reparent plus fixed/fill/hug resizing; a visual insertion marker
  and explicitly defined ambiguous multi-selection behavior remain incomplete.
- The representative 1,000-node service gate and retained schema-16 20-sample
  pinned-Chromium browser budgets pass locally. Retained hosted release-CI and
  supported-platform repetition remain required.
- Verified backup/retention and launcher-local Docker supervision exist. The
  isolated 20-step source-local restore result is historical schema-13 evidence;
  current deterministic schema 1 and schema 7–12 migration fixtures pass.
  Server-mode external supervision, signed
  provenance, anonymized real-customer fixtures, and the full asset/failure-
  injection recovery matrix remain incomplete.
- Strict V2 heads, immutable release pinning/upgrades, source-backed component
  authoring, exact pinned-release insertion previews, typed property bindings,
  slot anchors/content, allowed visual overrides, nested-component resolution,
  content-hash asset copying, and backup-gated migration foundations exist.
  Insertion supports those contracts; design-system release upgrade still
  blocks asset-bearing sources and existing non-empty property/slot instances
  pending safe upgrade rematerialization. Richer contract authoring, visual
  upgrade comparison, broader component-
  library accessibility/conflict/portable/restore coverage, and retained
  hosted/native schema-18 release evidence remain incomplete.
- The Workspace Bridge persists bounded inventories, exact opaque mappings,
  and handoffs. Selected-workspace launch now requires the immutable
  `start_implementation` transition; the broader independently approved
  plan/diff/validation/commit/push/PR execution workflow is not complete.
- Privileged native lifecycle, Windows named pipes and packaged DPAPI
  verification, container/Windows/Linux artifact evidence, vulnerability and OS
  scanning, retained hosted/OS visual regression, and the full security matrix
  remain release blockers. The Sharp-free source license gate and current
  macOS package SBOM/integrity evidence pass with zero policy violations.

## Approved target architecture

The upgrade remains incremental. Existing packages are extended rather than
rewritten merely to match a directory diagram.

```mermaid
flowchart LR
    UI["FormaSpec web"] --> API["FormaSpec API and MCP"]
    AG["Codex / agent"] --> LB["Local bridge"]
    LB --> API
    API --> DB[("SQLite WAL + content-addressed snapshots")]
    API --> O["Transactional event outbox"]
    O --> SSE["Replayable SSE"]
    API -->|bounded IPC| RW["Renderer worker"]
    RW --> CH["Pinned sandboxed Chromium"]
    WB["Workspace Bridge"] -->|bounded inventories, opaque mappings, and task state| API
    WB --> REPO["Explicitly granted local repository"]
```

Target runtime boundaries:

- `formaspec/server` contains the frontend, API, MCP endpoint, migrations,
  renderer worker executable, Chromium, fonts, icons, templates, and foundation
  design system.
- API and renderer run as separate non-root processes. Unix sockets are used on
  macOS/Linux and named pipes on Windows.
- The local bridge is separately installed and stores upstream grants in the
  operating-system secret store. Codex or the CLI creates immutable agent tasks
  through MCP; browser actions only monitor tasks and approve or discard exact
  previews. The website never calls an OpenAI API directly.
- The Workspace Bridge is a workstation-only process. Repository paths,
  credentials, and development tools never enter the central server trust
  boundary.
- Source installs may use Node and pnpm. Packaged installs ship pinned,
  self-contained executables and do not require either tool.

## Version and migration architecture

V1 semantics are frozen. Historical V1 revisions stay immutable and exportable.
V2 is a separate strict schema for design-system links, component instances,
product specifications, semantic roles, implementation mappings, and
organization references.

The required database migration sequence is:

1. Add a numbered migration ledger and independent engine/build versions.
2. Backfill one legacy organization, principals, memberships, roles, scoped
   agent grants, project ownership, policy, and append-only audit events.
3. Add Brotli-compressed content-addressed snapshots, revision hash chains,
   exact preview metadata/status, scoped idempotency, and an event outbox.
4. Add render jobs and content-addressed normalized assets while retaining
   legacy BLOBs in quarantine.
5. Add V2 design systems, releases, component definitions, product
   specifications, planning sessions, and implementation mappings.
6. Add agent tasks and transitions, connections, handoffs, repository
   inventories, and redesign assessments.
7. Add backup records, schedules, retention, portable exports, and operational
   locks.

The current repository records the first seven implementation slices, an
eighth expand-only corrective migration for domain tables that were not yet
materialized by the earlier broad workflow migrations, migration 9 for guarded
audit/outbox retention execution, and migration 10 for immutable portable-
import provenance, migration 11 for persistent render-job lifecycle state, and
migration 12 for append-only handoff execution decisions. Migration 13 adds
source-backed component versions and exact design-system upgrade snapshot
references. Migration 14 adds the single-administrator password-session
boundary, persistent bounded login-attempt state, and one-time public-server
bootstrap authorization. Migration 15 adds immutable-once-recorded exact
preview-render evidence, migration 16 canonicalizes the legacy bootstrap-
credential trigger, and migration 17 adds Products, deterministic existing-
Design backfill, reviewed Product moves, and immutable Product-bound task
context.

Migration 14 does not silently create a human identity. Local session mode
bootstraps the sole Organization Administrator through the browser. A fresh
public session deployment additionally requires an installer-generated one-
time token whose SHA-256 is stored in configuration and whose database
credential is consumed atomically. Account identity cannot be updated or
deleted; session identity and absolute expiry cannot be rewritten; logout,
login rotation, expiry, principal disablement, and restore reconciliation make
the affected sessions unusable through revocation rather than deletion.

No V2 project-head migration may run before a verified backup and clean restore
test. The deterministic V1-to-V2 migration must preserve project, page, frame,
node, token, asset, and prototype IDs. Legacy free-form overrides are retained
as non-rendered quarantine data with diagnostics. A system-authored migration
revision advances only the current head; historical V1 revisions are not
rewritten.

### Canonical snapshot rules

The persistence layer implements these rules:

- Canonical document bytes are encoded deterministically.
- `snapshot_hash = SHA-256(uncompressed canonical document bytes)`.
- A revision hash covers its parent revision hash, snapshot hash, operation
  hash, and canonical revision metadata.
- Commit timestamps belong to revision metadata, not a mutation of the preview
  document.
- A preview records base and result hashes, command-engine/renderer/font
  versions, status, expiry, operation hash, permanent temporary-ID mapping, and
  changed node IDs.

### Atomic preview commit

The implemented exact-preview commit uses one `BEGIN IMMEDIATE` transaction:

1. authorize the organization, project, actor, and grant;
2. enforce payload and engine-version limits;
3. resolve scoped idempotency;
4. validate preview state, expiry, hashes, and expected base version;
5. reference the exact stored snapshot;
6. insert the immutable revision and hash-chain metadata;
7. compare-and-swap the project head;
8. insert audit and event-outbox rows;
9. persist the idempotent response and mark the preview committed;
10. commit, then publish only committed outbox events.

V1 never auto-merges. A stale base returns `VERSION_CONFLICT` and the caller
must read the new head and create another preview.

## Stable boundaries

FormaSpec remains a structured UI system, not a general vector editor. The
following stay out of scope: pen tools, boolean vector operations, arbitrary
SVG/HTML/CSS/JavaScript, animation timelines, realtime cursors, public sharing,
Figma import, central shell execution, unrestricted code generation, and
unrestricted repository access.

See [EDITOR_COORDINATES.md](./EDITOR_COORDINATES.md) for the canvas contract,
[SECURITY.md](./SECURITY.md) for deployment boundaries, and
[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) for actual delivery
status.

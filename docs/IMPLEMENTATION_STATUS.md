# FormaSpec implementation status

Audit date: 2026-07-21

Release decision: **NO-GO for enterprise production**

This matrix describes the repository as it exists during the incremental
FormaSpec upgrade. “Implemented” means source and focused tests exist; it does
not mean the related enterprise phase gate has passed. A phase is releasable
only after its required browser, security, performance, migration, backup,
installer, and operational evidence also passes.

## Status meanings

| Status | Meaning |
| --- | --- |
| **Implemented foundation** | The principal source path and focused automated tests exist, but the complete release gate is not yet proven. |
| **Partial** | Useful implementation exists, with material behavior, integration, UI, hardening, or tests still missing. |
| **Not implemented** | No usable implementation for the named requirement exists. |
| **Blocked externally** | Reproducible unsigned work may exist, but an external credential, registration, certificate, or OS permission is unavailable. |

## Verification history

The verified pre-upgrade baseline was:

| Command | Baseline result |
| --- | --- |
| `pnpm test:run` | 36 application tests passed: 23 core, 8 server, 5 web |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed |
| `pnpm test:launcher` | 158 launcher tests passed |
| `docker compose config --quiet` | Passed |

That baseline was captured before broad enterprise changes. The current
working tree contains the in-progress upgrade and must not be described as
clean or release-ready.

The last broad verification checkpoint on 2026-07-21 predates database
migration 13 and the source-backed component insertion interface. The working
tree remains an unsigned enterprise-upgrade tree; the schema-12 macOS artifact
is retained historical engineering evidence rather than a release candidate.
Current schema-13 claims below are limited to source inspection and the focused
tests and disposable runtime evidence explicitly listed. Application suites,
launcher, all-workspace typecheck/build, randomized Docker restart/egress,
Firefox/WebKit, and same-image copied-bundle recovery now pass at schema 13.
The schema-13 Chrome release/selection/editor/handoff/visual/inspect/performance
matrix also passed before the dependency security update. The final linked
checkpoint now verifies installed `drizzle-orm` 0.45.2, application 678/678,
launcher 212/212, all seven typechecks/builds, Docker restart/egress,
Firefox/WebKit 12/12, copied-bundle recovery, and an exact 342-component/
zero-violation SBOM/license report. Audit reports zero high/critical and two
moderate findings. The broad Chrome Playwright matrix still needs a post-0.45.2
rerun. Native installers, hosted provenance, image/OS scanning, real server-
mode/off-site recovery, and supported-OS lifecycle evidence remain unverified.

| Check | Recorded result |
| --- | --- |
| Prior broad package gates | Before schema 13, core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, installer 62/62 across 5 files, and launcher 212/212 passed. That checkpoint covered 51 MCP tools, 25 resources, and 106 protected non-MCP routes. It remains useful regression evidence, but it is not current-source verification. |
| Schema-13 application and source gates | Source declares database schema 13, command engine 2, renderer 3, renderer IPC protocol 2, and font bundle 1. Migration 13 persists canonical component source JSON/SHA-256 plus immutable exact base/result snapshot metadata for design-system upgrade previews. Source exposes 52 MCP tools, 25 resources, and 108 protected non-MCP routes. Installed/link verification confirms `drizzle-orm` 0.45.2; application suites pass 678/678, launcher 212/212, and all seven workspaces pass typecheck/build. Audit reports info 0, low 0, moderate 2, high 0, critical 0. |
| Exhaustive SSE event authorization | The 18-event runtime policy is exhaustive and maps every event family to one required agent read scope, permitted human roles, and a project/organization/optional/control boundary. Seven focused tests pass across the policy and real HTTP streaming suites. A `design:read`-only agent cannot observe task, handoff, Redesign, connection, backup, audit-retention, or other administration events; `task:read` can open a useful task stream without `design:read`; connection, backup, and audit-retention families are Organization-Administrator-only for humans and unavailable to agents. Replay rows are filtered in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery applies the same policy. Scope-policy removal or connection revocation closes an existing stream. |
| Historical migration fixtures | The prior deterministic schema 1 and schema 7–11 fixtures passed through schema 12 without fabricating handoff execution decisions. Schema-13 tests additionally upgrade a genuine schema-12 fixture without inventing component sources or exact upgrade-preview metadata; legacy null-source versions stay readable. Same-image copied-bundle recovery passes, while broader customer/server-mode/off-site restore fixtures remain pending. |
| Current all-workspace typecheck/build | All seven workspace packages pass typecheck and production build at schema 13. |
| Launcher suite | 212/212 passed after proxy-secret lifecycle hardening |
| Enterprise editor and administration browser coverage | The schema-13 pre-0.45.2 Playwright checkpoint passed 4/4 for editor/admin/prototype/manual component insertion and handoff 1/1. The insertion case proved backup-gated V1→V2 migration, exact Foundation catalog loading, isolated preview without head mutation, ordinary CAS commit, version-3 reload, and an active projected instance. Rerun this gate against linked 0.45.2. |
| Browser selection alignment and revision inspect | The schema-13 pre-0.45.2 Chrome checkpoint passed selection 12/12 within 0.75 CSS px and revision-inspect immutability 1/1 after correcting the fixture to edit the active root frame rather than an immutable detached component master. Rerun against linked 0.45.2. |
| Visual regression foundation | The schema-13 pre-0.45.2 Chrome checkpoint passed 7/7 baselines: desktop, phone, tablet, Persian RTL, typography, clipping, and normalized image. Rerun against linked 0.45.2. |
| 1,000-node foundation | Deterministic service benchmark passed at 20.43 ms p95 validation, 49.65 ms p95 apply, 134.43 ms p95 preview persistence, and 116.83 ms p95 render. This remains a coarse service/core gate rather than browser-interaction evidence. |
| 1,000-node browser budgets | The schema-13 pre-0.45.2 Chromium gate passed 1/1: 230.70 ms p95 load, 20.50 ms selection, 16.70 ms gesture p95/maximum, 273.20 ms autosave, 17.60 ms history, 280.48 ms preview validation, and 221.37 ms render. Rerun against linked 0.45.2. |
| Integrated PM-to-restore E2E | The schema-13 pre-0.45.2 Playwright checkpoint passed the complete 20-step scenario 1/1. Rerun against linked 0.45.2. |
| Current schema-13 Compose/runtime | Dependency-linked project `formaspeccischema1369037dfc8a` used image `sha256:55601784007855ffac507b20c8025d64d9ca5f572eb9a2834a0fb239a30378a0`, reached schema 13, created design `document_c304f0d8e19d449fa450b335e79c182e` at revision `revision_b71067ccd8e548b1b5385c366dabb263`, and rendered the deterministic PNG SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf` before/after restart. Egress and cleanup passed. Summary `/private/tmp/formaspec-docker-schema13-drizzle0452-20260721-current/summary.json`, SHA-256 `8e0d3baa22b934f90d7e6f36022365a825f5b6457ca6bb6e51f993a1fb59caed`. |
| Codex connection | `./designer --yes start docker --no-build --no-open` refreshed the mode-`0600` runtime binding, started the loopback bridge, verified MCP `formaspec`, installed the managed Minimal UI skill/plugin, and exposed `[@Minimal UI](plugin://minimal-ui@formaspec)`. The generated Codex configuration remains token-free and uses write approval mode. Automatic authorization intersects scopes with organization policy, clamps creation expiry, supplies project restrictions when required, and now reuses an existing stored grant only when its bearer-only authorization context has exact least-privilege scope/project set equality; stale or overbroad grants rotate through one-time pairing. |
| Current runtime/workflow evidence | The dependency-linked 0.45.2 image passed Firefox/WebKit 12/12; summary SHA-256 `a4c16b03a094abba6abd2144c9ed0af78684897c97956c77789526f57eb6f41c`. Copied-bundle recovery from `formaspecdrsource8878ef1a23` to `formaspecdrtarget8878ef1a23` preserved design `document_34da61e488444c48b144646e778f7edc` at revision `revision_5da62614cff8498db21be8d9346eb34a`; bundle SHA-256 `3fcba430b476f1dc2ce943405af418a1b1fdc629876f1e8407b8cf5b725c2fef`, summary SHA-256 `198f93aace5caf60f550e95436711b10107433acc7d85b9175fce8d4722dcc6d`. Exact current SBOM/license evidence passes with 342 components and zero violations; `SHA256SUMS` SHA-256 `82794fb6d820633ba4687126f3668ab21f045c6ceb73cd7761d3abd48b204bf8`. Native packaging, hosted provenance, signatures, image/OS scans, and post-0.45.2 broad Chrome Playwright gates remain required. |

The schema-12 macOS PKG under `artifacts/candidates/schema12-current/` is a
retained pre-current-SSE-authorization unsigned checkpoint, not a current-source
artifact. Its original package-integrity, runtime-smoke, checksum, and
reproducibility evidence remains valid for those frozen bytes. The current
verifier now records expected source drift: packaged `apps/server/dist`
predates the exhaustive event-authorization policy and the project/revision-
bound historical design-system release interface, migration 13, and the
source-backed component insertion tool/route. A new package from the current
source has not been built or installed.

The integrated local browser scenario, Chrome/Firefox/WebKit alignment, visual
baselines, and 1,000-node Chromium performance gate now pass on schema 13.
There is still no retained hosted/supported-OS editor matrix, native-installer
matrix, signed provenance, complete vulnerability/OS scanning, or real server-
mode/off-site backup-restore/deployment suite.

## Current database migration ledger

The server now owns an ordered SQLite migration ledger:

| Version | Name |
| --- | --- |
| 1 | `baseline_v1` |
| 2 | `content_addressed_persistence` |
| 3 | `enterprise_workflow_foundation` |
| 4 | `preview_retention` |
| 5 | `organization_scoped_outbox` |
| 6 | `enterprise_workflow_integrity` |
| 7 | `enterprise_delivery_operations` |
| 8 | `enterprise_domain_models` |
| 9 | `audit_retention_execution` |
| 10 | `portable_import_provenance` |
| 11 | `render_job_persistence` |
| 12 | `handoff_execution_decisions` |
| 13 | `component_source_persistence` |

The migrations preserve the legacy V1 columns while adding content-addressed
snapshots, integrity metadata, organization/agent workflow tables, preview
retention, scoped outbox state, backup metadata, schedules, operational locks,
design systems, repository inventories, implementation mappings, handoffs, and
Redesign Studio assessment history, bounded audit/outbox retention evidence,
immutable portable-import provenance, and bounded persistent render-job
lifecycle metadata. Migration 12 adds independently authorized, append-only
handoff execution decisions and their lifecycle/CAS integrity triggers.
Migration 13 adds paired canonical `source_json`/`source_hash` columns for
immutable component versions and exact immutable base-revision/base-snapshot/
result-snapshot metadata for design-system upgrade previews. It deliberately
does not fabricate source data for historical rows.

Current runtime metadata is database schema 13, document schema 2, command
engine 2, renderer 3, renderer IPC protocol 2, raster normalizer 1, font bundle
1, export format 1, and application build `0.2.0`. Migration-2 SQL defaults stay
frozen at command engine 1, renderer 2, and font bundle 1 so current runtime
version bumps do not change the fingerprint of historical schema prefixes.

`apps/cli/src/migrations.ts` now recognizes schema 13, matching the server
source. The CLI's full migration/backup/restore/support-bundle suite has not
yet been rerun at schema 13.
A ledger prefix alone is not accepted as proof of migration completion: startup,
backup verification, restore preflight, and restore control validate the
required migration-9/10/11/12/13 tables, columns, indexes, triggers, normalized
schema SQL, and
forbidden legacy triggers and fail closed on schema-shape drift.
The checked-in historical fixture builder now proves genuine baseline V1 and
schema 7–11 prefixes preserve stable project/page/frame/node/asset/revision IDs,
canonical document and operation bytes, snapshots, revision hash chains,
organization ownership, linked enterprise rows, and schema-11 render jobs while
migrating to schema 12. Focused schema-13 fixtures additionally prove migration
13 adds nullable legacy-safe source/exact-preview fields and integrity triggers
without fabricating component sources or upgrade snapshot metadata. They also
prove migration 12 creates the decision table and triggers with zero fabricated
decisions, and that malformed V1 revision bytes fail atomically before
migration 2 is recorded. These deterministic fixtures close the synthetic
drop-table gap. A same-machine copied-bundle
simulation now verifies restoration into an independent clean target, but
anonymized real-customer and true remote-host/network disaster-recovery corpora
remain release evidence that has not yet been completed.

The installed Docker volume also completed an in-place schema-7-to-8 upgrade.
Project `miare courier app` remained at version 31 with all 31 immutable
revisions. Its head is
`revision_36dd0a2e4cdc4d35b1e1b4e50087ef59`, revision hash
`24e56917b5e84ff611873662eb921d36b4fcb3aceca11a6d601935450a561508`, and
snapshot hash
`a735a7b913d3b4e4bb72f107953da50dd2a9e676970fb5650383b91983a1a0cf`.
A representative asset remained readable at 1,657,271 bytes and the worker
produced an 84,418-byte PNG.

Two verified runtime backup checkpoints bracket that upgrade:

- Pre-upgrade schema 7: `backup_6805e013a2043250481491efabaf667b92662e98`,
  SHA-256 `fdaa166bf96365b326e628277f51e9d5d2348df4e78bc3733504bbb105bb0918`,
  4,536,320 bytes.
- Post-upgrade schema 8: `backup_f72fc0da90a20e6bad66b7cc46e79b7dd14ae84a`,
  SHA-256 `c26eeaeb2353c12820b6e89ebb134bea4cab1e511abe12bdf349dc0c200dc94b`,
  4,536,320 bytes.

These two checkpoints are verified in-place upgrade and backup evidence. They
were not the artifacts used by the separate local-Docker restore exercise and
do not establish server-mode recovery.

## Recorded local-Docker restore evidence

On 2026-07-20, a disposable Compose project on port `4397` created design A and
one active agent connection, created verified backup
`backup_0dda1a60c54c5805557426a428739e505e089425`, and then added design B.
Operation `restore_e2ea0123456789abcdef0123456789` restored backup A and left
only A with its original IDs/revision. It revoked one grant, connection, and
pairing nonce. Operation `restore_e2eb0123456789abcdef0123456789` then restored
the automatically created safety backup
`backup_7697fb29100b0bc8adc22707114c50947ed3a668`; A and B returned with their
original IDs/revisions and the connection remained revoked. The disposable
containers, volumes, and network were deleted.

The exercised launcher-local path uses a mode-`0600` exact Docker runtime
binding at `.designer/run/docker-runtime-binding.json`, the shared non-expiring
`/backups/.formaspec/restore-worker.lock.json`, and durable `prepared`,
`cutover_committed`, `reconciled`, and `rolled_back` operation states. Fastify
does not restore its own open database and refuses to open SQLite during an
incomplete cutover. This is meaningful local recovery evidence, but not
server-mode recovery evidence, signed provenance, or the complete release
recovery matrix. Binding format 2 and the same external worker now support the
strict launcher-recorded server topology, including a secret-redacted environment identity hash,
exact public health `Host`, persisted exact Compose ownership, and token-free worker
execution; that path still lacks a clean release exercise. The Docker worker pins source identity through an
`O_NOFOLLOW` handle into private mode-`0700` staging on `/backups` and a
mode-`0400` file; expected managed size/SHA-256 validation and a valid-bundle
pathname-swap test prove that later verification/extraction use only the pinned
bytes. Source-local restore passes its exact verified tar-stream identity into
the same engine, and a cleanup failure retains the committed journal for
health-checked retry.

## Phase 0 — audit and architecture

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Incremental TypeScript/pnpm architecture retained | **Implemented foundation** | Existing core/server/web packages remain; CLI, local bridge, renderer worker, performance harness, and Workspace Bridge packages were added without rewriting V1 | Several enterprise workflow, installer, and delivery modules remain incomplete |
| Enterprise audit/status and supporting documents | **Partial** | Status, coordinate, security, threat-model, operations, backup, and release-checklist documents exist | Documentation must continue tracking implementation and verified release evidence |
| Original resize reproduction recorded | **Implemented foundation** | `docs/EDITOR_COORDINATES.md` records the approximately 149% zoom/pan failure and coordinate contract; Chrome DPR 1/2 automation now covers fractional group geometry, nested scroll, actual delayed-font and image invalidation, normalized uploaded assets, selectable frame/ellipse geometry, rotated multi-selection, and vertical/wrapped/grid auto-layout gestures, while seven Chrome DPR 1 prototype baselines cover representative rendering. The exact final Linux image additionally passes Firefox/WebKit 12/12. | Retain GitHub-hosted and supported-OS Firefox/WebKit evidence plus reviewed cross-platform visual baselines |
| Initial 1,000-node measurements | **Implemented foundation** | Deterministic core/service fixture plus a 20-sample pinned-Chromium browser gate now measure initial load, selection, gesture frames, commit/autosave, history, preview validation, and a full 1440×900 PNG; all local release budgets pass | Retain reports in a pinned release CI image and repeat on supported release platforms/hardware |

## Phase 1 — correctness, persistence, and security

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Shared viewport transform and untransformed interaction overlay | **Implemented foundation** | `ViewportTransform`, one transformed canvas layer, viewport-coordinate overlay, stable targets, explicit root/container wiring, accurate positioning, and a 12/12 Chrome alignment gate exist. FormaSpec renders the non-resizable group border from the exact client-space target union while retaining Moveable for dragging/snapping. The final reviewed image passed Firefox/WebKit 12/12 once. The immediately prior fit-sync image passed the same suite three consecutive times after initial canvas fitting moved synchronously into `useLayoutEffect`, eliminating the WebKit initial-fit race and providing repeated-flake evidence. | Retain hosted/cross-OS evidence and broaden the node/layout visual matrix |
| Geometry invalidation after viewport/layout/font/image changes | **Implemented foundation** | Coalesced refresh, `ResizeObserver`, `MutationObserver`, scroll capture, font/image readiness, imperative Moveable `updateRect()`, and browser coverage for nested scroll, explicit invalidation, a genuinely delayed bundled font, and a decoded normalized uploaded asset exist | Add broader layout/token mutation cases and cross-browser visual regression |
| Draft gestures, normalized commits, selection canonicalization | **Implemented foundation** | Draft transforms, fractional normalization, hidden/locked filtering, selection-root utilities, undoable one-command `move_node` gestures, auto-layout reorder/reparent, and fixed/fill/hug resize conversion are covered at DPR 1/2, including row-aware wrapped/grid insertion. Auto-layout resize never writes x/y and preserves rotation. | Add a visual insertion marker, define ambiguous multi-selection auto-layout behavior, and broaden cross-browser input paths |
| 1,000-node responsiveness | **Implemented foundation** | Node rendering is memoized, repeated traversal/index work is reduced, service timings pass, and the deterministic 20-sample pinned-Chromium gate passes every specified interaction/render budget with no gesture frame over 50 ms and no renderer fallback | Pin the execution image/hardware in CI, retain machine-readable reports/profiles, and repeat across supported release platforms |
| Strict `APP_MODE=local\|server` and HTTP hardening | **Implemented foundation** | Local loopback enforcement; server HTTPS/trusted-proxy/Host/Origin/CSRF requirements; a separate server-generated proxy hop secret required on every non-health request; CSP/security headers. Launcher generation/storage/scrubbing and output/support-bundle exclusion have focused tests; health remains credential-free. A controlled actual-socket lifecycle passes 1/1 for caller-header replacement, direct-peer denial, ambiguous append rejection, canonical principal bootstrap, and restart-bound secret rotation. | Real Nginx/TLS, identity-provider, firewall/routing, public backend-port, low/zero-downtime rotation, and compromise-response deployment proof |
| Organization, principal, membership, role, grant, ownership, policy, and audit model | **Implemented foundation** | Legacy organization/admin backfill, scoped/expiring/revocable grants, project ownership, append-only audit tables, strict versioned organization policy, a guided 12-section Administration form, Expert JSON, secret-free YAML export, optimistic configuration hashes, exact managed-connection rotation, and preview-first audit-retention execution plus durable scheduled-attempt start/success/failure evidence, overdue/retention-backlog diagnostics, critical failed/stalled-attempt reporting even when the current window already has a valid backup, and health aggregation exist. Trusted-header policy rejects duplicate effective identity values across all supported claim aliases, preventing order-dependent role assignment. Policy gates agents, repositories, assets, backups, and portable bundle export/import. | Complete delegated administration, install an external scheduler and alert delivery, stable managed-connection keys, and policy rollout/version-migration operations |
| Service-layer authorization across REST, SSE, MCP, assets, previews, and revisions | **Implemented foundation** | Central access resolution is used across core design and enterprise services. The executable inventory contains 52 MCP tools, 25 resources, and 108 protected non-MCP routes: 54 project, 48 organization, and six explicit exceptions. The current full application suite covers exact route closure, generated authentication rejection, and direct behavioral authorization for all 108 routes with zero uncovered, including the component library/insertion interfaces. Agent library reads require `design:read` plus `design_system:read`; insertion previews additionally require `design:preview`. | Add real-proxy mapping/bootstrap evidence and broaden long-running/load and full human-role/project-parent cross-products |
| Content-addressed snapshots and revision hash chains | **Implemented foundation** | Canonical uncompressed bytes are SHA-256 hashed; Brotli snapshots and immutable chain metadata are persisted | Historical upgrade fixtures and complete integrity/audit operator tooling |
| Exact preview and atomic commit | **Implemented foundation** | Ordinary design previews persist exact base/result hashes, engine versions, status, and snapshots for `BEGIN IMMEDIATE` CAS commits. Schema 13 also binds design-system upgrade previews to immutable base revision, base snapshot, and exact result snapshot hashes; V2 upgrade commit consumes that stored result snapshot instead of recalculating it. | Rerun full restart/concurrency/fault-injection, engine-mismatch, backup/restore, and exact-upgrade snapshot equality coverage at schema 13 |
| Archive-only destructive path | **Implemented foundation** | Ordinary commit paths reject `archive_nodes`; dedicated archive preview/commit REST and MCP paths exist | Complete approval-annotation and bypass coverage across every client surface |
| Replayable organization-scoped SSE | **Implemented foundation** | Persisted monotonic outbox IDs, `Last-Event-ID` replay, scope filtering, and gap signals exist. `/events` and `/api/events` resolve bearer tokens to scoped, revocable grant actors while preserving bearer-less browser EventSource behavior. An exhaustive 18-event policy assigns each family an agent read scope, human-role allowlist, and project/organization/optional/control boundary. Replay applies that policy in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery uses the same predicate. Seven focused tests prove live/replay parity, task-only access without `design:read`, denial of task/handoff/Redesign/admin events to design-only agents, Organization-Administrator-only connection/backup/audit events, project and organization isolation, policy-removal closure, immediate revocation, marker non-leakage, and rejected reconnect. | Add long-running reconnect/load/backpressure testing, server-mode proxy streaming evidence, operational lag/retention monitoring, and broader retained role/scope stress evidence |
| Raster normalization | **Implemented foundation** | PNG/JPEG/WebP are fully decoded in the pinned Chromium renderer worker; APNG, animated WebP, MPO, malformed bytes, SVG, and MIME mismatches are rejected; JPEG and WebP EXIF orientation is applied; metadata is stripped by a deterministic canvas-to-PNG round trip; byte/pixel/output/IPC limits are versioned and matched between API and worker. Worker-backed decode now covers API upload, backup creation/verification, restore preflight, safety-backup verification, and final cutover; normalized bytes use generated SHA-256 paths with atomic dedup, read verification, and verified legacy-BLOB fallback. Sharp/libvips is absent from source, lockfile, and the rebuilt image. | Add operator-approved legacy quarantine cleanup, a larger malformed-image corpus, upload-storm/queue evidence, and real packaged cross-platform worker proof. |
| Bounded deterministic rendering | **Implemented foundation** | Versioned bounded IPC validates Unix-socket and Windows named-pipe endpoints and lifecycle behavior. Docker runs separate API/renderer services over the Unix socket with a new deterministic context per job, cleanup, queue/resource limits, non-root `pwuser`, read-only root, dropped capabilities, `network_mode: none`, no-new-privileges, fail-closed readiness, and no production fallback. The current schema-13 image produced an identical PNG across API restart, passed Firefox/WebKit 12/12, and failed egress closed with DNS `EAI_AGAIN`, direct TCP `ENETUNREACH`, and zero external interfaces. Migration 11 persists bounded API-owned, database-free-worker job lifecycle metadata. | Self-contained native worker packaging, real Windows named-pipe/ACL/runtime proof, retained hosted infrastructure-egress runs, configurable retention operations/UI, and release load evidence remain. |
| Verified backup/restore primitives | **Partial** | Online SQLite backup, semantic bundle verification, descriptor-pinned streams, policy schedules/retention, durable audit/outbox evidence, explicit CLI restore, maintenance/lock fencing, crash journals, safety backups, capacity checks, offline forensic recovery, revocation, and resume/rollback/abort controls exist. The current schema-13 image passed same-machine source-to-clean-target copied-bundle recovery from `formaspecdrsource3af2259e48` to `formaspecdrtarget3af2259e48`, preserving design `document_68bf4f18628b43ed9c5ac98300420bca` at revision `revision_08f233c763154b3da1611ba0f57f0d4c`; snapshot, revision, asset, render, SQLite integrity, and foreign-key comparisons all passed with complete cleanup. Bundle SHA-256 was `b87d44e7b0584dd0a14e5b47d07cf447490a683ab512f983feb4e2a19c0a6ef3`; `NO-GO` summary SHA-256 was `1dfecf9b4a4773fed25f73eaa181bc88e30fc21df8b0679c3325241af3ccd433`. | Real server-mode proxy planned/offline restore, broader failure/corruption/customer fixtures, packaged native recovery, remote/off-site storage, cross-platform drills, installed scheduling/alerts, signed provenance, and an OS-native no-replace cutover primitive remain incomplete. |
| Design-system backup/import/restore integrity | **Implemented foundation** | Backup verification validates every project pin's organization/project ownership and exact immutable system/release/version, accepts both published and legitimately deprecated pinned releases, requires each V2 head to equal its pin row, permits a rowless V2 head only for the exact bundled Foundation tuple, accepts historical V2 releases and transitional V1 pins, and fails closed on tampering. V2 portable import keeps the Foundation default implicit but validates and atomically inserts custom local-organization published pin rows, rejecting external IDs. V2 restore preserves the active pin only when its release contains every token/component used by restored content; otherwise it blocks with structured `USED_TOKEN_REMOVED` or `USED_COMPONENT_REMOVED` diagnostics. Restore policy/provenance is durable in revision metadata and an atomic audit event, while V1 reports `not_applicable_v1`. V1→V2 migration backup eligibility now covers the later of project-head time and `project_design_system_pins.pinned_at`. | Retain larger historical/customer bundle fixtures, signed provenance, and packaged/server-mode recovery exercises containing custom design-system data |
| Health contract | **Implemented foundation** | `/health/live`, `/health/ready`, and `/health/render` exist; Docker readiness proves migration version, worker mode, Playwright, and software-fallback state; `/health/ready` also aggregates bounded overdue and retention-backlog diagnostics and keeps failed/stalled attempts critical even when the current window already has a valid backup | Add deeper storage/outbox capacity indicators, external alert delivery, and long-running failure/recovery evidence |

Phase 1 is not closed because the complete cross-browser interaction matrix,
authorization and security matrix, clean server-mode planned-restore evidence,
end-to-end isolated CLI and server-mode offline-recovery evidence, the broader recovery matrix,
continuous egress testing, and full deployment gates have not all passed.

## Phase 2 — V2, design system, and product specification

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Strict V2 document model | **Implemented foundation** | Strict V2 schemas include semantic roles, locale/direction, typed token references, component data, mappings, migration diagnostics, and explicit non-rendered quarantine for unsupported V1 asset kinds/MIME types. Canonical V2 heads flow through reads, previews, render/lint, MCP resources, JSON/portable export, restore smoke, and V1-compatible browser projection. | V2-native token authoring, component-to-project synchronization, and advanced editor support remain bounded |
| Deterministic V1-to-V2 migration | **Implemented foundation** | Backup-gated, organization-admin-only, idempotent active-head migration preserves every stable project/page/node/token/asset/prototype ID, keeps historical V1 revisions byte/hash exact, creates one system-authored V2 revision with source revision/snapshot/backup provenance, and quarantines free-form overrides plus legacy GIF/font/video/binary assets without dropping metadata. A 5-test complete V1 compatibility corpus and active-head service fixture pass. | Add larger real-customer fixture archives, signed backup provenance, operator migration UI, and full migration/rollback E2E |
| FormaSpec Foundation System | **Implemented foundation** | Three token layers, light/dark/high-contrast modes, Inter/Vazirmatn, component definitions/states, reusable patterns, a persisted organization design-system service, and typed component-contract authoring in Administration exist | Complete token/release authoring, project upgrade visual comparison, and broader visual parity evidence |
| Component contracts and releases | **Implemented foundation** | New component versions require an authorized immutable V2 revision source. The server captures bounded detached state trees, canonicalizes and SHA-256 hashes them, stores paired source bytes/hash, and can generate a new opaque component ID when the first definition omits one. Legacy null-source versions remain readable but are explicitly unpublishable in new releases. The browser authoring flow selects real visible container roots from immutable V2 revisions and displays source hash/node-count status. | Add property-to-node and slot-anchor binding semantics, safe normalized asset copying, richer authoring/documentation/platform mapping UX, delegated-role policy, and broader project-upgrade comparison evidence |
| Source-backed component insertion | **Implemented foundation** | `GET /api/designs/:id/component-library` exposes only the exact pinned release with verified-source/asset blockers. `POST /api/designs/:id/component-insertion-previews` and MCP `design_system_component_insert_preview` hydrate transitive tokens, materialize deterministic archived/locked masters, create an exact prepared V2 preview, and commit only through ordinary preview CAS. The browser Components tab now selects a pinned component/state/parent/position, requires a clean matching head, renders the exact preview with diagnostics/hash, and explicitly commits or discards it. Generic MCP operations reject the server-only `insert_component_instance` operation. | Component assets remain blocked until content-hash copying exists; non-empty property/slot overrides remain blocked during upgrades because no visual binding model exists; add broader browser/accessibility, stale/conflict, backup/export/import/restore, and full authorization coverage |
| Project design-system pinning and V2 head synchronization | **Implemented foundation** | The editor exposes project pin/release controls that clear stale cross-project state and disable while loading or mutating. Assigning or upgrading a real pin creates exactly one atomic V2 revision synchronized with the pin row; V1 heads remain unchanged. Schema-13 V2 upgrade previews materialize target tokens and verified component masters into an exact stored result snapshot, update compatible instances, and block removed states, missing token dependencies, asset dependencies, legacy null sources, or unsupported property/slot bindings. | Add richer visual upgrade comparison, bulk/project-governance workflows, and broader browser/authorization/backup coverage |
| Product specification preview/commit | **Implemented foundation** | Versioned natural-language/structured specification service, exact preview/commit, diagnostics, MCP tools, API, and initial panel exist | Complete structured editor coverage, linked entity workflows, accessibility/rule linkage, and product-manager E2E |
| Persistent 22-section PM interview | **Implemented foundation** | Versioned sessions, answers, transitions, all required section definitions, API/MCP, and initial browser interview exist | Resume/edit/review browser E2E and broader validation/elicitation UX |
| Enterprise editor information architecture | **Implemented foundation** | The editor now provides Pages/Layers/Components/Assets navigation; Canvas/Prototype/Before-After workspaces; Design/Content/Component/Logic/Prototype/Accessibility inspector tabs; and a collapsible activity/diagnostics/revision/handoff area. Before-After selects the workspace automatically, supports minimize/reopen, archive comparison, focus transfer/trapping, inert background, and Escape. Components/assets navigate to the owning page before selection. The editor/prototype browser gate passes 2/2, including click-to-frame navigation without canonical mutation. | Broaden cross-browser, screen-reader, large-project, and end-to-end editing coverage |
| Revision-pinned inspect | **Implemented foundation** | `GET /api/projects/:projectId/revisions/:revisionId/inspect` and the browser view distinguish the immutable pinned revision from the current head. They expose integrity hashes, node measurements and resolved token references, assets/hashes, component evidence, revision-linked product rules and acceptance criteria, implementation mappings, stable IDs, and JSON paths. Focused server/web coverage plus the fresh 1/1 revision-inspect immutability E2E pass independently of the 12/12 selection-alignment gate. | Add broader accessibility, authorization, large-project, and cross-browser evidence |
| Enterprise lint catalog | **Implemented foundation** | Deterministic V2 lint now reports raw design values, missing interactive states, semantic hierarchy, accessible names, touch targets, missing prototype actions, RTL locale/alignment mismatches, detached/draft/deprecated components, invalid typed properties/slots/states, missing business-rule/acceptance links, and invalid product-spec entity links. Focused tests cover the catalog and all seven RTL/representative visual baselines pass. | Add organization-policy severity tuning, editor filtering/fix actions, broader accessibility automation, and release-scale diagnostic UX evidence |
| Portable import/export and platform token exporters | **Implemented foundation** | Strict checksum-validated `.formaspec.zip` export, read-only validation, and Organization Administrator mutating import exist. `POST /api/imports` requires an idempotency key and supports default `conflict_fail` ID preservation or explicit deterministic `clone` remapping. V1/V2 documents rebase to local revision 1; product specifications persist atomically as local version 1; Foundation-backed V2 documents may retain the implicit bundled default; and custom V2 pins must resolve to a published local-organization release and are inserted atomically with the project. Arbitrary external system/release IDs are rejected. Raster assets are fully decoded and normalized through the isolated worker; legacy assets remain metadata-only quarantine; and migration 10 records immutable source/target provenance plus the canonical ID map and diagnostics. Multipart upload bytes stream into a private mode-`0700` directory and mode-`0600` archive while size/SHA-256 are computed. Bounded file reads validate central/local headers, descriptors, CRCs, flags, versions, regular entry types, duplicates, declared sizes, trailing data, and aggregate limits; entries inflate one at a time in 16 KiB chunks into private files with pinned size/hash metadata. Administration validates first, then imports and opens the resulting project. Platform token exporters remain bounded. | Individual JSON/raster entries are still read under the 64 MiB per-entry cap when parsed or normalized. Add a larger adversarial corpus, sustained concurrent-import/resource evidence, and packaged cross-platform proof. |

## Phase 3 — agents and automatic Codex connection

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| FormaSpec MCP identity and workflow | **Implemented foundation** | Server ID `formaspec`, Minimal UI alias, `formaspec://` resources, preview-inspect-lint-commit instructions, strict 52-tool/25-resource contracts with exact nested success DTOs, bounded checksummed `handoff_list` keyset pagination, and the current schema-13 20-step release scenario pass. | Broaden revocation/reconnection plus large-history cursor/load evidence and retain hosted client runs |
| Design/product-spec/planning/task/connection MCP tools | **Implemented foundation** | Strict tools cover organization policy, design discovery/mutation/history, product specs, planning, tasks, connections, design-system releases/pins/upgrades, revision-bound historical releases, path-free inventories, handoffs, Redesign Studio, and exact pinned-release component insertion. `design_system_component_insert_preview` is a read-only preview tool that returns a PNG and exact preview/component metadata; the ordinary commit tool remains the only commit path. Current application tests cover all 52 tools, 25 resources, and 108 protected routes. | Add agent release E2E, hosted evidence, and broader long-running/revocation/load coverage |
| Immutable tasks and append-only transitions | **Implemented foundation** | Persistent inputs, transition history, claim/progress/completion/cancellation/expiry checks, audit/outbox, API/MCP, initial UI actions, and the integrated website-to-agent path exist | Expected-output enforcement across every task kind and broader cancellation/expiry browser coverage |
| Automatic Codex adapter | **Implemented foundation** | `formaspecctl` starts the bridge, obtains one-time pairing authorization, atomically replaces older matching Codex connections, configures token-free MCP, installs/verifies the managed Minimal UI skill/plugin, and exposes the mention; the bridge fails closed without its OS-stored scoped grant. Scope, expiry, adapter enablement, connection count, and required project restrictions are derived from organization policy. | Clean install/upgrade/reconnect/revoke matrix on supported OSes and packaged runtime |
| Secret storage | **Implemented foundation** | macOS Keychain, Linux Secret Service, and Windows current-user DPAPI stores exist and fail closed. DPAPI plaintext is accepted only over stdin, never argv/environment, and only ciphertext is written under the private user-local credential directory; injected-runner tests prove round-trip, clearing, and unavailable-store failure. | Run clean packaged lifecycle tests on real Windows, macOS, and Linux hosts and verify OS ACL/keyring behavior. |
| Generic MCP clients | **Implemented foundation** | Print-only `formaspec-mcp-config` and `formaspecctl agent config generic` produce validated token-free loopback Streamable HTTP JSON/TOML plus verification instructions without reading or modifying unknown client files | Parameterize non-Codex pairing identity/scopes and add tested client-specific adapters only where their configuration contract is known |
| Agent Connections UI and pairing | **Implemented foundation** | Administration UI lists status/scopes/project restrictions/last-use/expiry and supports explicit Codex pairing, reconnect, and immediate revoke | Editable scope/project controls, registered-protocol installer evidence, and end-to-end reconnect/revocation coverage |
| Before/after review | **Implemented foundation** | Task-scoped review shows immutable base and exact proposed documents in toggle or side-by-side mode, highlights added/removed/modified nodes, lists diagnostics and hashes, links the exact PNG, and supports exact commit or discard. Discard atomically expires the preview, and task/agent ownership is validated. | Add broader browser/accessibility coverage and richer moved/reordered-node presentation |

The source installer commands are present:

```bash
./designer --yes install docker
./designer --yes install local
./designer --yes agent connect codex
./designer agent config generic --format json
```

Known integration gaps prevent calling this phase complete:

- A fresh isolated Docker local project now has startup, renderer-health, and
  API-restart persistence evidence, and the installed volume has automatic
  schema-7-to-8 upgrade evidence. Server-mode reverse-proxy deployment,
  supported restore, resource-exhaustion, and long-duration evidence remain.
- New compatibility server configurations emit strict `APP_MODE`, allowed-host,
  trusted-proxy, CORS, and container-boundary variables; legacy secure env
  files receive equivalent fail-closed Compose overrides without rewriting the
  stored secret file. Clean reverse-proxy deployment evidence remains missing.

## Phase 4 — Workspace Bridge and handoff

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Loopback agent bridge | **Implemented foundation** | A bounded local bridge proxies MCP and stores only the scoped upstream grant outside Codex configuration | Package as a self-contained pinned-runtime executable and complete Windows storage |
| Separate repository Workspace Bridge | **Implemented foundation** | Local explicit expiring/revocable grants and bounded scanning load organization repository policy, persist the enforced exclusions with the grant, produce a strict path-free inventory, and automatically persist it through REST or preferably the authorized token-free MCP bridge. Central hashes, deduplication, lifecycle, authorization, audit, reads, and replayable events exist. | Package/supervise the bridge, complete native credential-store evidence, expand secret fixtures, and add an authenticated direct-REST workstation identity channel for trusted-header deployments; the MCP bridge path already works without exposing a token. |
| Framework-aware scanners and implementation mappings | **Implemented foundation** | Bounded fail-closed scanners cover web, Android, iOS/Xcode, Flutter, React Native, and generic Git with stable opaque cross-page IDs; Workspace Bridge passes 37/37. Strict batches now create immutable mappings from explicit exact-revision design IDs to opaque inventory entity IDs only. The service pins and revalidates the V2 snapshot/revision chain, product-specification version/hash, single active inventory/hash/fingerprint/platform, compatible source entity, authorization, idempotency, audit, and outbox state. REST, MCP (`implementation_mapping_read/create`), resources, independent agent scopes, and an explicit reviewed browser mapping surface exist; source paths and caller-supplied source metadata are rejected. | Add automatic mapping suggestions, incremental rescans, richer framework semantics, portable mapping round-trip semantics, broader tamper/browser E2E, and false-positive controls. |
| Approval-gated handoff/implementation | **Implemented foundation** | Revision/inventory-pinned handoffs, strict acceptance criteria/slices, immutable versions/transitions, REST/MCP/events, and reviewed mapping UI exist. Migration 12 persists append-only, independently authorized plan approval, branch/worktree isolation, diff review, validation approval, commit approval, push authorization, and pull-request request/disposition decisions with per-kind CAS, idempotency, evidence hashes, audit/outbox records, and supersedes history. Start derives plan/isolation gates; completion derives all seven persisted dispositions and accepts only a summary. Plan approval itself requires `expectedPriorDecisionId`, preventing stale approval from superseding a newer denial. The focused browser flow passes 1/1 and proves all seven controls/history entries. Workspace Bridge still binds each local grant to the exact central inventory and launches Codex with `shell: false`, exact repository `cwd`, one version/hash-bound secret-free handoff argument, a minimal environment, and ongoing revocation monitoring. | Finish packaged supervision, broader role/browser matrices, and Windows Job Object/equivalent descendant containment. |

## Phase 5 — Redesign Studio

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Seven-stage redesign assessment | **Implemented foundation** | Persisted ordered stages carry strict versioned artifacts and immutable CAS history. Browser entry now explicitly pins a current project and one active per-platform Workspace Bridge inventory while remaining assessment/planning-only. Entry into `future_state_proposal` additionally requires the exact current design revision/version, the sole active inventory, and at least one immutable mapping whose revision/product-spec/inventory/design-entity/opaque-source pins all verify; missing, stale, and forged evidence fails closed. Return/cancel paths remain available. | Complete the full seven-stage browser program with real mapping/design/handoff fixtures, inventory replacement/reconnection UX, and broader long-running resume/revocation evidence. |
| Independent assessment/proposal/design/implementation permissions | **Implemented foundation** | Dedicated role/scope checks independently gate assessment, review, interview, proposal, design, handoff, approval, implementation, and cancellation | Complete role/grant/revocation matrix through REST, MCP, and browser E2E |
| “One click” planning-only behavior | **Implemented foundation** | Dashboard creation requires explicit project and active single-platform inventory selection, records `sourceMutation: "none"`, excludes untrusted project names from the fixed assessment instruction, and never modifies source. Design-only browser assessments are blocked; existing design-only records can continue through PM interview but cannot enter future-state proposal. | Add safe inventory attachment/recreation UX for historical design-only assessments and keep later reviewed stages on canonical domain artifacts. |

## Phase 6 — enterprise delivery

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Organization administration and policy-as-code | **Implemented foundation** | A strict schema-version-1 policy has REST, MCP tool/resource, a guided 12-section Administration form, Expert JSON, optimistic configuration hashes, secret-free YAML export, backup integrity binding, and enforcement across agents, trusted-role mapping, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. Organization-admin audit retention has exact 15-minute previews, a 30-day minimum, per-kind 2,000-row/8-MiB bounds with conservative and exact byte checks, policy/CAS revalidation, restart-safe idempotency, atomic guarded deletion, SSE replay gaps, permanent governance/recovery evidence, and an immutable SHA-256 run chain exposed through REST and `formaspecctl`. The current editor/prototype/administration/component-insertion browser suite passes 4/4. | Install external schedule invocation and alert delivery, complete policy rollout/version migration, delegated administration, and broader organization-lifecycle browser coverage |
| `formaspecctl` operator coverage | **Partial** | Install, doctor, status, start/stop/restart, migrate status, backup create/list/verify, schedule show/enable/disable/run with bounded warnings and critical alerts, preview-first exact prune, source-local restore, launcher-pinned Docker/server planned restore, explicit `backup restore offline <bundle> --yes`, `resume --offline-bundle`, status/resume/rollback/abort/stale-lock recovery, bounded support-bundle preview/create, generic MCP output, Codex connect, and selected-workspace Codex plan/dry-run/launch exist. When managed backup-ID preflight cannot open the current API/database, the CLI now directs the operator to the separately authorized offline command instead of incorrectly describing offline recovery as unimplemented. | Real server planned/offline recovery evidence, external scheduler/service-supervisor installation and alert delivery, full migrate lifecycle, upgrade/uninstall, and packaged cross-platform delivery |
| Native installers and automatic startup | **Partial** | The retained pre-current-SSE-authorization unsigned schema-12 macOS ARM64 PKG under `artifacts/candidates/schema12-current/` is a non-installed engineering checkpoint: SHA-256 `9724f2874c520b5b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`, 185,279,180 bytes. Its frozen source evidence passes with 342 components and zero violations; package integrity passes with 349 components, seven exact workspace trees, two bundled runtimes, payload-tree SHA-256 `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`, and workspace-tree SHA-256 `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`. A non-installing private expansion verified bundled Node v24.14.0, Chromium headless shell revision 1228, schema-12 health, real PNG rendering, exact MCP inventory, native state paths, cleanup, and unchanged install targets/receipts; summary SHA-256 is `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`. The candidate-root `SHA256SUMS` manifest verifies all 14 retained package, sidecar, source, runtime, reproducibility, and documentation entries. Same-host reproducibility failed: a repeat PKG had SHA-256 `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0` and size 185,279,075 bytes even though payload/workspace trees were identical; diagnostic summary SHA-256 is `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`. The preserved schema-11 and schema-10 candidates are historical. Source-level deterministic unsigned Linux DEB/RPM builders include pinned runtimes, hardened systemd API/renderer units, data-preserving lifecycle scripts, and strict protocol registration. A native-Windows-only WiX v4 unsigned-MSI builder checks internally consistent caller-supplied inputs, uses one cross-architecture UpgradeCode, a private verified payload snapshot, minimal WiX environment, and command deadlines. Tests use fake PE/CFB/WiX fixtures and do not establish a trust anchor, real WiX compile, or MSI validity. | Resolve Chromium/license-policy review, Developer ID signature, notarization, independent reproducibility, vulnerability scanning, and clean install/autostart/protocol/upgrade/uninstall/reinstall proof for a frozen final macOS source. Build/test real Linux artifacts/lifecycles. On Windows, fix LocalSystem/isolation, trust-anchor provenance, and validate extracted MSI output; supply and qualify the native service host, ACLs, SCM lifecycle, Job Object/equivalent containment, named-pipe Chromium runtime, protocol registration, signing, and clean lifecycle evidence. |
| Hardened Docker topology | **Implemented foundation** | One image runs separate API and renderer services with Unix-socket IPC, non-root worker, read-only roots, dropped capabilities, no-new-privileges, renderer network denial, tmpfs, resource limits, persistent `/data` and `/backups`, readiness, init, a host-supervised pinned `HEALTHY_PLANNED_RESTORE_ONLY` path, and explicit offline recovery. The disposable schema-13 image now passes startup/API restart, deterministic PNG equality, DNS/TCP/interface egress denial, Firefox/WebKit 12/12, and same-image source-to-clean-target copied-bundle recovery with complete cleanup. | Add real server-mode reverse-proxy planned/offline recovery, retained hosted/native egress/load/failure tests, image/OS scanning, alerting, remote/off-site exercises, and stricter API networking where deployable. |
| Release CI and evidence | **Partial** | Installed/link-verified `drizzle-orm` 0.45.2 now has current application 678/678, launcher 212/212, seven-workspace typecheck/build, 52-tool/25-resource/108-route authorization, Docker restart/egress, Firefox/WebKit 12/12, copied-bundle recovery, and exact 342-component/zero-violation SBOM/license evidence. The broad Chrome Playwright gates passed immediately before the dependency update and still need an exact-current rerun. No schema-13 native installer, signed provenance, image/OS scans, hosted run, supported-OS lifecycle matrix, or real server-mode/off-site recovery has been retained. | Rerun the broad Chrome Playwright matrix, resolve remaining dependency advisories, and complete security/native-delivery/operations evidence. |
| Signing/notarization/OAuth/GPG | **Blocked externally** | No credentials are fabricated | Produce reproducible unsigned artifacts and exact operator instructions until real credentials are supplied |

## Release-blocking gaps

Production readiness remains **NO-GO** until all of the following are resolved
and evidenced:

- Complete the remaining schema-13 release cycle: rerun the broad Chrome
  editor/selection/handoff/visual/inspect/performance/20-step matrix against
  installed 0.45.2, resolve remaining dependency advisories, broaden security
  and recovery fixtures, produce vulnerability/image/OS scans and native
  installers, and retain hosted evidence. Application, launcher, build/
  typecheck, Docker/egress, Firefox/WebKit, recovery, and exact SBOM/license
  gates now pass against 0.45.2.
- Complete the component visual contract: property-to-node bindings, slot
  anchors and overrides, content-hash asset copying, and broader insertion/
  upgrade authorization, browser/accessibility, stale/conflict, backup,
  export/import, and restore coverage.
- Real packaged Windows named-pipe/ACL/runtime/process-tree proof and retained
  hosted infrastructure-egress/failure/load evidence beyond the passing exact-
  current DNS/TCP/interface canary and Docker `network_mode: none` topology.
- Clean real-Nginx/TLS server-mode reverse-proxy startup, planned/offline
  restore, upgrade, and long-duration evidence beyond the controlled 1/1
  actual-socket proxy lifecycle and exact-current local two-service restart.
- Complete browser and visual-regression proof beyond the passing integrated
  20-step local scenario, Chrome alignment, and seven-scene DPR 1 foundations,
  including cross-platform RTL parity and pinned release CI images with
  retained traces/reports.
- Complete broader role/scope/project-parent, CSRF, Host/Origin, archive, asset,
  traversal, decompression, and secret-exclusion suites, plus real connected-
  agent semantic-resistance/approval-flow evidence beyond the passing prompt-
  injection-data regressions.
- Retain larger adversarial, concurrent-import/resource, and packaged cross-
  platform evidence for the implemented private-disk multipart and per-entry
  streaming path. Individual JSON/raster entries remain bounded by the 64 MiB
  per-entry limit when parsed or normalized.
- Clean server-mode `HEALTHY_PLANNED_RESTORE_ONLY` and explicit offline
  disaster-recovery lifecycle evidence, real remote-host/off-site policy,
  installed external scheduling/alert delivery, and long-running retention/prune failure-recovery
  evidence beyond the launcher-local foundation and tested 7/4/12 schedule.
- Broader disposable recovery evidence covering the verified schema-7
  checkpoint, normalized and legacy assets, design-system data, failure
  injection, reconnect/revocation, and historical customer fixtures. Current
  evidence includes the copied version-7-to-8 fixture, installed-volume
  upgrade, verified pre/post bundles, one isolated local-Docker A/B recovery
  exercise, the unique-Compose production worker/control offline corrupt-
  database restore/forensic-rollback smoke, and the passing source-local 20-step
  V1/V2/product-spec/task/hash/render scenario.
- An approved signing/provenance design. Source identity is now pinned across
  verification and cutover, but current checksums still prove consistency, not
  who created a bundle.
- Complete release-authoring ergonomics, rich project upgrade comparison, and
  the V2 head-migration operator workflow. Project pin controls and atomic V2
  head synchronization are implemented foundations.
- Reviewed mapping creation is implemented through strict REST/MCP and browser
  surfaces. Framework-aware bounded scanners cover the supported repository
  families; mappings pin exact design/product-spec/inventory integrity without
  accepting central filesystem paths. Automatic suggestions, incremental
  rescans, portable mapping round trips, and the broader tamper/role/browser E2E
  matrix remain incomplete. All seven independent handoff execution decisions
  are now append-only and enforced; selected-workspace launch still requires
  the explicit immutable implementation transition rather than approval alone.
- Complete the Redesign Studio's full real-fixture browser program and
  independent permission/revocation matrix. Strict artifacts and fail-closed
  readiness now exist for all seven stages.
- A release-ready native installer set. The unsigned schema-12 macOS ARM64 PKG
  matches its frozen packaged workspace outputs, passes private extracted-byte
  runtime checks, and was not installed. It predates schema 13, component
  source persistence/insertion, and the current 52-tool/108-route interface,
  so it is only historical engineering evidence. Its same-host repeat changed
  the outer PKG bytes despite identical
  payload/workspace trees, and Chromium/license-policy approval, signing,
  notarization, independent reproducibility, vulnerability scanning, and clean
  lifecycle proof remain open. The preserved schema-11 and schema-10 packages
  are historical only. Linux DEB/RPM and Windows WiX source builders exist, but
  real Linux artifacts/lifecycles and a qualified Windows service host,
  DPAPI/ACL/SCM/process-tree/runtime/protocol/signing lifecycle remain unproven.
- Artifact-specific container, Windows, and Linux SBOMs; image/OS scans;
  reproducibility; signing/provenance; retained GitHub-hosted workflow runs;
  and final release artifacts remain missing. A fail-closed high-severity pnpm
  advisory workflow with retained JSON now exists but has no hosted result.
  Repository-native workflows, 8/8 workflow contract tests, 8/8 release-
  evidence tests, 12/12 macOS package-evidence tests, and 10/10 macOS runtime-
  smoke tests exist. The schema-12 package matches only its frozen packaged
  workspace outputs. Exact schema-13 SBOM/license evidence now reflects linked
  `drizzle-orm` 0.45.2, but there is no current native package gate. The
  schema-12 package's same-host outer bytes are nondeterministic,
  and none of the remaining legal, signing, scanning, or native lifecycle
  gates is closed.

## Current operator conclusion

FormaSpec now has substantial enterprise-oriented foundations and a usable
source development path, including automatic Codex/Minimal UI connection.
Those foundations are suitable for continued local evaluation and incremental
development. They are not sufficient evidence for an enterprise production
deployment, migration, or signed native release.

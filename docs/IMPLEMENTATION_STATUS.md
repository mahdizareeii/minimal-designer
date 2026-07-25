# FormaSpec implementation status

Audit date: 2026-07-25

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

The schema-13 checkpoint from 2026-07-21 remains useful historical evidence,
especially its exact 342-component/zero-violation SBOM/license report. It is no
longer the newest browser, performance, Docker, or recovery checkpoint. Those
runtime gates have now been repeated against database schema 16; the historical
schema-13 SBOM/license evidence has not yet been replaced by a current scan.

The current schema-17 package suites pass 1,027/1,027: core 74, server 540/540,
web 145, CLI 129, local bridge 27, Workspace Bridge 37, and installer 75. Four
real Chromium render/raster tests use a scoped 20-second harness timeout while
the application render remains hard-bounded at 15 seconds. Recursive
typecheck and production build pass, launcher tests pass 276/276, and
`docker compose config --quiet` passes. The deterministic document-export cluster
passes 15/15, migration/backup/restore 59/59, Product/readiness/preview/MCP
44/44, and the macOS packaged-runtime contract 11/11. These package suites were
verified in the environments appropriate to their local IPC, Chromium, and
installer protocol contracts rather than inferred from one sandboxed umbrella
runner. Retained schema-16 browser and integration
evidence passes editor/Administration 11/11, the release scenario 1/1, server
preview integration 2/2, Chromium selection alignment 12/12, Firefox/WebKit
selection alignment 12/12, and visual regression 7/7. The macOS
packaged-runtime contract suite passes 11/11, the Docker Firefox/WebKit suite
passes 12/12, CI workflow contracts pass 8/8, and off-host recovery contracts
pass 7/7. The retained schema-16 handoff checkpoint also passed recursive
typecheck, recursive production build, `docker compose config --quiet`, and the
then-current macOS package-runtime contract. That contract covered a
superseded dual-identity payload and is not evidence for the current
single-plugin installation.

Current source contains the Organization-Ready 0.3.0 delta and is now database
schema 17. It adds first-class Products above Designs, immutable Product-bound
agent-task context, a strict senior product/design/engineering readiness
report, content-addressed exact preview PNG storage, secret-free review-launch
recovery, exactly one managed FormaSpec 0.3.0 plugin, linked responsive frame
variants, component property/slot/override/nesting/asset materialization, and
deterministic sanitized raster-backed SVG/PDF export. The advertised source
surface is 54 MCP tools, 26 resources, and 119 protected non-MCP routes. The
schema-17 package/typecheck/build/launcher gates above pass; full browser,
Docker/recovery, current scan, installed-plugin, and supported-OS release
aggregates remain pending.

The retained local evaluation runtime check at
`http://127.0.0.1:4320`: `/health/ready` reports database migration 16 and the
network-isolated Playwright worker with no software fallback. Its token-free
loopback bridge is healthy at `http://127.0.0.1:4312/health`, reports a
configured upstream, and serves MCP at `/mcp`. This live workstation check is
operational convenience evidence, not hosted release provenance. It predates
schema 17 and the single-identity FormaSpec 0.3.0 plugin. Current source
advertises only `[@FormaSpec](plugin://formaspec@formaspec)`; a refreshed live
initialize/install verification remains pending.

The retained schema-16 1,000-node release gate passed: initial interactive load
303.30 ms p95, selection response 26.80 ms p95, gesture 16.70 ms p95/maximum,
autosave 287.90 ms p95, history 17.30 ms p95, preview validation 325.88 ms p95,
and 1440x900 rendering 234.63 ms p95. All are within the release budgets.

Retained schema-16 Docker evidence uses image
`sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1`.
`artifacts/ci/docker-schema11/summary.json` records schema-16 readiness,
deterministic rendering across API restart, renderer DNS/TCP/interface egress
denial, hardened container settings, and cleanup. The same image passes the
Firefox/WebKit run in `artifacts/ci/cross-browser-docker/summary.json`.
`artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json` records a verified
bundle copied into an independent clean Compose project with SQLite integrity,
foreign-key, asset, snapshot/revision-hash, deterministic-render, and cleanup
checks. That recovery is explicitly a same-host disposable-isolation simulation,
not a real remote-host, network-transfer, or TLS exercise, and its summary marks
the exact current-source relationship as unverified.

Historical live agent acceptance before the website-only approval boundary also
passed on 2026-07-22. Exact preview
`preview_dd4da6b79f5e4ddf8b3fd111094c5189` rendered at 1440x900 with PNG SHA-256
`ad356b73d742c7852a86a022f86d68928dae021ab6710bd7b1d852f7e048e26c`, then
committed the project from version 1 to version 2 and completed its agent task.
The preview and committed revision documents are byte-identical at 76,099 JSON
bytes. Result snapshot SHA-256
`b84512db8bde0e1acdb8c1e8dbc81f6361530a54d880675e301a665a101292a5` and
operation SHA-256
`6ccf0226ccf0a59d6dbd3fd3ab62069c2a45fd522b5f5f9b5f842728428896be`
both match their persisted records. Current source deliberately blocks that
agent-side commit path: direct requests create and claim a `design_preview`
task, publish the exact persisted preview and contact-sheet scope to the website,
and create no revision until an authenticated human presses **Commit preview**.

These retained local schema-16 gates materially broaden the evidence base, but they
do not establish enterprise release provenance. The working tree remains an
unsigned enterprise-upgrade tree; signed current native installers, hosted
provenance, current SBOM/dependency/image/OS scans, real remote-host/TLS
recovery, and supported-OS install/upgrade/uninstall lifecycle evidence remain
unverified.

| Check | Recorded result |
| --- | --- |
| Prior broad package gates | Before schema 13, core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, installer 62/62 across 5 files, and launcher 212/212 passed. That checkpoint covered 51 MCP tools, 25 resources, and 106 protected non-MCP routes. It remains useful regression evidence, but it is not current-source verification. |
| Historical schema-13 application and source gates | At the retained schema-13 checkpoint, source declared database schema 13, command engine 2, renderer 3, renderer IPC protocol 2, and font bundle 1. Migration 13 persisted canonical component source JSON/SHA-256 plus immutable exact base/result snapshot metadata for design-system upgrade previews. Source exposed 52 MCP tools, 25 resources, and 108 protected non-MCP routes. Installed/link verification confirmed `drizzle-orm` 0.45.2; application suites passed 678/678, launcher 212/212, and all seven workspaces passed typecheck/build. Audit reported info 0, low 0, moderate 2, high 0, critical 0. This remains historical relative to schema 17. |
| Last fully verified schema-16 application, authentication, and exact-preview gates | Source at that checkpoint declared database schema 16 and command engine 3. Migrations 14 and 15 added browser-session authentication and bounded write-once exact preview-render metadata; migration 16 canonicalized the legacy bootstrap-credential consumption trigger. The seven-package suite passed 957/957 across 147 files: core 64, server 508, web 135, CLI 114, local bridge 27, Workspace Bridge 37, and installer 72. Recursive typecheck/build and launcher 276/276 passed. Retained editor/Administration E2E 11/11, release scenario 1/1, Chromium alignment, visual regression 7/7, macOS runtime contracts 11/11, Docker Firefox/WebKit 12/12, CI workflow contracts 8/8, and off-host contract tests 7/7 passed. |
| Organization-Ready 0.3.0 source delta | **Implemented foundation; release gate open.** Source declares database schema 17, command engine 3, one FormaSpec 0.3.0 plugin, 54 MCP tools, 26 resources, and 119 protected non-MCP routes. Migration 17 introduces Products, deterministic Design-to-Product backfill, Product move previews, and immutable Product-bound agent-task context. Source also implements strict design-readiness evidence, content-addressed exact-preview PNG artifacts, `formaspec://open-review` links, fixed-purpose `ensure-running` recovery, linked responsive frames, richer component materialization, and deterministic sanitized SVG/PDF export. Current package suites pass 1,027/1,027 and recursive typecheck/build pass; full browser, Docker/recovery, scans, installed-plugin, and supported-OS release evidence remain pending. |
| Exhaustive SSE event authorization | The 18-event runtime policy is exhaustive and maps every event family to one required agent read scope, permitted human roles, and a project/organization/optional/control boundary. Seven focused policy/real-HTTP tests passed at the retained schema-16 checkpoint and pass in the current server run. A `design:read`-only agent cannot observe task, handoff, Redesign, connection, backup, audit-retention, or other administration events; `task:read` can open a useful task stream without `design:read`; connection, backup, and audit-retention families are Organization-Administrator-only for humans and unavailable to agents. Replay rows are filtered in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery applies the same policy. Scope-policy removal or connection revocation closes an existing stream. Retained hosted long-running evidence is pending. |
| Schema-17 migration fixtures | Deterministic schema 1 and schema 7–12 fixtures preserve stable IDs, canonical bytes, hash chains, and enterprise rows through the ordered migrations. Migration-14/15 fixtures add authentication and nullable exact-render metadata without fabricating an administrator, session, or historical PNG evidence. Migration-16 tests upgrade the exact legacy schema-14 and schema-15 bootstrap trigger, preserve credential rows, install the canonical trigger, and fail closed on schema-shape drift. Migration-17 source and fixtures deterministically create one active Product per existing Design, preserve Design IDs and heads, require a valid owner, and add immutable Product/task integrity. The focused migration/backup/restore cluster passes 59/59; broader anonymized-customer, packaged, and real remote-host restore fixtures remain pending. |
| Current all-workspace typecheck/build | Recursive schema-17 typecheck and production build pass across all seven workspace packages. Neither gate replaces signed artifacts, hosted provenance, current security scans, browser/Docker release evidence, or supported-OS lifecycle proof. |
| Current launcher suite | The schema-17 launcher suite passes 276/276 after session-mode initialization, bootstrap-token handling, pairing-ticket updates, reciprocal native/Docker data-store guards, Docker running/restarting/paused/created-state detection, bridge ownership and upstream-identity validation, mode-aware recovery guidance, transition locking, container-mode host-Node bypass, and local/Docker dry-run contracts that execute no package, CLI, Compose, or runtime-state mutation on a Node-less machine. |
| Retained schema-16 browser and preview integration | Editor/Administration E2E passed 11/11, the release scenario passed 1/1, server preview integration passed 2/2, and the web package passed 135/135. These cover prompt/task/preview/Commit-Discard usability, stale-preview clearing, PNG retry, immutable render metadata, fail-closed exact commit until the persisted PNG loads, and visible retryable active-project context state in the editor and exact review route. The historical live acceptance preview rendered 1440x900, committed version 1→2, completed its task, and proved exact 76,099-byte preview/revision JSON plus snapshot/operation hash equality. Current source additionally stores the exact PNG content-addressed by its recorded SHA-256 and serves/verifies that durable artifact for review; fresh schema-17 artifact and website-only commit coverage is pending. |
| Retained schema-16 browser selection alignment and revision inspect | Chromium alignment passed 12/12 within 0.75 CSS px. The same alignment suite passed Firefox/WebKit 12/12 in the retained local Linux image. Revision-inspect immutability remains covered independently. Hosted, supported-OS, schema-17, and retained trace evidence is still required. |
| Retained schema-16 visual regression foundation | Visual regression passed 7/7 baselines: desktop, phone, tablet, Persian RTL, typography, clipping, and normalized image. Cross-platform reviewed baselines, a schema-17 rerun, and hosted evidence remain pending. |
| 1,000-node foundation | Deterministic service benchmark passed at 20.43 ms p95 validation, 49.65 ms p95 apply, 134.43 ms p95 preview persistence, and 116.83 ms p95 render. This remains a coarse service/core gate rather than browser-interaction evidence. |
| Retained schema-16 1,000-node browser budgets | The Chromium gate passed: 303.30 ms p95 load, 26.80 ms p95 selection, 16.70 ms gesture p95/maximum, 287.90 ms p95 autosave, 17.30 ms p95 history, 325.88 ms p95 preview validation, and 234.63 ms p95 render. No release budget was exceeded. A schema-17 rerun, retained hosted reports, and supported-platform repetition remain required. |
| Retained schema-16 integrated PM-to-restore scenario | The release scenario passed 1/1, including the product-manager-to-backup/restore workflow. It remains local evidence rather than a hosted supported-OS release run, and a schema-17 rerun is pending. |
| Retained schema-16 Compose/runtime | Image `sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1` reached migration 16, rendered deterministic PNG SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf` before/after API restart, blocked renderer DNS and TCP egress with zero external interfaces, verified hardening, and cleaned up. The retained summary is `artifacts/ci/docker-schema11/summary.json` (format `formaspec-docker-schema16-ci-evidence`, SHA-256 `9096961bce57ccb8976e3c06ea8d4c501c58cc238d7cbea81864550cbbe29860`). Its `sourceSha` is `local-uncommitted-source`, so it is not hosted provenance or schema-17 evidence. |
| Codex connection | In authenticated mode, an Organization Administrator creates the short-lived challenge in Administration. The fallback command is `./designer --yes agent connect codex --pairing-nonce <nonce> [--connection-id <id>]`; the bridge posts only the nonce to the exact public `/api/agent-connections/pair` route, verifies an optional expected connection ID, stores the scoped grant in the OS credential store, and writes one token-free `formaspec` MCP configuration. FormaSpec 0.3.0 installs and verifies exactly one managed plugin before removing installer-owned duplicate legacy assets; unmanaged files are preserved and reported. The managed workflow resolves one Product and Design, never chooses by list order, captures immutable task context, and returns a readiness report plus exact review links without agent-side commit. Every database receives one persistent non-secret `store_[a-f0-9]{32}` identity, exposed by API health even during a readiness 503. The bridge pins that exact upstream origin/store pair, and its credential namespace includes both; MCP forwarding verifies the pair before reading the scoped credential. `status`, `doctor`, and review-link recovery reject UI/MCP origin or store mismatches and concurrent known Docker/native stores. The enabled Streamable HTTP endpoint is `http://127.0.0.1:4312/mcp` with `default_tools_approval_mode = "writes"` and no bearer-token environment variable or generated HTTP headers. A new Codex task is required to load refreshed plugin assets. |
| Retained schema-16 local cross-browser and recovery evidence | The image passed Docker Firefox/WebKit 12/12; `artifacts/ci/cross-browser-docker/summary.json` has SHA-256 `f3bf8212ae79f1058ee3caf7c746c7bc0676c6d9d951bf3b50d1449ec68a1adf`. A copied verified bundle restored into an independent clean Compose project with matching revision/snapshot hashes, assets, render, SQLite integrity, zero foreign-key violations, and complete cleanup; `artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json` has SHA-256 `fe43f516c063703a620688fe04736a946b45d42f77f615fe57b175d27ee509f4`. The summary explicitly denies real remote-host, network-transfer, and TLS proof and marks the prebuilt image/current-source relationship unverified. Exact schema-13 SBOM/license evidence passed with 342 components and zero violations, but it is not a current-source/schema-17 scan. |

The schema-12 macOS PKG under `artifacts/candidates/schema12-current/` is a
retained pre-current-SSE-authorization unsigned checkpoint, not a current-source
artifact. Its original package-integrity, runtime-smoke, checksum, and
reproducibility evidence remains valid for those frozen bytes. The current
verifier now records expected source drift: packaged `apps/server/dist`
predates migrations 13–17, exhaustive event authorization, the project/
revision-bound historical design-system release interface, source-backed
component insertion, browser-session authentication, durable exact-preview PNG
artifacts, Products and immutable Product-bound task context, and the current
single FormaSpec 0.3.0 plugin. A new package from current source has not been
built or installed.

The integrated local browser scenario, Chromium/Firefox/WebKit alignment,
visual baselines, 1,000-node Chromium performance gate, Docker restart/egress,
and same-host clean-target recovery passed at the retained schema-16 checkpoint.
There is still no
retained hosted/supported-OS editor matrix, signed current native-installer
matrix, trusted provenance, current complete vulnerability/SBOM/image/OS scan,
or real remote-host/TLS backup-restore deployment suite.

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
| 14 | `browser_session_authentication` |
| 15 | `preview_render_metadata` |
| 16 | `bootstrap_credential_trigger_canonicalization` |
| 17 | `product_organization_foundation` |

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
does not fabricate source data for historical rows. Migration 14 adds the
`password_accounts`, `browser_sessions`, `login_attempts`, and
`bootstrap_credentials` tables, together with the indexes and triggers that
enforce one bootstrap Organization Administrator, immutable account/session
identity, one-time bootstrap consumption, and account/principal consistency.
It creates no administrator account or active browser session by itself.
Migration 15 adds nullable, bounded `previews.render_metadata_json` plus an
immutable-once-recorded trigger. New MCP previews persist the exact page/node/
maximum-size target, output dimensions, renderer backend, warnings, and PNG
SHA-256; historical previews remain readable with null render metadata rather
than receiving fabricated evidence. Migration 16 replaces the exact known
legacy schema-14/schema-15 `bootstrap_credentials_consume_once` trigger with its
canonical definition without changing credential rows. The canonical trigger
permits token-hash rotation only before consumption, requires `consumed_at` and
`consumed_by` to transition together, and keeps consumption immutable once
recorded.
Migration 17 adds immutable organization-scoped Products, Product move
previews, `designs.product_id`, and Product-bound agent-task context. Existing
Designs are deterministically backfilled into one Product each without changing
their IDs or immutable heads. New tasks persist the exact Product, Design head,
canonical specification hash, effective design-system release, locale,
direction, platform, and repository inventory hashes captured when the task is
created. Product deletion is forbidden; archival and moving a Design between
Products use reviewed, CAS-bound flows.

Current runtime metadata is database schema 17, document schema 2, command
engine 3, renderer 3, renderer IPC protocol 2, raster normalizer 1, font bundle
1, export format 1, and application build `0.2.0`. Migration-2 SQL defaults stay
frozen at command engine 1, renderer 2, and font bundle 1 so current runtime
version bumps do not change the fingerprint of historical schema prefixes.

`apps/cli/src/migrations.ts` recognizes schema 17, matching the server source.
The current schema-17 CLI package passes 129/129, including 123 ordinary CLI
tests and the six bridge-lifecycle cases requiring local process/IPC access.
The current installer package passes 75/75. Packaged supported-OS lifecycle and
the refreshed live Codex installation remain pending.
A ledger prefix alone is not accepted as proof of migration completion: startup,
backup verification, restore preflight, and restore control validate the
required migration-9/10/11/12/13/14/15/16/17 tables, columns, indexes, triggers,
normalized schema SQL, and
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
migration 2 is recorded. Focused schema-14/15/16 fixtures advance genuine
schema-11 and schema-12 databases to version 16, preserve their recorded
enterprise rows, validate the authentication schema, preview-render
column/immutability trigger, and canonical bootstrap-consumption trigger, leave
administrator/session creation to the explicit bootstrap flow, and leave
historical preview render metadata null. Exact legacy schema-14 and schema-15
trigger fixtures additionally prove migration 16 preserves unconsumed
credential data while removing the legacy token-rotation defect. These
deterministic fixtures close the synthetic drop-table gap. A
same-machine copied-bundle
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
| Original resize reproduction recorded | **Implemented foundation** | `docs/EDITOR_COORDINATES.md` records the approximately 149% zoom/pan failure and coordinate contract; retained schema-16 Chrome DPR 1/2 automation covers fractional group geometry, nested scroll, actual delayed-font and image invalidation, normalized uploaded assets, selectable frame/ellipse geometry, rotated multi-selection, and vertical/wrapped/grid auto-layout gestures, while seven Chrome DPR 1 prototype baselines cover representative rendering. The retained Linux image additionally passed Firefox/WebKit 12/12. | Run the fresh schema-17 browser matrix and retain GitHub-hosted and supported-OS Firefox/WebKit evidence plus reviewed cross-platform visual baselines |
| Initial 1,000-node measurements | **Implemented foundation** | Deterministic core/service fixtures and the retained schema-16 20-sample pinned-Chromium gate measured initial load, selection, gesture frames, commit/autosave, history, preview validation, and a full 1440×900 PNG. Recorded p95 values are 303.30 ms load, 26.80 ms selection, 16.70 ms gesture p95/maximum, 287.90 ms autosave, 17.30 ms history, 325.88 ms preview validation, and 234.63 ms render; every local budget passed. | Rerun for schema 17, retain the machine-readable report in a provenance-bound release CI image, and repeat on supported release platforms/hardware |

## Phase 1 — correctness, persistence, and security

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Shared viewport transform and untransformed interaction overlay | **Implemented foundation** | `ViewportTransform`, one transformed canvas layer, viewport-coordinate overlay, stable targets, explicit root/container wiring, and exact client-space group geometry exist. The retained schema-16 alignment gate passed Chromium 12/12 within 0.75 CSS px and Firefox/WebKit 12/12 in the retained local Linux image. The fit-sync path uses `useLayoutEffect` to avoid the prior WebKit initial-fit race. | Rerun for schema 17, retain hosted/cross-OS evidence, and broaden the node/layout visual matrix |
| Geometry invalidation after viewport/layout/font/image changes | **Implemented foundation** | Coalesced refresh, `ResizeObserver`, `MutationObserver`, scroll capture, font/image readiness, imperative Moveable `updateRect()`, and browser coverage for nested scroll, explicit invalidation, a genuinely delayed bundled font, and a decoded normalized uploaded asset exist | Add broader layout/token mutation cases and cross-browser visual regression |
| Draft gestures, normalized commits, selection canonicalization | **Implemented foundation** | Draft transforms, fractional normalization, hidden/locked filtering, selection-root utilities, undoable one-command `move_node` gestures, auto-layout reorder/reparent, and fixed/fill/hug resize conversion are covered at DPR 1/2, including row-aware wrapped/grid insertion. Auto-layout resize never writes x/y and preserves rotation. | Add a visual insertion marker, define ambiguous multi-selection auto-layout behavior, and broaden cross-browser input paths |
| 1,000-node responsiveness | **Implemented foundation** | Node rendering is memoized and repeated traversal/index work is reduced. The retained schema-16 service timings and deterministic 20-sample pinned-Chromium gate passed every specified interaction/render budget with no gesture frame over 50 ms and no renderer fallback. | Rerun for schema 17, pin the execution image/hardware in CI, retain machine-readable reports/profiles, and repeat across supported release platforms |
| Strict `APP_MODE=local\|server` and HTTP hardening | **Implemented foundation** | Local loopback enforcement; local `AUTH_MODE=none` compatibility; local/server `AUTH_MODE=session`; server HTTPS/trusted-proxy/Host/Origin requirements; a separate server-generated proxy hop secret required on every non-health request; per-session CSRF; and CSP/security headers. Fresh public session deployments fail closed without the installer-generated bootstrap-token hash. Launcher generation/storage/scrubbing and output/support-bundle exclusion have focused tests; health remains credential-free. The historical controlled actual-socket lifecycle passes 1/1 for caller-header replacement, direct-peer denial, ambiguous append rejection, canonical trusted principal bootstrap, and restart-bound secret rotation. | Real Nginx/TLS, session and SSO deployment, firewall/routing, public backend-port, low/zero-downtime rotation, and compromise-response proof |
| Password-session authentication | **Implemented foundation** | Migration 14 persists one immutable bootstrap administrator identity, versioned scrypt password hashes, SHA-256-only 256-bit session-token storage, hashed per-session CSRF material, 8-hour idle/24-hour absolute expiry, login rotation/logout/revocation, bounded global/source/known-identity failure buckets, and one-time public-server bootstrap authorization. Session actors are revalidated against the live session/principal on every request, SSE event, and heartbeat. Restore reconciliation revokes all restored browser sessions. | Broaden real-browser, multi-process, proxy/TLS, clock-boundary, sustained abuse, password-recovery/rotation, and supported-OS lifecycle evidence before production |
| Organization, principal, membership, role, grant, ownership, policy, and audit model | **Implemented foundation** | Legacy organization/admin backfill, scoped/expiring/revocable grants, project ownership, append-only audit tables, strict versioned organization policy, a guided 12-section Administration form, Expert JSON, secret-free YAML export, optimistic configuration hashes, exact managed-connection rotation, and preview-first audit-retention execution plus durable scheduled-attempt start/success/failure evidence, overdue/retention-backlog diagnostics, critical failed/stalled-attempt reporting even when the current window already has a valid backup, and health aggregation exist. Trusted-header policy rejects duplicate effective identity values across all supported claim aliases, preventing order-dependent role assignment. Policy gates agents, repositories, assets, backups, and portable bundle export/import. | Complete delegated administration, install an external scheduler and alert delivery, stable managed-connection keys, and policy rollout/version-migration operations |
| Service-layer authorization across REST, SSE, MCP, assets, previews, and revisions | **Implemented foundation** | Central access resolution is used across core design and enterprise services. The current executable inventory contains 54 MCP tools, 26 resources, and 119 protected non-MCP routes: 55 project, 58 organization, and six explicit exceptions. Focused schema-17 route-contract/authentication tests assert 119/119, and the current server package passes 540/540. Coverage includes generated authentication rejection, direct behavioral authorization, Product discovery/context, session actors, nonce-only pairing, persisted exact-preview evidence, component insertion, and migration-17 integrity. Agent library reads require `design:read` plus `design_system:read`; insertion previews additionally require `design:preview`. | Add real-proxy session/SSO evidence and broaden long-running/load and full human-role/project-parent cross-products |
| Content-addressed snapshots and revision hash chains | **Implemented foundation** | Canonical uncompressed bytes are SHA-256 hashed; Brotli snapshots and immutable chain metadata are persisted | Historical upgrade fixtures and complete integrity/audit operator tooling |
| Exact preview and atomic commit | **Implemented foundation** | Ordinary design previews persist exact base/result hashes, engine versions, status, and snapshots for `BEGIN IMMEDIATE` CAS commits. Migration 15 additionally persists bounded write-once page/node/max-size render options, dimensions, renderer backend, warnings, and PNG SHA-256 after authorization/ownership/lifecycle checks inside an immediate transaction. Exact HTTP and MCP resources reuse those options, reject crop/size overrides, verify renderer/font versions plus backend/dimensions/SHA-256, and require explicit `mode=adhoc` for non-exact rendering. Current source additionally stores the exact PNG content-addressed by its recorded SHA-256, verifies regular-file/PNG/size/digest integrity on every read, and includes active artifacts in backup verification. Historical live acceptance proved a 1440x900 exact PNG, version 1→2 agent commit, completed task, exact 76,099-byte preview/revision JSON equality, and matching snapshot/operation hashes before the website-only boundary. The current focused Product/readiness/preview/MCP cluster passes 44/44; retained hosted browser/runtime evidence for website-only commit remains pending. | Retain release-candidate restart/concurrency/fault-injection and exact-upgrade equality evidence under hosted provenance |
| Archive-only destructive path | **Implemented foundation** | Ordinary commit paths reject `archive_nodes`; dedicated archive preview/commit REST and MCP paths exist | Complete approval-annotation and bypass coverage across every client surface |
| Replayable organization-scoped SSE | **Implemented foundation** | Persisted monotonic outbox IDs, `Last-Event-ID` replay, scope filtering, and gap signals exist. `/events` and `/api/events` resolve bearer tokens to scoped, revocable grant actors and session cookies to token-bound session actors. Authorization is re-resolved before every event and 15-second heartbeat. The retained schema-16 seven-test event-policy gate proved live/replay parity and scope/role isolation; three retained live-socket tests additionally proved session logout closes an open stream and both event routes close immediately on grant revocation. | Add the schema-17 aggregate, long-running reconnect/load/backpressure testing, real server-mode proxy/session streaming evidence, operational lag/retention monitoring, and broader retained role/scope stress evidence |
| Raster normalization | **Implemented foundation** | PNG/JPEG/WebP are fully decoded in the pinned Chromium renderer worker; APNG, animated WebP, MPO, malformed bytes, SVG, and MIME mismatches are rejected; JPEG and WebP EXIF orientation is applied; metadata is stripped by a deterministic canvas-to-PNG round trip; byte/pixel/output/IPC limits are versioned and matched between API and worker. Worker-backed decode now covers API upload, backup creation/verification, restore preflight, safety-backup verification, and final cutover; normalized bytes use generated SHA-256 paths with atomic dedup, read verification, and verified legacy-BLOB fallback. Sharp/libvips is absent from source, lockfile, and the rebuilt image. | Add operator-approved legacy quarantine cleanup, a larger malformed-image corpus, upload-storm/queue evidence, and real packaged cross-platform worker proof. |
| Bounded deterministic rendering | **Implemented foundation** | Versioned bounded IPC validates Unix-socket and Windows named-pipe endpoints and lifecycle behavior. Docker runs separate API/renderer services over the Unix socket with a new deterministic context per job, cleanup, queue/resource limits, non-root `pwuser`, read-only root, dropped capabilities, `network_mode: none`, no-new-privileges, fail-closed readiness, and no production fallback. The retained schema-16 image produced an identical PNG across API restart, passed Docker Firefox/WebKit 12/12, and failed egress closed with DNS `EAI_AGAIN`, direct TCP `ENETUNREACH`, and zero external interfaces. Migration 11 persists bounded API-owned, database-free-worker job lifecycle metadata. | Run the schema-17 image gate; complete self-contained native worker packaging, real Windows named-pipe/ACL/runtime proof, retained hosted infrastructure-egress runs, configurable retention operations/UI, and release load evidence. |
| Verified backup/restore primitives | **Partial** | Online SQLite backup, semantic bundle verification, descriptor-pinned streams, policy schedules/retention, durable audit/outbox evidence, explicit CLI restore, maintenance/lock fencing, crash journals, safety backups, capacity checks, offline forensic recovery, revocation, and resume/rollback/abort controls exist. The current focused migration/backup/restore/maintenance cluster passes 59/59, and retained off-host contract tests pass 7/7. The schema-16 same-host isolation smoke copied a verified bundle to a distinct location and restored it into an independent clean Compose project; revision/snapshot hashes, assets, deterministic render, SQLite integrity, zero foreign-key violations, and cleanup all passed. The retained `NO-GO` summary is `artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json`; current packaged/Docker and real off-host schema-17 recovery evidence is pending. | Complete real remote-host/network/TLS and server-mode proxy planned/offline restore; add broader failure/corruption/customer fixtures, packaged native recovery, off-site storage, cross-platform drills, installed scheduling/alerts, signed provenance, and an OS-native no-replace cutover primitive. |
| Design-system backup/import/restore integrity | **Implemented foundation** | Backup verification validates every project pin's organization/project ownership and exact immutable system/release/version, accepts both published and legitimately deprecated pinned releases, requires each V2 head to equal its pin row, permits a rowless V2 head only for the exact bundled Foundation tuple, accepts historical V2 releases and transitional V1 pins, and fails closed on tampering. V2 portable import keeps the Foundation default implicit but validates and atomically inserts custom local-organization published pin rows, rejecting external IDs. V2 restore preserves the active pin only when its release contains every token/component used by restored content; otherwise it blocks with structured `USED_TOKEN_REMOVED` or `USED_COMPONENT_REMOVED` diagnostics. Restore policy/provenance is durable in revision metadata and an atomic audit event, while V1 reports `not_applicable_v1`. V1→V2 migration backup eligibility now covers the later of project-head time and `project_design_system_pins.pinned_at`. | Retain larger historical/customer bundle fixtures, signed provenance, and packaged/server-mode recovery exercises containing custom design-system data |
| Health contract | **Implemented foundation** | `/health/live`, `/health/ready`, and `/health/render` exist; live and ready responses expose the database's persistent non-secret `store_[a-f0-9]{32}` identity, including readiness-503 responses, so launchers and bridges can distinguish separate healthy or temporarily unavailable runtimes. Docker readiness proves migration version, worker mode, Playwright, and software-fallback state; `/health/ready` also aggregates bounded overdue and retention-backlog diagnostics and keeps failed/stalled attempts critical even when the current window already has a valid backup. | Add deeper storage/outbox capacity indicators, external alert delivery, and long-running failure/recovery evidence |

Phase 1 is not closed. The retained schema-16 local Chromium/Firefox/WebKit
alignment, visual, performance, Docker egress, and same-host recovery gates
passed, and current schema-17 package/typecheck/build gates pass, but the full
authorization/security matrix, real server-mode and remote-host/TLS recovery,
continuous hosted egress/load evidence, signed provenance, and supported-OS
deployment gates have not all passed.

## Phase 2 — V2, design system, and product specification

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Strict V2 document model | **Implemented foundation** | Strict V2 schemas include semantic roles, locale/direction, typed token references, component data, mappings, migration diagnostics, and explicit non-rendered quarantine for unsupported V1 asset kinds/MIME types. Canonical V2 heads flow through reads, previews, render/lint, MCP resources, JSON/portable export, restore smoke, and V1-compatible browser projection. | V2-native token authoring, component-to-project synchronization, and advanced editor support remain bounded |
| Deterministic V1-to-V2 migration | **Implemented foundation** | Backup-gated, organization-admin-only, idempotent active-head migration preserves every stable project/page/node/token/asset/prototype ID, keeps historical V1 revisions byte/hash exact, creates one system-authored V2 revision with source revision/snapshot/backup provenance, and quarantines free-form overrides plus legacy GIF/font/video/binary assets without dropping metadata. A 5-test complete V1 compatibility corpus and active-head service fixture pass. | Add larger real-customer fixture archives, signed backup provenance, operator migration UI, and full migration/rollback E2E |
| FormaSpec Foundation System | **Implemented foundation** | Three token layers, light/dark/high-contrast modes, Inter/Vazirmatn, component definitions/states, reusable patterns, a persisted organization design-system service, and typed component-contract authoring in Administration exist | Complete token/release authoring, project upgrade visual comparison, and broader visual parity evidence |
| Component contracts and releases | **Implemented foundation** | New component versions require an authorized immutable V2 revision source. The server captures bounded detached state trees, canonicalizes and SHA-256 hashes them, stores paired source bytes/hash, and can generate a new opaque component ID when the first definition omits one. Contracts include typed property-to-node bindings, slot anchors, allowed visual-override paths, states, documentation, and platform mappings. Legacy null-source versions remain readable but are explicitly unpublishable in new releases. The browser authoring flow selects real visible container roots from immutable V2 revisions and displays source hash/node-count status. | Add richer contract/release authoring UI, delegated-role policy, state/theme matrix authoring, visual upgrade comparison, and broader accessibility/governance evidence |
| Source-backed component insertion | **Implemented foundation** | `GET /api/designs/:id/component-library` exposes only the exact pinned release with verified-source/dependency blockers. `POST /api/designs/:id/component-insertion-previews` and MCP `design_system_component_insert_preview` hydrate transitive tokens; apply typed property bindings, slot anchors/content, and definition-allowed visual overrides; resolve bounded nested-component graphs; verify/copy normalized image assets by exact content hash; materialize deterministic archived/locked masters; and create an exact prepared V2 preview committed only through ordinary preview CAS. The browser Components tab uses that same flow. Generic MCP operations reject the server-only `insert_component_instance` operation. Release upgrades separately remain fail-closed for asset-bearing sources and existing non-empty property/slot instances. | Add broader browser/accessibility, stale/conflict, backup/export/import/restore, safe release-upgrade rematerialization, and full authorization evidence |
| Linked responsive frame variants | **Implemented foundation** | V1/V2 frame schemas and typed `update_node` operations support reciprocal same-page responsive groups with stable opaque IDs, identical ordered member lists, and half-open non-overlapping breakpoint ranges. Archive reconciliation removes archived members and unlinks a lone survivor without rewriting history. The browser can link multi-selected frames by width, inspect/select/recalculate/unlink a group, and preserves relationships through undo/redo. Focused core tests pass 9/9, web responsive tests pass 3/3, V1→V2→V1 preservation is exact, and task-backed MCP preview coverage proves an atomic responsive batch creates no revision before approval. | Add theme-plus-breakpoint stakeholder preview, broader browser visual coverage, and organization-level responsive design guidance |
| Project design-system pinning and V2 head synchronization | **Implemented foundation** | The editor exposes project pin/release controls that clear stale cross-project state and disable while loading or mutating. Assigning or upgrading a real pin creates exactly one atomic V2 revision synchronized with the pin row; V1 heads remain unchanged. Schema-13 V2 upgrade previews materialize target tokens and verified component masters into an exact stored result snapshot, update compatible instances, and block removed states, missing token dependencies, asset dependencies, legacy null sources, or unsupported property/slot bindings. | Add richer visual upgrade comparison, bulk/project-governance workflows, and broader browser/authorization/backup coverage |
| Product organization and design readiness | **Implemented foundation** | Migration 17 adds first-class organization-scoped Products above Designs and deterministically backfills each existing Design into one active Product without changing the Design ID or immutable head. Source includes authorized Product list/read/create/update/archive flows, reviewed CAS-bound Design move previews, Product-aware design creation, and a strict readiness-report schema required by the managed workflow covering Product/specification context, design-system release, reused/extended/proposed components, platforms, repository mappings, assumptions, blockers, hierarchy, visual consistency, states, accessibility, touch targets, RTL/localization, responsive variants, prototypes, engineering feasibility, and lint. Product archival remains recoverable; Product deletion is forbidden. Current focused Product/readiness/preview/MCP tests pass 44/44. | Run the full browser Product organization flow and exhaustive role/scope/project-parent matrix under release provenance; broaden real migration/restore fixtures |
| Product specification preview/commit | **Implemented foundation** | Versioned natural-language/structured specification service, exact preview/commit, diagnostics, MCP tools, API, and initial panel exist | Complete structured editor coverage, linked entity workflows, accessibility/rule linkage, and product-manager E2E |
| Persistent 22-section PM interview | **Implemented foundation** | Versioned sessions, answers, transitions, all required section definitions, API/MCP, and initial browser interview exist | Resume/edit/review browser E2E and broader validation/elicitation UX |
| Enterprise editor information architecture | **Implemented foundation** | The editor now provides Pages/Layers/Components/Assets navigation; Canvas/Prototype/Before-After workspaces; Design/Content/Component/Logic/Prototype/Accessibility inspector tabs; and a collapsible activity/diagnostics/revision/handoff area. Before-After selects the workspace automatically, supports minimize/reopen, archive comparison, focus transfer/trapping, inert background, and Escape. Components/assets navigate to the owning page before selection. The retained schema-16 editor/prototype browser gate passed 2/2, including click-to-frame navigation without canonical mutation. | Run the schema-17 browser gate and broaden cross-browser, screen-reader, large-project, and end-to-end editing coverage |
| Revision-pinned inspect | **Implemented foundation** | `GET /api/projects/:projectId/revisions/:revisionId/inspect` and the browser view distinguish the immutable pinned revision from the current head. They expose integrity hashes, node measurements and resolved token references, assets/hashes, component evidence, revision-linked product rules and acceptance criteria, implementation mappings, stable IDs, and JSON paths. Focused server/web coverage plus the retained schema-16 1/1 revision-inspect immutability E2E passed independently of the 12/12 selection-alignment gate. | Run the schema-17 browser gate and add broader accessibility, authorization, large-project, and cross-browser evidence |
| Enterprise lint catalog | **Implemented foundation** | Deterministic V2 lint now reports raw design values, missing interactive states, semantic hierarchy, accessible names, touch targets, missing prototype actions, RTL locale/alignment mismatches, detached/draft/deprecated components, invalid typed properties/slots/states, missing business-rule/acceptance links, and invalid product-spec entity links. Focused tests cover the catalog; the retained schema-16 seven RTL/representative visual baselines passed. | Run the schema-17 visual gate; add organization-policy severity tuning, editor filtering/fix actions, broader accessibility automation, and release-scale diagnostic UX evidence |
| Portable import/export and platform token exporters | **Implemented foundation** | Strict checksum-validated `.formaspec.zip` export, read-only validation, and Organization Administrator mutating import exist. `POST /api/imports` requires an idempotency key and supports default `conflict_fail` ID preservation or explicit deterministic `clone` remapping. V1/V2 documents rebase to local revision 1; product specifications persist atomically as local version 1; Foundation-backed V2 documents may retain the implicit bundled default; and custom V2 pins must resolve to a published local-organization release and are inserted atomically with the project. Arbitrary external system/release IDs are rejected. Raster assets are fully decoded and normalized through the isolated worker; legacy assets remain metadata-only quarantine; and migration 10 records immutable source/target provenance plus the canonical ID map and diagnostics. Multipart upload bytes stream into a private mode-`0700` directory and mode-`0600` archive while size/SHA-256 are computed. Bounded file reads validate central/local headers, descriptors, CRCs, flags, versions, regular entry types, duplicates, declared sizes, trailing data, and aggregate limits; entries inflate one at a time in 16 KiB chunks into private files with pinned size/hash metadata. Administration validates first, then imports and opens the resulting project. Platform token exporters remain bounded. | Individual JSON/raster entries are still read under the 64 MiB per-entry cap when parsed or normalized. Add a larger adversarial corpus, sustained concurrent-import/resource evidence, and packaged cross-platform proof. |
| Deterministic document SVG/PDF export | **Implemented foundation** | Authenticated saved-revision export accepts bounded version/page/node/max-size selection, renders through the pinned renderer, validates PNG signature/chunks/checksums/color/dimensions, and emits stable raster-backed SVG or deterministic PDF bytes. Responses carry artifact/source-PNG SHA-256 evidence, restrictive CSP, `nosniff`, and immutable caching only for explicit historical versions. The editor exposes JSON, PNG, SVG, PDF, and portable actions and requires an explicitly saved revision; selected frames are exported when present. The focused server/HTTP/web export cluster passes 15/15. | SVG is intentionally a sanitized PNG wrapper rather than editable vector geometry. Add multi-frame stakeholder bundles, print/color-management qualification, accessibility metadata, and packaged cross-platform render evidence. |

## Phase 3 — agents and automatic Codex connection

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| FormaSpec MCP identity and workflow | **Implemented foundation** | Server ID `formaspec`, `formaspec://` resources, and the managed workflow require one explicit Product and Design, a claimed direct-request `design_preview` task, preview/render/lint inspection, a strict design-readiness report, and transition to `awaiting_approval`. The managed task-backed workflow forbids agent-side commit/restore; only the authenticated website action commits or discards. The exact persisted review image, task/Product/Design/base/expiry details, `reviewDeepLink`, and secret-free `formaspec://open-review` recovery link are returned for website approval. The only advertised identity is `[@FormaSpec](plugin://formaspec@formaspec)`. Current server tests pass 540/540 and focused Product/readiness/preview/MCP tests pass 44/44. | Run the task-backed browser E2E under retained release provenance; broaden revocation/reconnection plus large-history cursor/load evidence; prove supported-OS installed plugin lifecycle |
| Product/design/spec/planning/task/connection MCP tools | **Implemented foundation** | Current source exposes 54 tools and 26 resources, adding Product list/read discovery to the strict organization-policy, design/history, exact task-backed preview, product-specification, planning, task, connection, design-system, inventory, mapping, handoff, Redesign Studio, and component-insertion surface. Preview tools return PNG plus immutable render options/dimensions/backend/warnings/SHA-256; exact resources and default `design_render(preview_id)` replay and verify the same evidence. Multi-page changes use one bounded contact sheet; page/token/component scope inference and archived-page tombstones prevent hidden changes. Human-authenticated website routes are the design-preview commit boundary. The current server package passes 540/540, including Product, readiness, task-context, preview-artifact, and review-link coverage. | Add hosted agent release E2E and broader long-running/revocation/load coverage |
| Immutable tasks and append-only transitions | **Implemented foundation** | Persistent inputs, transition history, claim/progress/completion/cancellation/expiry checks, audit/outbox, API/MCP, initial UI actions, and the integrated website-to-agent path exist. Migration 17 also binds each new task to immutable resolved Product/Design context: Product identity, exact Design head/version, canonical specification hash, effective design-system release, locale, direction, platforms, and repository-inventory hashes. Website and direct-request agents preview, inspect, lint, return the readiness report, and transition to `awaiting_approval`; only the authenticated website action commits or discards the exact preview. Current focused Product/readiness/preview/MCP tests pass 44/44. | Extend expected-output enforcement across every task kind, retain the full browser workflow in release CI, and broaden cancellation/expiry browser coverage |
| Automatic Codex adapter | **Implemented foundation** | `formaspecctl` starts the bridge, consumes an administrator-issued one-time pairing ticket when required, configures one token-free `formaspec` MCP with write approvals, and installs/verifies exactly one managed FormaSpec 0.3.0 plugin before removing only installer-owned duplicate legacy assets. Unmanaged files are preserved and reported. Startup refreshes an already-authorized managed install. Managed cleanup removes the exact legacy Minimal UI TOML parent/descendants while preserving multiline-string lookalikes, similarly prefixed IDs, unrelated configuration, failure safety, and retry idempotency. The fixed-purpose `formaspecctl ensure-running` command resumes only the recorded local, development, Docker, or server runtime, verifies the exact data-store identity, starts or validates the matching bridge, and refuses to guess or switch modes. `doctor` and `status` compare the UI/API, bridge, and known Docker binding instead of independently accepting different healthy instances. Current CLI tests pass 129/129, local bridge 27/27, Workspace Bridge 37/37, and installer 75/75. | Complete the live managed Codex upgrade and clean install/upgrade/reconnect/revoke matrix on supported OSes and packaged runtimes |
| Secret storage | **Implemented foundation** | macOS Keychain, Linux Secret Service, and Windows current-user DPAPI stores exist and fail closed. DPAPI plaintext is accepted only over stdin, never argv/environment, and only ciphertext is written under the private user-local credential directory; injected-runner tests prove round-trip, clearing, and unavailable-store failure. | Run clean packaged lifecycle tests on real Windows, macOS, and Linux hosts and verify OS ACL/keyring behavior. |
| Generic MCP clients | **Implemented foundation** | Print-only `formaspec-mcp-config` and `formaspecctl agent config generic` produce validated token-free loopback Streamable HTTP JSON/TOML plus verification instructions without reading or modifying unknown client files | Parameterize non-Codex pairing identity/scopes and add tested client-specific adapters only where their configuration contract is known |
| Agent Connections UI and pairing | **Implemented foundation** | Administration UI lists status/scopes/project restrictions/last-use/expiry and is the authenticated boundary for connection creation/reconnect/revoke. Connect and reconnect issue a short-lived `fspair_…` nonce plus optional expected `connection_…` ID, open a bearer-grant-free `formaspec://connect-agent` link, and show the exact CLI fallback. The UI now creates `Codex — FormaSpec` connections and states that the fallback contains no bearer grant. Retained schema-16 targeted editor/Administration E2E passed 5/5; automation still did not exercise an installed custom-protocol lifecycle. Only `POST /api/agent-connections/pair` is nonce-authorized for the headless bridge. | Run the schema-17 browser gate; add editable scope/project controls, installed registered-protocol lifecycle evidence, and end-to-end reconnect/revocation coverage |
| Before/after review | **Implemented foundation** | Task-scoped review shows immutable base and exact proposed documents in toggle or side-by-side mode, renders every contact-sheet page rather than an unrelated first page, highlights added/removed/modified nodes, lists diagnostics, hashes, PNG dimensions, and PNG SHA-256, and gives the authenticated human persistent **Commit preview** or **Discard** controls after `awaiting_approval`. The editor and exact review route publish serialized, retryable context through an opaque per-tab `clientContextId`, display syncing/synced/standby/error state, and filter review context to pages/nodes present in the committed head. The server stores five-minute actor-scoped leases without a schema bump: identical project/page/selection leases collapse, distinct active leases return `AMBIGUOUS_CONTEXT` with bounded `contextRef` candidates, one tab can release only its own lease, and stale client leases are removed without deleting legacy context rows. The browser coordinates focus ownership, heartbeat refresh, queued release after in-flight writes, and keepalive unload release so tabs do not silently overwrite each other. Expired/read-failed previews clear stale approval controls; PNG failures expose Retry; exact commit remains disabled until the persisted PNG loads. Discard atomically expires the preview and is restart-safe/idempotent for lost-response retries. | Add broader browser/accessibility coverage and richer moved/reordered-node presentation |

The source installer commands are present:

```bash
./designer --yes install docker
./designer --yes install local
./designer --yes agent connect codex --pairing-nonce <nonce> --connection-id <id>
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
| Loopback agent bridge | **Implemented foundation** | A bounded local bridge proxies MCP and stores only the scoped upstream grant outside Codex configuration. Retained schema-16 tests passed 27/27 across two files, including authenticated pairing tickets, expected-connection checks, token-free MCP, origin-plus-store credential isolation, upstream readiness/store verification before credential access and forwarding, exact upstream-port restart, bounded large enterprise tool inventories, sanitized authenticated instance-control diagnostics, and fail-closed behavior. | Run the schema-17 aggregate; package as a self-contained pinned-runtime executable and complete installed cross-platform credential/protocol lifecycle proof |
| Separate repository Workspace Bridge | **Implemented foundation** | Local explicit expiring/revocable grants and bounded scanning load organization repository policy, persist the enforced exclusions with the grant, produce a strict path-free inventory, and automatically persist it through REST or preferably the authorized token-free MCP bridge. Central hashes, deduplication, lifecycle, authorization, audit, reads, and replayable events exist. | Package/supervise the bridge, complete native credential-store evidence, expand secret fixtures, and add an authenticated direct-REST workstation identity channel for trusted-header deployments; the MCP bridge path already works without exposing a token. |
| Framework-aware scanners and implementation mappings | **Implemented foundation** | Bounded fail-closed scanners cover web, Android, iOS/Xcode, Flutter, React Native, and generic Git with stable opaque cross-page IDs; the retained schema-16 Workspace Bridge suite passed 37/37. Strict batches now create immutable mappings from explicit exact-revision design IDs to opaque inventory entity IDs only. The service pins and revalidates the V2 snapshot/revision chain, product-specification version/hash, single active inventory/hash/fingerprint/platform, compatible source entity, authorization, idempotency, audit, and outbox state. REST, MCP (`implementation_mapping_read/create`), resources, independent agent scopes, and an explicit reviewed browser mapping surface exist; source paths and caller-supplied source metadata are rejected. | Run the schema-17 aggregate; add automatic mapping suggestions, incremental rescans, richer framework semantics, portable mapping round-trip semantics, broader tamper/browser E2E, and false-positive controls. |
| Approval-gated handoff/implementation | **Implemented foundation** | Revision/inventory-pinned handoffs, strict acceptance criteria/slices, immutable versions/transitions, REST/MCP/events, and reviewed mapping UI exist. Migration 12 persists append-only, independently authorized plan approval, branch/worktree isolation, diff review, validation approval, commit approval, push authorization, and pull-request request/disposition decisions with per-kind CAS, idempotency, evidence hashes, audit/outbox records, and supersedes history. Start derives plan/isolation gates; completion derives all seven persisted dispositions and accepts only a summary. Plan approval itself requires `expectedPriorDecisionId`, preventing stale approval from superseding a newer denial. The retained schema-16 focused browser flow passed 1/1 and proved all seven controls/history entries. Workspace Bridge still binds each local grant to the exact central inventory and launches Codex with `shell: false`, exact repository `cwd`, one version/hash-bound secret-free handoff argument, a minimal environment, and ongoing revocation monitoring. | Run the schema-17 browser gate; finish packaged supervision, broader role/browser matrices, and Windows Job Object/equivalent descendant containment. |

## Phase 5 — Redesign Studio

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Seven-stage redesign assessment | **Implemented foundation** | Persisted ordered stages carry strict versioned artifacts and immutable CAS history. Browser entry now explicitly pins a current project and one active per-platform Workspace Bridge inventory while remaining assessment/planning-only. Entry into `future_state_proposal` additionally requires the exact current design revision/version, the sole active inventory, and at least one immutable mapping whose revision/product-spec/inventory/design-entity/opaque-source pins all verify; missing, stale, and forged evidence fails closed. Return/cancel paths remain available. | Complete the full seven-stage browser program with real mapping/design/handoff fixtures, inventory replacement/reconnection UX, and broader long-running resume/revocation evidence. |
| Independent assessment/proposal/design/implementation permissions | **Implemented foundation** | Dedicated role/scope checks independently gate assessment, review, interview, proposal, design, handoff, approval, implementation, and cancellation | Complete role/grant/revocation matrix through REST, MCP, and browser E2E |
| “One click” planning-only behavior | **Implemented foundation** | Dashboard creation requires explicit project and active single-platform inventory selection, records `sourceMutation: "none"`, excludes untrusted project names from the fixed assessment instruction, and never modifies source. Design-only browser assessments are blocked; existing design-only records can continue through PM interview but cannot enter future-state proposal. | Add safe inventory attachment/recreation UX for historical design-only assessments and keep later reviewed stages on canonical domain artifacts. |

## Phase 6 — enterprise delivery

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Current installer source and protocol gate | **Implemented foundation** | The current schema-17 installer suite passes 75/75, recursive typecheck/build passes, and the macOS packaged-runtime contract passes 11/11. Current source packages and validates exactly one FormaSpec 0.3.0 plugin, rejects forbidden retired package paths, and removes installer-owned legacy assets only after the new plugin verifies. Ticket-aware protocol handlers for macOS, Linux, and Windows retain a 512-character URL limit, exact nonce/connection formats, fixed executable paths, quoted arguments, and strict malformed/credential-bearing input rejection. The canonical secret-free `formaspec://open-review?design=…&preview=…&task=…&store=…` handler invokes `formaspecctl ensure-running --json`, validates the exact origin/store identity, and opens the persisted review route. | Build and install frozen artifacts on supported operating systems; prove live Codex upgrade, protocol registration, upgrade/uninstall/reinstall, signing, ACL/service isolation, and end-to-end handler lifecycle. |
| Organization administration and policy-as-code | **Implemented foundation** | A strict schema-version-1 policy has REST, MCP tool/resource, a guided 12-section Administration form, Expert JSON, optimistic configuration hashes, secret-free YAML export, backup integrity binding, and enforcement across agents, trusted-role mapping, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. Organization-admin audit retention has exact 15-minute previews, a 30-day minimum, per-kind 2,000-row/8-MiB bounds with conservative and exact byte checks, policy/CAS revalidation, restart-safe idempotency, atomic guarded deletion, SSE replay gaps, permanent governance/recovery evidence, and an immutable SHA-256 run chain exposed through REST and `formaspecctl`. Retained schema-16 targeted editor/Administration E2E passed 5/5, and the retained session smoke proved the 5112-pixel Administration shell remains scrollable to import/recovery and can create a verified backup. | Run the schema-17 browser gate; install external schedule invocation and alert delivery, complete policy rollout/version migration, delegated administration, and broader organization-lifecycle browser coverage |
| `formaspecctl` operator coverage | **Partial** | Install, doctor, status, start/stop/restart, fixed-purpose `ensure-running`, migrate status, backup create/list/verify, schedule show/enable/disable/run with bounded warnings and critical alerts, preview-first exact prune, source-local restore, launcher-pinned Docker/server planned restore, explicit `backup restore offline <bundle> --yes`, `resume --offline-bundle`, status/resume/rollback/abort/stale-lock recovery, bounded support-bundle preview/create, generic MCP output, ticketed Codex connect, and selected-workspace Codex plan/dry-run/launch exist. The CLI recognizes schema 17. `ensure-running` resumes only the recorded mode, checks Docker availability where required, validates the exact origin/store binding, starts/verifies the bridge, and returns actionable structured blockers without silently switching data stores. Current CLI tests pass 129/129, including 123 ordinary cases and six bridge-lifecycle tests. Runtime diagnostics retain a valid store identity from readiness HTTP 503, compare UI/API and bridge origin/store pairs, and reject concurrent known Docker/native stores or unowned bridge processes. | Real server planned/offline recovery evidence, external scheduler/service-supervisor installation and alert delivery, full migrate lifecycle, upgrade/uninstall, and packaged cross-platform delivery |
| Native installers and automatic startup | **Partial** | The retained pre-current-SSE-authorization unsigned schema-12 macOS ARM64 PKG under `artifacts/candidates/schema12-current/` is a non-installed engineering checkpoint: SHA-256 `9724f2874c520b5b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`, 185,279,180 bytes. Its frozen source evidence passes with 342 components and zero violations; package integrity passes with 349 components, seven exact workspace trees, two bundled runtimes, payload-tree SHA-256 `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`, and workspace-tree SHA-256 `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`. A non-installing private expansion verified bundled Node v24.14.0, Chromium headless shell revision 1228, schema-12 health, real PNG rendering, exact MCP inventory, native state paths, cleanup, and unchanged install targets/receipts; summary SHA-256 is `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`. The candidate-root `SHA256SUMS` manifest verifies all 14 retained package, sidecar, source, runtime, reproducibility, and documentation entries. Same-host reproducibility failed: a repeat PKG had SHA-256 `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0` and size 185,279,075 bytes even though payload/workspace trees were identical; diagnostic summary SHA-256 is `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`. The preserved schema-11 and schema-10 candidates are historical. Source-level deterministic unsigned Linux DEB/RPM builders include pinned runtimes, hardened systemd API/renderer units, data-preserving lifecycle scripts, and strict protocol registration. A native-Windows-only WiX v4 unsigned-MSI builder checks internally consistent caller-supplied inputs, uses one cross-architecture UpgradeCode, a private verified payload snapshot, minimal WiX environment, and command deadlines. Tests use fake PE/CFB/WiX fixtures and do not establish a trust anchor, real WiX compile, or MSI validity. | Resolve Chromium/license-policy review, Developer ID signature, notarization, independent reproducibility, vulnerability scanning, and clean install/autostart/protocol/upgrade/uninstall/reinstall proof for a frozen final macOS source. Build/test real Linux artifacts/lifecycles. On Windows, fix LocalSystem/isolation, trust-anchor provenance, and validate extracted MSI output; supply and qualify the native service host, ACLs, SCM lifecycle, Job Object/equivalent containment, named-pipe Chromium runtime, protocol registration, signing, and clean lifecycle evidence. |
| Hardened Docker topology | **Implemented foundation** | One image runs separate API and renderer services with Unix-socket IPC, non-root worker, read-only roots, dropped capabilities, no-new-privileges, renderer network denial, tmpfs, resource limits, persistent `/data` and `/backups`, readiness, init, a host-supervised pinned `HEALTHY_PLANNED_RESTORE_ONLY` path, and explicit offline recovery. Retained schema-16 evidence passed startup/API restart, deterministic PNG equality, DNS/TCP/interface egress denial, Docker Firefox/WebKit 12/12, and source-to-independent-clean-target copied-bundle recovery with complete cleanup. The retained summaries all remain `NO-GO` and identify local-uncommitted or unverified source provenance. | Run the schema-17 image/recovery gate; add real server-mode reverse-proxy planned/offline recovery, retained hosted/native load/failure tests, current image/OS scanning, alerting, remote-host/TLS/off-site exercises, and stricter API networking where deployable. |
| Release CI and evidence | **Partial** | Current schema-17 package suites pass 1,027/1,027 (core 74, server 540/540, web 145, CLI 129, local bridge 27, Workspace Bridge 37, installer 75), and recursive typecheck/build pass. Launcher 276/276, Compose configuration, deterministic export 15/15, migration/backup/restore 59/59, Product/readiness/preview/MCP 44/44, macOS packaged-runtime contracts 11/11, release-evidence contracts 8/8, CI workflow contracts 8/8, off-host contracts 7/7, and cross-browser Docker contracts 2/2 pass. Retained schema-16 browser/runtime results remain regression evidence, not schema-17 release provenance. Current full browser, Docker/recovery, scans, installed-plugin lifecycle, and supported-OS release evidence remain pending. Exact 342-component/zero-violation SBOM/license evidence remains historical schema 13. | Run and retain the remaining schema-17 gates, freeze provenance-bound artifacts, run current scans, and complete signed native delivery, supported-OS lifecycle, hosted, and real remote-recovery evidence. |
| Signing/notarization/OAuth/GPG | **Blocked externally** | No credentials are fabricated | Produce reproducible unsigned artifacts and exact operator instructions until real credentials are supplied |

## Release-blocking gaps

Production readiness remains **NO-GO** until all of the following are resolved
and evidenced:

- Retain the passing schema-17 package/typecheck/build gates and run the
  remaining launcher, full browser, Docker, recovery, and installed-plugin
  aggregates under provenance-bound release CI. Retained schema-16 launcher,
  editor/Administration, release/preview, Chromium/Firefox/WebKit alignment,
  visual regression, 1,000-node performance, Docker restart/egress, and same-
  host clean-target recovery remain regression evidence, not verification of
  the current source. Current dependency/SBOM/image/OS security scans, signed
  artifacts, and installed supported-OS lifecycles are also missing.
- Complete richer component contract/release authoring and broader insertion/
  upgrade authorization, browser/accessibility, stale/conflict, backup,
  portable export/import, restore, and visual comparison evidence. Typed
  property bindings, slot anchors/content, allowed visual overrides, nested
  component resolution, and verified content-hash asset copying are now
  implemented foundations and must not be listed as missing features.
- Real packaged Windows named-pipe/ACL/runtime/process-tree proof and retained
  hosted infrastructure-egress/failure/load evidence beyond the current local
  schema-16 DNS/TCP/interface canary and Docker `network_mode: none` topology.
- Clean real-Nginx/TLS server-mode reverse-proxy startup, planned/offline
  restore, upgrade, and long-duration evidence beyond the controlled 1/1
  actual-socket proxy lifecycle and schema-16 local two-service restart.
- Promote the passing local schema-16 browser and visual matrix to retained
  hosted/supported-OS evidence, including cross-platform RTL parity, pinned
  release images, traces, and reports.
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
  database restore/forensic-rollback smoke, the schema-16 independent-clean-
  project same-host simulation, and the passing source-local 20-step V1/V2/
  product-spec/task/hash/render scenario. A real remote host, network transfer,
  TLS, remote credentials/storage, and RTO/RPO exercise remains absent.
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
  runtime checks, and was not installed. It predates schemas 13–17, component
  source persistence/insertion, Products, immutable Product-bound tasks, the
  single FormaSpec 0.3.0 plugin, and the current 54-tool/26-resource/119-route
  interface, so it is only historical engineering evidence. Its same-host repeat changed
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
  evidence tests, 12/12 macOS package-evidence tests, and 11/11 macOS runtime-
  smoke tests exist. The schema-12 package matches only its frozen packaged
  workspace outputs. Exact schema-13 SBOM/license evidence now reflects linked
  `drizzle-orm` 0.45.2, but there is no current native package gate. The
  schema-12 package's same-host outer bytes are nondeterministic,
  and none of the remaining legal, signing, scanning, or native lifecycle
  gates is closed.

## Current operator conclusion

FormaSpec now has substantial enterprise-oriented foundations and a usable
source development path, including automatic Codex/FormaSpec connection.
Those foundations are suitable for continued local evaluation and incremental
development. They are not sufficient evidence for an enterprise production
deployment, migration, or signed native release.

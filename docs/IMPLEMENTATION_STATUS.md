# FormaSpec implementation status

Audit date: 2026-07-20

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

Recorded source verification on 2026-07-20 (the working tree has additional
in-progress hardening changes, so these are checkpoint results rather than a
single final-tree release run):

| Check | Recorded result |
| --- | --- |
| Focused package gates | Core 40/40, server 235/235 with Chromium and Unix sockets, web 30/30, CLI 52/52 before the latest restore-hardening regressions, Workspace Bridge 23/23, and installer 41/41 through the Linux packaging checkpoint. Windows packaging and current proxy/restore changes require the final consolidated rerun. |
| Typecheck | All seven workspace packages passed: core, server, web, CLI, local bridge, Workspace Bridge, and installer |
| Production build | All seven workspace packages passed: core, server, web, CLI, local bridge, Workspace Bridge, and installer |
| Launcher suite | 165/165 passed at the recorded checkpoint |
| Browser alignment, auto-layout, and revision inspect | Playwright Chrome passed 6/6 tests: selection alignment across DPR 1/2, 25/100/150/200% zoom, fractional pan, LTR/RTL singles, and multi-selection stayed within 0.75 CSS px; auto-layout reorder/reparent/constraint resize preserved canonical geometry; revision-pinned inspect remained immutable after the head changed |
| Visual regression foundation | Playwright Chrome DPR 1 passed 7/7 approved native-size prototype baselines twice: desktop, phone, tablet, Persian RTL, typography, clipping, and normalized uploaded image |
| 1,000-node foundation | Deterministic harness passed; final rerun p95 was 17.71 ms validation, 36.18 ms apply, 132.17 ms service preview persistence, and 118.12 ms for a 512×320 Playwright render. This remains a coarse service/core gate rather than browser-interaction evidence. |
| 1,000-node browser budgets | Pinned Playwright Chromium passed the final 20-sample gate: 232.8 ms p95 cold interactive load, 20.8 ms p95 selection, 16.7 ms cadence-normalized gesture p95 with a 16.7 ms maximum, 261.9 ms p95 commit/autosave, 19.0 ms p95 history, 216.65 ms p95 preview validation excluding render, and 199.22 ms p95 for a 1440×900 Chromium PNG with no fallback or warnings. |
| Integrated PM-to-restore E2E | The isolated Playwright release project passed 1/1, covering all 20 browser/MCP/persistence steps: dashboard creation, backup-gated V1→V2 migration, product specification, all 22 interview sections, scoped agent pairing/task claim, multi-screen preview/lint/render/commit, human correction, selection refinement, immutable history restore, JSON/portable export, verified backup, stopped-database restore, restart, exact hash/state recovery, and PNG smoke. |
| Compose/runtime | `docker compose config --quiet` passed. The last fresh disposable two-service smoke reached healthy schema-10 readiness with the Playwright worker and no software fallback, processed a real 1,303-byte PNG, and preserved a project across API restart. Both services ran as `pwuser` with read-only roots, dropped capabilities, and resource bounds; the renderer used `network_mode: none`; and the Docker base image was digest-pinned. A fresh schema-11 rebuild/smoke remains required. |
| Codex connection | `./designer --yes start docker --no-build --no-open` refreshed the mode-`0600` runtime binding, started the loopback bridge, verified MCP `formaspec`, installed the managed Minimal UI skill/plugin, and exposed `[@Minimal UI](plugin://minimal-ui@formaspec)`. The generated Codex configuration remains token-free and uses write approval mode. Automatic authorization now intersects Codex scopes with organization policy, clamps expiry, and supplies project restrictions when required. |
| Source/release hygiene | The earlier schema-10 source evidence reports 342 third-party components and zero license-policy violations. The stale unsigned macOS candidate at `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg` is 184,835,514 bytes with SHA-256 `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`; its checkpoint integrity was `PASS`, but it does not represent the current schema-11 source and remains `NO-GO`. A fresh consolidated `git diff --check`, source-evidence run, and current artifact rebuild are required after the working tree stabilizes. |

The integrated local browser scenario and 1,000-node Chromium performance gate
pass on the current tree. There is still no comprehensive cross-platform editor/visual matrix,
security matrix, native-installer matrix, pinned release CI evidence, or
complete server-mode backup-restore/deployment suite.

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

The migrations preserve the legacy V1 columns while adding content-addressed
snapshots, integrity metadata, organization/agent workflow tables, preview
retention, scoped outbox state, backup metadata, schedules, operational locks,
design systems, repository inventories, implementation mappings, handoffs, and
Redesign Studio assessment history, bounded audit/outbox retention evidence,
immutable portable-import provenance, and bounded persistent render-job
lifecycle metadata.

`apps/cli/src/migrations.ts` recognizes the same version-11 ledger as the server.
A ledger prefix alone is not accepted as proof of migration completion: startup,
backup verification, restore preflight, and restore control validate the
required migration-9/10/11 tables, columns, indexes, triggers, normalized
schema SQL, and
forbidden legacy triggers and fail closed on schema-shape drift.
A copied version-7 database fixture now proves migration 8 preserves stored V1
revision bytes, snapshot hashes, revision hashes, and project heads. Real
customer backup/restore upgrade fixtures across earlier versions remain release
evidence that has not yet been completed.

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
exact public health `Host`, fixed Compose ownership, and token-free worker
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
| Original resize reproduction recorded | **Implemented foundation** | `docs/EDITOR_COORDINATES.md` records the approximately 149% zoom/pan failure and coordinate contract; Chrome DPR 1/2 automation now proves the corrected primary cases, and seven Chrome DPR 1 prototype baselines cover representative rendering | Add Firefox/WebKit where supported, fractional group-selection coverage, the full scroll/layout/font/image invalidation matrix, and reviewed cross-platform visual baselines |
| Initial 1,000-node measurements | **Implemented foundation** | Deterministic core/service fixture plus a 20-sample pinned-Chromium browser gate now measure initial load, selection, gesture frames, commit/autosave, history, preview validation, and a full 1440×900 PNG; all local release budgets pass | Retain reports in a pinned release CI image and repeat on supported release platforms/hardware |

## Phase 1 — correctness, persistence, and security

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Shared viewport transform and untransformed interaction overlay | **Implemented foundation** | `ViewportTransform`, one transformed canvas layer, viewport-coordinate overlay, stable targets, explicit root/container wiring, accurate positioning, and a passing Chrome alignment gate exist | Fractional-coordinate Moveable group children still round; complete scroll/cross-browser matrix remains |
| Geometry invalidation after viewport/layout/font/image changes | **Implemented foundation** | Coalesced refresh, `ResizeObserver`, `MutationObserver`, scroll capture, font/image readiness, and imperative Moveable `updateRect()` exist | Browser E2E and visual regression for every invalidation source beyond the current zoom/pan/direction matrix |
| Draft gestures, normalized commits, selection canonicalization | **Implemented foundation** | Draft transforms, fractional normalization, hidden/locked filtering, selection-root utilities, undoable one-command `move_node` gestures, auto-layout reorder/reparent, and fixed/fill/hug resize conversion are covered at DPR 1/2. Auto-layout resize never writes x/y and preserves rotation. | Add a visual insertion marker, define ambiguous multi-selection auto-layout behavior, and broaden the browser matrix to wrapped/grid edge cases and more cross-browser input paths |
| 1,000-node responsiveness | **Implemented foundation** | Node rendering is memoized, repeated traversal/index work is reduced, service timings pass, and the deterministic 20-sample pinned-Chromium gate passes every specified interaction/render budget with no gesture frame over 50 ms and no renderer fallback | Pin the execution image/hardware in CI, retain machine-readable reports/profiles, and repeat across supported release platforms |
| Strict `APP_MODE=local\|server` and HTTP hardening | **Implemented foundation** | Local loopback enforcement; server HTTPS/trusted-proxy/Host/Origin/CSRF requirements; CSP and security headers | Full proxy/CIDR/origin/CSRF test matrix and deployment proof |
| Organization, principal, membership, role, grant, ownership, policy, and audit model | **Implemented foundation** | Legacy organization/admin backfill, scoped/expiring/revocable grants, project ownership, append-only audit tables, strict versioned organization policy, Administration JSON editing, secret-free YAML export, exact managed-connection rotation, and preview-first audit-retention execution exist. Policy gates agents, repositories, assets, backups, and portable bundle export/import. | Complete broader administration UX, scheduled retention supervision/alerting, stable managed-connection keys, and the exhaustive authorization matrix |
| Service-layer authorization across REST, SSE, MCP, assets, previews, and revisions | **Implemented foundation** | Central access resolution is used across core design and enterprise services. Legacy environment MCP tokens are bounded by agent enablement, adapter/scopes, expiry, connection limits, project-restriction policy, and `allowLegacyEnvironmentToken`; trusted-header identities honor exact `identity`, `external_id`, or `trusted_user` role mappings. | Full IDOR matrix for every public route/resource and all role/project/scope combinations; complete real-proxy mapping/bootstrap evidence |
| Content-addressed snapshots and revision hash chains | **Implemented foundation** | Canonical uncompressed bytes are SHA-256 hashed; Brotli snapshots and immutable chain metadata are persisted | Historical upgrade fixtures and complete integrity/audit operator tooling |
| Exact preview and atomic commit | **Implemented foundation** | Persisted base/result hashes, engine versions, preview status, `BEGIN IMMEDIATE` commit, CAS, scoped idempotency, audit/outbox, exact snapshot reference | Full restart/concurrency/fault-injection matrix and engine-mismatch coverage |
| Archive-only destructive path | **Implemented foundation** | Ordinary commit paths reject `archive_nodes`; dedicated archive preview/commit REST and MCP paths exist | Complete approval-annotation and bypass coverage across every client surface |
| Replayable organization-scoped SSE | **Implemented foundation** | Persisted monotonic outbox IDs, `Last-Event-ID` replay, scope filtering, and gap signals exist. Active streams re-resolve authorization before every event and heartbeat, closing after revocation or policy denial. | Load/reconnect testing and operational lag/retention monitoring |
| Raster normalization | **Implemented foundation** | PNG/JPEG/WebP are fully decoded in the pinned Chromium renderer worker; APNG, animated WebP, MPO, malformed bytes, SVG, and MIME mismatches are rejected; JPEG and WebP EXIF orientation is applied; metadata is stripped by a deterministic canvas-to-PNG round trip; byte/pixel/output/IPC limits are versioned and matched between API and worker. Worker-backed decode now covers API upload, backup creation/verification, restore preflight, safety-backup verification, and final cutover; normalized bytes use generated SHA-256 paths with atomic dedup, read verification, and verified legacy-BLOB fallback. Sharp/libvips is absent from source, lockfile, and the rebuilt image. | Add operator-approved legacy quarantine cleanup, a larger malformed-image corpus, upload-storm/queue evidence, and real packaged cross-platform worker proof. |
| Bounded deterministic rendering | **Implemented foundation** | Versioned bounded IPC validates Unix-socket and Windows named-pipe endpoints and lifecycle behavior. Docker runs separate API/renderer services over the Unix socket with a new deterministic context per job, cleanup, queue/resource limits, non-root `pwuser`, read-only root, dropped capabilities, `network_mode: none`, no-new-privileges, fail-closed readiness, and no production fallback. Linux mount-table validation fails startup if `/data`, `/backups`, or descendants are mounted into the renderer; the rebuilt container exposes only `/run/formaspec`. Migration 11 persists API-owned, database-free-worker job state with `queued`/`running`/terminal transitions, owner leases, heartbeats, expired-owner recovery, organization/internal scope separation, bounded hash/version/dimension/warning/error metadata, and permit-guarded exact 30-day retention. | Self-contained native worker packaging, real Windows named-pipe/ACL/runtime proof, continuous infrastructure-egress tests, configurable retention operations/UI, and release load evidence remain. |
| Verified backup/restore primitives | **Partial** | Online SQLite backup, semantic bundle verification, descriptor-pinned verification/download streams, authenticated records/downloads, policy-controlled enablement/schedule/retention, explicit CLI restore, and versioned checkpoints exist. Format-2 bundles generate secret-free policy configuration from the staged database and verify it exactly against that database; historical format-1 bundles remain accepted. Backup creation copies only database-referenced CAS assets, excluding unreferenced filesystem orphans from the bundle while preserving them locally. Launcher-pinned Docker/server restore has a backward-readable format-2 runtime binding, strict Host/schema/readiness/renderer checks, maintenance/worker-lock fencing, whole-workflow plus per-step capacity checks, crash-resumable journal states, operation-aware orphan cleanup, verified safety backup, V1/V2 database/render checks, audit/outbox reconciliation, final post-trigger credential-revocation checks, and safe status/resume/rollback/abort/stale-lock recovery. Runtime binding capture and every verification inspect all three Docker volumes, requiring local driver/scope, no options, bounded absolute mountpoints, and distinct backing identities; plugin, NFS, bind-backed, or aliased volumes fail closed. Health requests have absolute deadlines, unsafe launcher-lock paths fail closed without recursive removal, and pre-cutover resume/rollback worker failures restart and re-verify the unchanged API. The recorded isolated A/B restore/safety-restore exercise covers local Docker. | The Docker/server capability is explicitly `HEALTHY_PLANNED_RESTORE_ONLY`: it requires a healthy current API/database for backup-ID resolution and preflight and is not offline disaster recovery. Server mode still needs a clean proxy/restore/rollback/failure-injection release exercise and installed supervision/alerting. Bundles are unsigned, rename-without-replacement cannot yet use an OS-native no-replace primitive through Node, and off-host policy, broader recovery fixtures, and cross-platform release E2E remain incomplete. |
| Health contract | **Implemented foundation** | `/health/live`, `/health/ready`, and `/health/render` exist; Docker readiness proves migration version, worker mode, Playwright, and software-fallback state | Add deeper storage/outbox capacity indicators, alerting, and long-running failure/recovery evidence |

Phase 1 is not closed because the complete cross-browser interaction matrix,
authorization and security matrix, clean server-mode planned-restore evidence,
offline disaster recovery, broader recovery
matrix, continuous egress testing, and full deployment gates have not all
passed.

## Phase 2 — V2, design system, and product specification

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Strict V2 document model | **Implemented foundation** | Strict V2 schemas include semantic roles, locale/direction, typed token references, component data, mappings, migration diagnostics, and explicit non-rendered quarantine for unsupported V1 asset kinds/MIME types. Canonical V2 heads flow through reads, previews, render/lint, MCP resources, JSON/portable export, restore smoke, and V1-compatible browser projection. | V2-native token authoring, component-to-project synchronization, and advanced editor support remain bounded |
| Deterministic V1-to-V2 migration | **Implemented foundation** | Backup-gated, organization-admin-only, idempotent active-head migration preserves every stable project/page/node/token/asset/prototype ID, keeps historical V1 revisions byte/hash exact, creates one system-authored V2 revision with source revision/snapshot/backup provenance, and quarantines free-form overrides plus legacy GIF/font/video/binary assets without dropping metadata. A 5-test complete V1 compatibility corpus and active-head service fixture pass. | Add larger real-customer fixture archives, signed backup provenance, operator migration UI, and full migration/rollback E2E |
| FormaSpec Foundation System | **Implemented foundation** | Three token layers, light/dark/high-contrast modes, Inter/Vazirmatn, component definitions/states, reusable patterns, a persisted organization design-system service, and typed component-contract authoring in Administration exist | Complete token/release authoring, project upgrade visual comparison, and broader visual parity evidence |
| Component contracts and releases | **Implemented foundation** | Strict types plus append-only token/component versions, immutable exact releases, lifecycle/replacement diagnostics, project pins, expiring upgrade previews, CAS commits, REST/MCP, tests, and an Administration UI for typed drafts plus immutable publish/deprecate transitions. The catalog API returns an explicit component-authoring capability: Organization Administrators and Design Editors can author, while Product Managers, Engineers, and Viewers receive a read-only UI without mutation controls. | Complete editor pinning/upgrade UX, policy-configurable delegated roles, richer documentation/platform mapping authoring, and V2-head synchronization |
| Product specification preview/commit | **Implemented foundation** | Versioned natural-language/structured specification service, exact preview/commit, diagnostics, MCP tools, API, and initial panel exist | Complete structured editor coverage, linked entity workflows, accessibility/rule linkage, and product-manager E2E |
| Persistent 22-section PM interview | **Implemented foundation** | Versioned sessions, answers, transitions, all required section definitions, API/MCP, and initial browser interview exist | Resume/edit/review browser E2E and broader validation/elicitation UX |
| Enterprise editor information architecture | **Partial** | Product brief/activity panel, planning dialog, inspect view, canvas/prototype surfaces, existing layer and inspector tools | Full Pages/Layers/Components/Assets and Design/Content/Component/Logic/Prototype/Accessibility organization |
| Revision-pinned inspect | **Implemented foundation** | `GET /api/projects/:projectId/revisions/:revisionId/inspect` and the browser view distinguish the immutable pinned revision from the current head. They expose integrity hashes, node measurements and resolved token references, assets/hashes, component evidence, revision-linked product rules and acceptance criteria, implementation mappings, stable IDs, and JSON paths. Focused server/web coverage and the current 6/6 browser alignment/inspect run pass. | Add broader accessibility, authorization, large-project, and cross-browser evidence |
| Enterprise lint catalog | **Implemented foundation** | Deterministic V2 lint now reports raw design values, missing interactive states, semantic hierarchy, accessible names, touch targets, missing prototype actions, RTL locale/alignment mismatches, detached/draft/deprecated components, invalid typed properties/slots/states, missing business-rule/acceptance links, and invalid product-spec entity links. Focused tests cover the catalog and all seven RTL/representative visual baselines pass. | Add organization-policy severity tuning, editor filtering/fix actions, broader accessibility automation, and release-scale diagnostic UX evidence |
| Portable import/export and platform token exporters | **Implemented foundation** | Strict checksum-validated `.formaspec.zip` export, read-only validation, and Organization Administrator mutating import exist. `POST /api/imports` requires an idempotency key and supports default `conflict_fail` ID preservation or explicit deterministic `clone` remapping. V1/V2 documents rebase to local revision 1; product specifications persist atomically as local version 1; raster assets are fully decoded and normalized through the isolated worker; legacy assets remain metadata-only quarantine; and migration 10 records immutable source/target provenance plus the canonical ID map and diagnostics. ZIP parsing now validates central/local headers, descriptors, CRCs, flags, versions, regular entry types, duplicates, declared sizes, trailing compressed data, and aggregate limits before bounded 16 KiB per-entry streaming inflation. Administration validates first, then imports and opens the resulting project. Platform token exporters remain bounded. | The multipart request body and extracted entry buffers remain memory-resident within the 256 MiB archive/aggregate, 64 MiB entry, and 20,000-entry caps. Add end-to-end request-body streaming, a larger adversarial corpus, sustained concurrent-import evidence, and packaged cross-platform proof |

## Phase 3 — agents and automatic Codex connection

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| FormaSpec MCP identity and workflow | **Implemented foundation** | Server ID `formaspec`, Minimal UI alias, `formaspec://` resources, preview-inspect-lint-commit instructions, and the 1/1 integrated release scenario are implemented | Full per-tool authorization/schema conformance and broader revocation/reconnection client coverage |
| Design/product-spec/planning/task/connection MCP tools | **Implemented foundation** | Strict tools exist for organization-policy reads, design discovery/mutation/history, product specs, planning sessions, tasks, agent connections, persisted design-system releases/pins/upgrades, path-free repository inventory persistence/reads, handoffs, and Redesign Studio | Complete per-tool authorization matrix and broader agent release E2E remain incomplete |
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
| Platform scanners and implementation mappings | **Partial** | Initial web, Android, iOS/Xcode, Flutter, and React Native detection plus bounded symbol discovery feed stable opaque inventory entity/location IDs accepted by the central service. `generic-git` is now a fallback only when no specific platform is detected. | Add framework-aware semantic scanners, automatic mapping upload/review, incremental rescans, and false-positive controls |
| Approval-gated handoff/implementation | **Implemented foundation** | Revision/inventory-pinned handoffs, strict acceptance criteria/slices, immutable versions/transitions, PM approval, Engineer start/completion, explicit diff/validation/commit/PR gates, REST APIs, MCP reads/draft tools, tests, events, and initial editor UI exist. The local Workspace Bridge now binds each connected grant to the exact persisted inventory ID/hash under a cross-process monotonic lock and exposes an explicit plan/launch command that revalidates grant activity, policy, a bounded all-included-file content fingerprint, bounded/no-follow platform and Git metadata, central inventory status/integrity, and approved/implementing handoff transitions at the process-creation boundary. Codex is spawned with `shell: false`, the selected repository as exact `cwd`, one version/hash-bound secret-free handoff argument, and a minimal case-aware environment allowlist. A deadline-bounded 500 ms monitor terminates the POSIX Codex process group after grant expiry/revocation, policy withdrawal, handoff cancellation/completion, or central inventory revocation/change. | The broader local approved plan/diff/validation/commit/PR execution and packaged/supervised launch workflow remain incomplete; post-launch repository content necessarily diverges while the approved agent edits it, so the ongoing monitor enforces authorization state rather than the original content fingerprint. Packaged Windows process-tree containment still needs Job Object/equivalent evidence. |

## Phase 5 — Redesign Studio

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Seven-stage redesign assessment | **Implemented foundation** | Persisted ordered stages, immutable versions/transitions, CAS checks, REST/MCP, audit/outbox, dashboard launch, and a dedicated browser workspace now cover connect/inspect through separately approved implementation | Populate stage-specific inventories/findings/proposals/design/handoff artifacts and complete the end-to-end redesign program |
| Independent assessment/proposal/design/implementation permissions | **Implemented foundation** | Dedicated role/scope checks independently gate assessment, review, interview, proposal, design, handoff, approval, implementation, and cancellation | Complete role/grant/revocation matrix through REST, MCP, and browser E2E |
| “One click” planning-only behavior | **Implemented foundation** | Dashboard creation records a version-pinned assessment with `sourceMutation: "none"`; service tests prove designs/revisions/mappings remain unchanged | Connect the later reviewed stages to their domain artifacts without introducing an automatic mutation path |

## Phase 6 — enterprise delivery

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Organization administration and policy-as-code | **Implemented foundation** | A strict schema-version-1 policy has REST, MCP tool/resource, Administration JSON editing, optimistic configuration hashes, secret-free YAML export, backup integrity binding, and enforcement across agents, trusted-role mapping, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. Organization-admin audit retention now has exact 15-minute previews, a 30-day minimum, per-kind 2,000-row/8-MiB bounds with conservative and exact byte checks, policy/CAS revalidation, restart-safe idempotency, atomic guarded deletion, SSE replay gaps, permanent governance/recovery evidence, and an immutable SHA-256 run chain exposed through REST and `formaspecctl`. | Complete form-based administration, scheduled retention supervision/alerting, policy rollout/version migration, delegated administration, and the exhaustive HTTP/MCP/browser matrix |
| `formaspecctl` operator coverage | **Partial** | Install, doctor, status, start/stop/restart, migrate status, backup create/list/verify, schedule show/enable/disable/run, preview-first exact prune, source-local restore, launcher-pinned Docker/server planned restore/status/resume/rollback/abort/stale-lock recovery, bounded support-bundle preview/create, generic MCP output, Codex connect, and selected-workspace Codex plan/dry-run/launch exist | Offline disaster recovery, clean server planned-recovery evidence, service-supervisor installation/alerting, full migrate lifecycle, upgrade/uninstall, and packaged cross-platform delivery |
| Native installers and automatic startup | **Partial** | The previous self-contained unsigned macOS ARM64 PKG at `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg` has checkpoint integrity evidence and SHA-256 `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`, but it is stale relative to schema 11. Source-level deterministic unsigned Linux DEB/RPM builders include pinned runtimes, hardened systemd API/renderer units, data-preserving lifecycle scripts, and strict protocol registration. A native-Windows-only WiX v4 unsigned-MSI builder validates a caller-supplied real service host and exact provenance. No current Linux or Windows artifact/lifecycle evidence exists. | Resolve Chromium LGPL/legal policy, macOS Developer ID signature and notarization, independent reproducibility, and vulnerability/license scanning. Build and test real Linux artifacts/lifecycles. On Windows, supply and qualify the native service host, ACLs, SCM lifecycle, Job Object/equivalent containment, named-pipe Chromium runtime, protocol registration, signing, and clean lifecycle evidence. Rebuild the macOS candidate from the stabilized schema-11 tree. |
| Hardened Docker topology | **Implemented foundation** | One image runs separate API and renderer services with Unix-socket IPC, non-root worker, read-only roots, dropped capabilities, no-new-privileges, renderer network denial, tmpfs, resource limits, persistent `/data` and `/backups`, readiness, init, verified fresh startup/restart persistence, a host-supervised pinned server restore path, and an isolated launcher-local restore/safety-restore exercise | Add server-mode reverse-proxy/restore release evidence, broader backup-volume fixtures, automated egress/load/failure tests, image scanning, alerting, and stricter API networking where deployable |
| Release CI and evidence | **Partial** | Recorded gates include core 40/40, server 235/235, web 30/30, CLI 52/52 before the newest restore regressions, Workspace Bridge 23/23, installer 41/41 through Linux packaging, launcher 165/165, 6/6 alignment/auto-layout/inspect, 7/7 visual baselines, the 1/1 20-step release E2E, and the 1/1 1,000-node browser budget. The earlier schema-10 source-workspace SBOM/license evidence reports 342 third-party components with zero violations; the old macOS PKG evidence is not current-tree evidence. | Run the consolidated current-tree package/typecheck/build/launcher/Compose gates, fresh schema-11 Docker smoke, and new source evidence. Keep release closed on Chromium LGPL/legal policy, signing/notarization, independent reproducibility, vulnerability/license scanning, platform artifact/lifecycle proof, complete security/deployment suites, provenance, and retained evidence. |
| Signing/notarization/OAuth/GPG | **Blocked externally** | No credentials are fabricated | Produce reproducible unsigned artifacts and exact operator instructions until real credentials are supplied |

## Release-blocking gaps

Production readiness remains **NO-GO** until all of the following are resolved
and evidenced:

- Real packaged Windows named-pipe/ACL/runtime/process-tree proof and continuous
  infrastructure-egress/failure/load evidence beyond the
  endpoint/lifecycle tests and verified Docker `network_mode: none` topology.
- Clean server-mode reverse-proxy startup, restore, upgrade, and long-duration
  evidence beyond the verified fresh local two-service startup/restart test.
- Complete browser and visual-regression proof beyond the passing integrated
  20-step local scenario, Chrome alignment, and seven-scene DPR 1 foundations,
  including fractional group selection, the full invalidation/auto-layout
  matrix, cross-platform RTL parity, prototype navigation, and pinned release
  CI images with retained traces/reports.
- Complete role/scope/project/expiry/revocation, CSRF, Host/Origin, archive,
  asset, traversal, decompression, secret-exclusion, and prompt-injection-data
  security suites.
- Reduce portable-import peak memory beyond the implemented bounded per-entry
  streaming inflater: multipart bodies and extracted entries remain buffered
  within the configured caps. Retain larger adversarial, concurrent-import, and
  packaged cross-platform evidence.
- Clean server-mode `HEALTHY_PLANNED_RESTORE_ONLY` evidence, a separately
  authorized offline disaster-recovery path, off-host policy, packaged
  supervision/alerting, and long-running retention/prune failure-recovery
  evidence beyond the launcher-local foundation and tested 7/4/12 schedule.
- Broader disposable recovery evidence covering the verified schema-7
  checkpoint, normalized and legacy assets, design-system data, failure
  injection, reconnect/revocation, and historical customer fixtures. Current
  evidence includes the copied version-7-to-8 fixture, installed-volume
  upgrade, verified pre/post bundles, one isolated local-Docker A/B recovery
  exercise, and the passing source-local 20-step V1/V2/product-spec/task/hash/
  render scenario.
- An approved signing/provenance design. Source identity is now pinned across
  verification and cutover, but current checksums still prove consistency, not
  who created a bundle.
- Complete component/release authoring and project upgrade-review UI plus the
  V2 head-migration operator path.
- Framework-aware reviewed mapping upload remains incomplete. Connected
  Workspace Bridge grants now persist and bind their bounded path-free
  inventory through REST or the authorized local MCP bridge, and the explicit
  selected-workspace Codex boundary revalidates that binding plus handoff
  approval before a local no-shell launch. No central repository mutation or
  arbitrary-path capability was added.
- Complete stage-specific Redesign Studio artifacts and the full independent
  permission/E2E matrix; the seven-stage state machine and browser foundation
  now exist.
- A release-ready native installer set. The exact unsigned macOS ARM64 PKG
  candidate and its offline integrity/SBOM evidence belong to the earlier
  schema-10 checkpoint, not the current tree. Its artifact gate remains
  closed on exactly five recorded blockers: the Chromium LGPL-notice allowlist
  decision, signing, notarization, independent reproducibility, and
  vulnerability scanning. Clean lifecycle proof is additional enterprise
  delivery evidence. Linux DEB/RPM and Windows WiX source builders exist, but
  real Linux artifacts/lifecycles and a qualified Windows service host,
  DPAPI/ACL/SCM/process-tree/runtime/protocol/signing lifecycle remain unproven.
- Artifact-specific container, Windows, and Linux SBOMs; dependency/image/OS
  scans; reproducibility; signing/provenance; retained CI evidence; and final
  release artifacts remain missing even though the Sharp-free source-workspace
  permissive gate and the exact unsigned macOS PKG integrity verification pass.

## Current operator conclusion

FormaSpec now has substantial enterprise-oriented foundations and a usable
source development path, including automatic Codex/Minimal UI connection.
Those foundations are suitable for continued local evaluation and incremental
development. They are not sufficient evidence for an enterprise production
deployment, migration, or signed native release.

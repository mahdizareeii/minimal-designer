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

Current-source verification checkpoint on 2026-07-21 (the working tree remains
an unsigned, uncommitted enterprise-upgrade tree; the schema-12 macOS artifact
is an engineering checkpoint rather than a release candidate):

| Check | Recorded result |
| --- | --- |
| Focused package gates | Core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, and installer 62/62 across 5 files passed. The launcher passed 212/212. The current suites include exact nested success DTOs and strict bounded inputs across all 51 MCP tools and 25 resources, exact 106-route public-surface closure, generated authentication rejection across the full route set, and direct behavioral authorization on all 106 protected routes with zero uncovered. They also cover true HTTP SSE grant/revocation behavior, exact revision/inventory-pinned implementation mappings, all seven handoff execution decisions, Redesign authorization/future-state evidence gating, exact implementation-authorized Codex launch, automatic stale managed-grant rotation, duplicate effective trusted-identity rejection, strict native runtime/data/backup/log/support path resolution, design-system pin/head/backup/import/restore integrity, genuine historical migration fixtures, project-scoped authorization, enterprise editor/administration behavior, framework-aware scanner hardening, Chromium/Unix-socket rendering, portable streaming, offline recovery, bounded processes, and proxy-hop-secret coverage. Review fixes add project/revision-bound historical-release reads, bind release access to allowed current project pins, and apply `task_list` project/status SQL filters before `LIMIT`. Linux and Windows packaging tests remain fixture/source-builder evidence rather than real platform lifecycle proof. |
| Exhaustive SSE event authorization | The 18-event runtime policy is exhaustive and maps every event family to one required agent read scope, permitted human roles, and a project/organization/optional/control boundary. Seven focused tests pass across the policy and real HTTP streaming suites. A `design:read`-only agent cannot observe task, handoff, Redesign, connection, backup, audit-retention, or other administration events; `task:read` can open a useful task stream without `design:read`; connection, backup, and audit-retention families are Organization-Administrator-only for humans and unavailable to agents. Replay rows are filtered in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery applies the same policy. Scope-policy removal or connection revocation closes an existing stream. |
| Historical migration fixtures | Deterministic source-built schema 1 and schema 7–11 SQLite fixtures now apply the genuine migration prefix to a fresh database instead of deleting current tables. Reviewed schema/data digests lock two V1 revisions, legacy asset bytes, organization ownership, linked product specification, design-system/release pin, repository inventory, implementation mapping, handoff, and schema-11 render-job evidence. Focused migration and verified-backup restore tests pass through schema 12 without fabricating handoff execution decisions. |
| Typecheck | All seven workspace packages passed: core, server, web, CLI, local bridge, Workspace Bridge, and installer |
| Production build | All seven workspace packages passed: core, server, web, CLI, local bridge, Workspace Bridge, and installer |
| Launcher suite | 212/212 passed after proxy-secret lifecycle hardening |
| Enterprise editor and administration browser coverage | Playwright Chromium passed 3/3: the accessible Pages/Layers/Components/Assets, Canvas/Prototype/Before-After, six-section inspector, keyboard/focus, and activity/diagnostic/revision/handoff contract; real click-to-frame prototype navigation with an exact no-document-mutation assertion; and the guided 12-section organization-policy form with Expert JSON, secret-free YAML export, and optimistic configuration-hash updates. |
| Browser selection alignment and revision inspect | Fresh Playwright Chrome selection alignment passed 12/12 across DPR 1/2; 12/25/50/100/149/150/200/320% zoom; positive and negative fractional pan; LTR, RTL, and mixed text; a normalized uploaded image and nested rotated RTL node; selectable frame and ellipse geometry; rotated multi-selection; hidden/locked exclusion; exact fractional multi-selection/group drag; nested scroll plus explicit and real delayed-font/image invalidation; vertical, wrapped, and grid auto-layout reorder/reparent; and fill-to-fixed resize, all within 0.75 CSS px. Revision-inspect immutability independently passed 1/1: the pinned revision stayed exact after the head changed and exposed its engineering evidence. |
| Visual regression foundation | Playwright Chrome DPR 1 passed 7/7 approved native-size prototype baselines: desktop, phone, tablet, Persian RTL, typography, clipping, and normalized uploaded image |
| 1,000-node foundation | Deterministic service benchmark passed at 20.43 ms p95 validation, 49.65 ms p95 apply, 134.43 ms p95 preview persistence, and 116.83 ms p95 render. This remains a coarse service/core gate rather than browser-interaction evidence. |
| 1,000-node browser budgets | Pinned Playwright Chromium passed the fresh 20-sample gate: 225.90 ms p95 cold interactive load, 21.10 ms p95 selection, 16.70 ms cadence-normalized gesture p95 with a 16.70 ms maximum, 255.00 ms p95 commit/autosave, 16.10 ms p95 history, 205.02 ms p95 preview validation excluding render, and 217.78 ms p95 for a 1440×900 Chromium PNG with no fallback or warnings. |
| Integrated PM-to-restore E2E | The isolated Playwright release project passed 1/1, covering all 20 browser/MCP/persistence steps with the migration assertions corrected to schema 12: dashboard creation, backup-gated V1→V2 migration, product specification, all 22 interview sections, scoped agent pairing/task claim, multi-screen preview/lint/render/commit, human correction, selection refinement, immutable history restore, JSON/portable export, verified backup, stopped-database restore, restart, exact hash/state recovery, and PNG smoke. |
| Compose/runtime | `docker compose config --quiet` passed. Fresh exact-current project `formaspeccischema118e2818fed6`, built from source identity `local-uncommitted-final437-eventauth-sqlbounded-cli`, reached migration 12 readiness with the external Playwright worker, backup-supervision health, and no software fallback. It created design `document_0e6b4b61e3964110b9a4533ef2a63398` at revision `revision_aea2807b70cb4c8c9b6588c191de0218`, rendered a 512×339 PNG with SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`, restarted only the API, recovered the same design/version, and produced the exact same PNG hash. API and renderer used identical image `sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`; both ran as non-root `pwuser` with read-only roots, `cap_drop: ALL`, no-new-privileges, PID/resource bounds, and renderer `network_mode: none` with only `/run/formaspec` mounted. The renderer-egress canary failed closed with DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and zero external interfaces. Independent cleanup found no remaining disposable containers, volumes, or networks. The exact-current summary is `/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json` (SHA-256 `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`); it remains local `NO-GO` evidence, not retained CI or provenance. |
| Codex connection | `./designer --yes start docker --no-build --no-open` refreshed the mode-`0600` runtime binding, started the loopback bridge, verified MCP `formaspec`, installed the managed Minimal UI skill/plugin, and exposed `[@Minimal UI](plugin://minimal-ui@formaspec)`. The generated Codex configuration remains token-free and uses write approval mode. Automatic authorization intersects scopes with organization policy, clamps creation expiry, supplies project restrictions when required, and now reuses an existing stored grant only when its bearer-only authorization context has exact least-privilege scope/project set equality; stale or overbroad grants rotate through one-time pairing. |
| Source/release hygiene | Current source evidence passes with 342 third-party components and zero policy violations. Five repository-native least-privilege workflows are present; the source workflow has a retained-JSON fail-closed high-severity dependency advisory gate, the browser workflow has a pinned Firefox/WebKit alignment job, the Docker workflow runs an in-container DNS/direct-TCP/non-loopback renderer-egress canary before Firefox/WebKit plus copied-bundle recovery against the exact image it just built, and the main/manual macOS workflow builds and privately exercises extracted package bytes without installing them. Workflow contract tests pass 8/8, cross-browser runner tests pass 2/2, off-host simulation tests pass 7/7, release-evidence tests pass 8/8, macOS package-evidence tests pass 12/12, and macOS runtime-smoke tests pass 10/10. The exact-current image passed Firefox/WebKit 12/12 once with summary SHA-256 `2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`. The immediately prior fit-sync image remains valid historical stability evidence: it passed three consecutive identical 12/12 runs after synchronous `useLayoutEffect` fitting, and its main, `-repeat2`, and `-repeat3` summaries all hash to `0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`. The exact-current image passed copied-bundle recovery with summary SHA-256 `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`. No GitHub-hosted cross-browser/recovery/dependency-audit/native-package run and no real Ubuntu artifact has been retained. The retained pre-current-SSE-authorization schema-12 macOS candidate under `artifacts/candidates/schema12-current/` passed its original package-integrity and private extracted-runtime checks and was not installed; the current verifier records expected source drift. Its same-host repeat produced identical payload/workspace trees but different outer PKG bytes, so reproducibility remains failed. The preserved schema-11 and schema-10 candidates are historical. Signing, notarization, independent reproducibility, artifact/image/OS vulnerability scanning, Chromium/license-policy approval, and clean native lifecycle evidence remain open. |

The schema-12 macOS PKG under `artifacts/candidates/schema12-current/` is a
retained pre-current-SSE-authorization unsigned checkpoint, not a current-source
artifact. Its original package-integrity, runtime-smoke, checksum, and
reproducibility evidence remains valid for those frozen bytes. The current
verifier now records expected source drift: packaged `apps/server/dist`
predates the exhaustive event-authorization policy and the project/revision-
bound historical design-system release interface. A new package from the
current source has not been built or installed.

The integrated local browser scenario and 1,000-node Chromium performance gate
pass on the current tree. There is still no comprehensive cross-platform editor/visual matrix,
security matrix, native-installer matrix, retained GitHub-hosted release
evidence, or complete server-mode planned/offline backup-restore/deployment
suite.

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

The migrations preserve the legacy V1 columns while adding content-addressed
snapshots, integrity metadata, organization/agent workflow tables, preview
retention, scoped outbox state, backup metadata, schedules, operational locks,
design systems, repository inventories, implementation mappings, handoffs, and
Redesign Studio assessment history, bounded audit/outbox retention evidence,
immutable portable-import provenance, and bounded persistent render-job
lifecycle metadata. Migration 12 adds independently authorized, append-only
handoff execution decisions and their lifecycle/CAS integrity triggers.

`apps/cli/src/migrations.ts` recognizes the same version-12 ledger as the server.
A ledger prefix alone is not accepted as proof of migration completion: startup,
backup verification, restore preflight, and restore control validate the
required migration-9/10/11/12 tables, columns, indexes, triggers, normalized
schema SQL, and
forbidden legacy triggers and fail closed on schema-shape drift.
The checked-in historical fixture builder now proves genuine baseline V1 and
schema 7–11 prefixes preserve stable project/page/frame/node/asset/revision IDs,
canonical document and operation bytes, snapshots, revision hash chains,
organization ownership, linked enterprise rows, and schema-11 render jobs while
migrating to schema 12. It also proves migration 12 creates the decision table
and triggers with zero fabricated decisions, and that malformed V1 revision
bytes fail atomically before migration 2 is recorded. These deterministic
fixtures close the synthetic drop-table gap. A same-machine copied-bundle
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
| Service-layer authorization across REST, SSE, MCP, assets, previews, and revisions | **Implemented foundation** | Central access resolution is used across core design and enterprise services. The executable MCP matrix inventories all 51 tools and 25 resources, enforces annotation consistency, strict bounded/discriminated inputs, exact correlated success DTOs, strict `ok:false` errors, and all static agent-scope/scoped-resource gates. A separate declarative manifest closes the registered protected non-MCP surface at exactly 106 routes: 52 project, 48 organization, and six explicit exceptions across six families. Generated server-mode probes reject missing/malformed identities before parsing/mutation on all 106 routes, reject unmapped/disabled identities on all 105 non-pairing routes, and prove one-time nonce replay rejection. Direct behavioral suites now cover all 106 routes with zero uncovered. They prove role denials, foreign/swapped IDs, scoped agents, revocation/expiry, marker/path/token non-leakage, rejected-state preservation, authorization-before-query/path/body validation, preview/task ownership, stream registration/revocation, renderer and multipart/storage boundaries, and project-bound opaque resources. Fixes include authorization-before-expiry/lifecycle/schema validation, exact principal/design/revision idempotency cleanup, denied-plan enforcement, project/revision-bound historical release access, and `task_list` project/status SQL filters before `LIMIT`. | Add real-proxy mapping/bootstrap evidence and broaden long-running/load and full human-role/project-parent cross-products |
| Content-addressed snapshots and revision hash chains | **Implemented foundation** | Canonical uncompressed bytes are SHA-256 hashed; Brotli snapshots and immutable chain metadata are persisted | Historical upgrade fixtures and complete integrity/audit operator tooling |
| Exact preview and atomic commit | **Implemented foundation** | Persisted base/result hashes, engine versions, preview status, `BEGIN IMMEDIATE` commit, CAS, scoped idempotency, audit/outbox, exact snapshot reference | Full restart/concurrency/fault-injection matrix and engine-mismatch coverage |
| Archive-only destructive path | **Implemented foundation** | Ordinary commit paths reject `archive_nodes`; dedicated archive preview/commit REST and MCP paths exist | Complete approval-annotation and bypass coverage across every client surface |
| Replayable organization-scoped SSE | **Implemented foundation** | Persisted monotonic outbox IDs, `Last-Event-ID` replay, scope filtering, and gap signals exist. `/events` and `/api/events` resolve bearer tokens to scoped, revocable grant actors while preserving bearer-less browser EventSource behavior. An exhaustive 18-event policy assigns each family an agent read scope, human-role allowlist, and project/organization/optional/control boundary. Replay applies that policy in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery uses the same predicate. Seven focused tests prove live/replay parity, task-only access without `design:read`, denial of task/handoff/Redesign/admin events to design-only agents, Organization-Administrator-only connection/backup/audit events, project and organization isolation, policy-removal closure, immediate revocation, marker non-leakage, and rejected reconnect. | Add long-running reconnect/load/backpressure testing, server-mode proxy streaming evidence, operational lag/retention monitoring, and broader retained role/scope stress evidence |
| Raster normalization | **Implemented foundation** | PNG/JPEG/WebP are fully decoded in the pinned Chromium renderer worker; APNG, animated WebP, MPO, malformed bytes, SVG, and MIME mismatches are rejected; JPEG and WebP EXIF orientation is applied; metadata is stripped by a deterministic canvas-to-PNG round trip; byte/pixel/output/IPC limits are versioned and matched between API and worker. Worker-backed decode now covers API upload, backup creation/verification, restore preflight, safety-backup verification, and final cutover; normalized bytes use generated SHA-256 paths with atomic dedup, read verification, and verified legacy-BLOB fallback. Sharp/libvips is absent from source, lockfile, and the rebuilt image. | Add operator-approved legacy quarantine cleanup, a larger malformed-image corpus, upload-storm/queue evidence, and real packaged cross-platform worker proof. |
| Bounded deterministic rendering | **Implemented foundation** | Versioned bounded IPC validates Unix-socket and Windows named-pipe endpoints and lifecycle behavior. Docker runs separate API/renderer services over the Unix socket with a new deterministic context per job, cleanup, queue/resource limits, non-root `pwuser`, read-only root, dropped capabilities, `network_mode: none`, no-new-privileges, fail-closed readiness, and no production fallback. Linux mount-table validation fails startup if `/data`, `/backups`, or descendants are mounted into the renderer; the container exposes only `/run/formaspec`. The exact-current image's egress canary failed closed with DNS `EAI_AGAIN`, direct TCP `ENETUNREACH`, and zero external interfaces; 8/8 workflow-contract tests prevent silent removal. Migration 11 persists API-owned, database-free-worker job state with `queued`/`running`/terminal transitions, owner leases, heartbeats, expired-owner recovery, organization/internal scope separation, bounded hash/version/dimension/warning/error metadata, and permit-guarded exact 30-day retention. | Self-contained native worker packaging, real Windows named-pipe/ACL/runtime proof, retained hosted infrastructure-egress runs, configurable retention operations/UI, and release load evidence remain. |
| Verified backup/restore primitives | **Partial** | Online SQLite backup, semantic bundle verification, descriptor-pinned verification/download streams, authenticated records/downloads, policy-controlled enablement/schedule/retention, durable scheduled-run start/success/failure audit/outbox evidence, overdue/retention-backlog diagnostics, critical failed/stalled-attempt reporting even when the current window already has a valid backup, explicit CLI restore, and versioned checkpoints exist. Format-2 bundles generate secret-free policy configuration from the staged database and verify it exactly against that database; historical format-1 bundles remain accepted. Backup creation copies only database-referenced CAS assets, excluding unreferenced filesystem orphans from the bundle while preserving them locally. Launcher-pinned Docker/server restore has a backward-readable format-2 runtime binding, strict Host/schema/readiness/renderer checks, maintenance/worker-lock fencing, whole-workflow plus per-step capacity checks, crash-resumable journal states, operation-aware orphan cleanup, V1/V2 database/render checks, audit/outbox reconciliation, final post-trigger credential-revocation checks, and safe status/resume/rollback/abort/stale-lock recovery. Managed-ID restore uses a verified managed safety backup and remains `HEALTHY_PLANNED_RESTORE_ONLY`. The separately authorized offline path verifies the operator-selected bundle before mutation, pins the exact regular file by device/inode/hash/size, checks receive capacity before stdin, transfers only stdin into the isolated worker, performs full target/raster verification and a whole-workflow capacity forecast, applies bounded tree/pre-copy capacity checks, captures a verified exact forensic pre-state bundle even for corrupt SQLite, then uses the standard cutover, schema/render verification, audit/outbox reconciliation, revocation, and readiness gate. Spawned child stdout/stderr shares one combined 4 MiB budget by default; focused process-runner coverage passes 5/5 and proves the 5-second SIGKILL fallback for a SIGTERM-resistant over-budget child. Offline resume accepts `--offline-bundle`; forensic rollback restores old bytes while keeping maintenance active and the API stopped (`maintenanceCleared: false`, `serviceReady: false`). Restore control rejects direct clearing, and only a newly verified offline restore may atomically take over that fence. Offline failures never auto-abort/restart; takeover retains the predecessor until replacement preparation is durable, while resumed `offlinePrepare` and the replacement worker use the current maintenance owner rather than the predecessor ID. Pristine/prepared abort normalizes corrupt/non-SQLite open/query failures to `VALIDATION_FAILED` instead of unfencing them. Runtime binding capture and every verification inspect all three Docker volumes, requiring local driver/scope, no options, bounded absolute mountpoints, and distinct backing identities; plugin, NFS, bind-backed, or aliased volumes fail closed. Health requests have absolute deadlines, unsafe launcher-lock paths fail closed without recursive removal, and planned pre-cutover resume/rollback worker failures restart and re-verify the unchanged API. The recorded isolated A/B exercise covers planned local Docker. A separate unique-Compose production worker/control smoke restored a real schema-11 design/PNG from corrupt live bytes, revoked a grant/connection/nonce, restored the exact corrupt bytes, persisted `rolled_back`/`recovery=offline`, and cleaned up without touching the live project. A subsequent real unique-project `formaspecctl` smoke validates the persisted Compose identity through the full CLI path. The exact-current runtime image passed a fail-closed same-machine copied-bundle simulation from source `formaspecdrsourcede20d670cd` to clean target `formaspecdrtargetde20d670cd`, preserving design `document_9989d40c2c194b5dafb7f7da08bfc4b9` at revision `revision_3b6cbf1a84f5421b9f57c370d4541db2` with exact snapshot/revision/asset/render equality. Bundle SHA-256 was `f12887796030081d495ef3b266abf7b22f58cdb01fbe494072171e57ce73bfcc`; SQLite integrity/foreign-key checks, non-root image/runtime proof, local-Docker-context verification, and complete container/volume/network cleanup passed. Its exact-current `NO-GO` evidence is `/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json` (SHA-256 `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`). | Server mode still needs clean real-proxy planned/offline restore, rollback, corruption, and failure-injection lifecycle evidence plus installed external scheduling and alert delivery. Packaged native runtime, real remote-host/off-site storage and transfer policy, broader recovery fixtures, cross-platform disaster-recovery drills, signed provenance, and an OS-native no-replace cutover primitive remain incomplete. |
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
| Component contracts and releases | **Implemented foundation** | Strict types plus append-only token/component versions, immutable exact releases, lifecycle/replacement diagnostics, project pins, expiring upgrade previews, CAS commits, REST/MCP, exact project/revision-bound historical release reads, tests, and an Administration UI for typed drafts plus immutable publish/deprecate transitions. The catalog API returns an explicit component-authoring capability: Organization Administrators and Design Editors can author, while Product Managers, Engineers, and Viewers receive a read-only UI without mutation controls. | Complete release-authoring ergonomics, policy-configurable delegated roles, richer documentation/platform mapping authoring, and broader project-upgrade comparison evidence |
| Project design-system pinning and V2 head synchronization | **Implemented foundation** | The editor exposes project pin/release controls that clear stale cross-project state and disable while loading or mutating. Assigning or upgrading a real pin creates exactly one atomic V2 revision synchronized with the pin row; V1 heads remain unchanged, migration preserves existing V1 pins, and rollback covers the pin, revision, snapshot, audit, outbox, and preview. | Add richer visual upgrade comparison, bulk/project-governance workflows, and broader browser/authorization coverage |
| Product specification preview/commit | **Implemented foundation** | Versioned natural-language/structured specification service, exact preview/commit, diagnostics, MCP tools, API, and initial panel exist | Complete structured editor coverage, linked entity workflows, accessibility/rule linkage, and product-manager E2E |
| Persistent 22-section PM interview | **Implemented foundation** | Versioned sessions, answers, transitions, all required section definitions, API/MCP, and initial browser interview exist | Resume/edit/review browser E2E and broader validation/elicitation UX |
| Enterprise editor information architecture | **Implemented foundation** | The editor now provides Pages/Layers/Components/Assets navigation; Canvas/Prototype/Before-After workspaces; Design/Content/Component/Logic/Prototype/Accessibility inspector tabs; and a collapsible activity/diagnostics/revision/handoff area. Before-After selects the workspace automatically, supports minimize/reopen, archive comparison, focus transfer/trapping, inert background, and Escape. Components/assets navigate to the owning page before selection. The editor/prototype browser gate passes 2/2, including click-to-frame navigation without canonical mutation. | Broaden cross-browser, screen-reader, large-project, and end-to-end editing coverage |
| Revision-pinned inspect | **Implemented foundation** | `GET /api/projects/:projectId/revisions/:revisionId/inspect` and the browser view distinguish the immutable pinned revision from the current head. They expose integrity hashes, node measurements and resolved token references, assets/hashes, component evidence, revision-linked product rules and acceptance criteria, implementation mappings, stable IDs, and JSON paths. Focused server/web coverage plus the fresh 1/1 revision-inspect immutability E2E pass independently of the 12/12 selection-alignment gate. | Add broader accessibility, authorization, large-project, and cross-browser evidence |
| Enterprise lint catalog | **Implemented foundation** | Deterministic V2 lint now reports raw design values, missing interactive states, semantic hierarchy, accessible names, touch targets, missing prototype actions, RTL locale/alignment mismatches, detached/draft/deprecated components, invalid typed properties/slots/states, missing business-rule/acceptance links, and invalid product-spec entity links. Focused tests cover the catalog and all seven RTL/representative visual baselines pass. | Add organization-policy severity tuning, editor filtering/fix actions, broader accessibility automation, and release-scale diagnostic UX evidence |
| Portable import/export and platform token exporters | **Implemented foundation** | Strict checksum-validated `.formaspec.zip` export, read-only validation, and Organization Administrator mutating import exist. `POST /api/imports` requires an idempotency key and supports default `conflict_fail` ID preservation or explicit deterministic `clone` remapping. V1/V2 documents rebase to local revision 1; product specifications persist atomically as local version 1; Foundation-backed V2 documents may retain the implicit bundled default; and custom V2 pins must resolve to a published local-organization release and are inserted atomically with the project. Arbitrary external system/release IDs are rejected. Raster assets are fully decoded and normalized through the isolated worker; legacy assets remain metadata-only quarantine; and migration 10 records immutable source/target provenance plus the canonical ID map and diagnostics. Multipart upload bytes stream into a private mode-`0700` directory and mode-`0600` archive while size/SHA-256 are computed. Bounded file reads validate central/local headers, descriptors, CRCs, flags, versions, regular entry types, duplicates, declared sizes, trailing data, and aggregate limits; entries inflate one at a time in 16 KiB chunks into private files with pinned size/hash metadata. Administration validates first, then imports and opens the resulting project. Platform token exporters remain bounded. | Individual JSON/raster entries are still read under the 64 MiB per-entry cap when parsed or normalized. Add a larger adversarial corpus, sustained concurrent-import/resource evidence, and packaged cross-platform proof. |

## Phase 3 — agents and automatic Codex connection

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| FormaSpec MCP identity and workflow | **Implemented foundation** | Server ID `formaspec`, Minimal UI alias, `formaspec://` resources, preview-inspect-lint-commit instructions, strict 51-tool input/output contracts with exact nested success DTOs, bounded checksummed `handoff_list` keyset pagination, and the 1/1 integrated release scenario are implemented | Broaden revocation/reconnection client coverage and add large-history cursor-rotation/load evidence |
| Design/product-spec/planning/task/connection MCP tools | **Implemented foundation** | Strict tools exist for organization-policy reads, design discovery/mutation/history, product specs, planning sessions, tasks, agent connections, persisted design-system releases/pins/upgrades and project/revision-bound historical release reads, path-free repository inventory persistence/reads, handoffs, and Redesign Studio. Inputs use strict bounded/discriminated schemas; every success family has an exact DTO with ID/hash/version/state correlation; bounded generic JSON remains only inside structured `error.details`. The protected public authorization matrix is complete at 106/106. | Additional agent release E2E, hosted evidence, and broader long-running/revocation/load coverage remain incomplete |
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
| Organization administration and policy-as-code | **Implemented foundation** | A strict schema-version-1 policy has REST, MCP tool/resource, a guided 12-section Administration form, Expert JSON, optimistic configuration hashes, secret-free YAML export, backup integrity binding, and enforcement across agents, trusted-role mapping, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. Organization-admin audit retention has exact 15-minute previews, a 30-day minimum, per-kind 2,000-row/8-MiB bounds with conservative and exact byte checks, policy/CAS revalidation, restart-safe idempotency, atomic guarded deletion, SSE replay gaps, permanent governance/recovery evidence, and an immutable SHA-256 run chain exposed through REST and `formaspecctl`. Browser coverage for editor/prototype/administration passes 3/3. | Install external schedule invocation and alert delivery, complete policy rollout/version migration, delegated administration, and broader organization-lifecycle browser coverage |
| `formaspecctl` operator coverage | **Partial** | Install, doctor, status, start/stop/restart, migrate status, backup create/list/verify, schedule show/enable/disable/run with bounded warnings and critical alerts, preview-first exact prune, source-local restore, launcher-pinned Docker/server planned restore, explicit `backup restore offline <bundle> --yes`, `resume --offline-bundle`, status/resume/rollback/abort/stale-lock recovery, bounded support-bundle preview/create, generic MCP output, Codex connect, and selected-workspace Codex plan/dry-run/launch exist. When managed backup-ID preflight cannot open the current API/database, the CLI now directs the operator to the separately authorized offline command instead of incorrectly describing offline recovery as unimplemented. | Real server planned/offline recovery evidence, external scheduler/service-supervisor installation and alert delivery, full migrate lifecycle, upgrade/uninstall, and packaged cross-platform delivery |
| Native installers and automatic startup | **Partial** | The retained pre-current-SSE-authorization unsigned schema-12 macOS ARM64 PKG under `artifacts/candidates/schema12-current/` is a non-installed engineering checkpoint: SHA-256 `9724f2874c520b5b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`, 185,279,180 bytes. Its frozen source evidence passes with 342 components and zero violations; package integrity passes with 349 components, seven exact workspace trees, two bundled runtimes, payload-tree SHA-256 `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`, and workspace-tree SHA-256 `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`. A non-installing private expansion verified bundled Node v24.14.0, Chromium headless shell revision 1228, schema-12 health, real PNG rendering, exact MCP inventory, native state paths, cleanup, and unchanged install targets/receipts; summary SHA-256 is `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`. The candidate-root `SHA256SUMS` manifest verifies all 14 retained package, sidecar, source, runtime, reproducibility, and documentation entries. Same-host reproducibility failed: a repeat PKG had SHA-256 `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0` and size 185,279,075 bytes even though payload/workspace trees were identical; diagnostic summary SHA-256 is `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`. The preserved schema-11 and schema-10 candidates are historical. Source-level deterministic unsigned Linux DEB/RPM builders include pinned runtimes, hardened systemd API/renderer units, data-preserving lifecycle scripts, and strict protocol registration. A native-Windows-only WiX v4 unsigned-MSI builder checks internally consistent caller-supplied inputs, uses one cross-architecture UpgradeCode, a private verified payload snapshot, minimal WiX environment, and command deadlines. Tests use fake PE/CFB/WiX fixtures and do not establish a trust anchor, real WiX compile, or MSI validity. | Resolve Chromium/license-policy review, Developer ID signature, notarization, independent reproducibility, vulnerability scanning, and clean install/autostart/protocol/upgrade/uninstall/reinstall proof for a frozen final macOS source. Build/test real Linux artifacts/lifecycles. On Windows, fix LocalSystem/isolation, trust-anchor provenance, and validate extracted MSI output; supply and qualify the native service host, ACLs, SCM lifecycle, Job Object/equivalent containment, named-pipe Chromium runtime, protocol registration, signing, and clean lifecycle evidence. |
| Hardened Docker topology | **Implemented foundation** | One image runs separate API and renderer services with Unix-socket IPC, non-root worker, read-only roots, dropped capabilities, no-new-privileges, renderer network denial, a passing exact-current DNS/direct-TCP/non-loopback egress canary, tmpfs, resource limits, persistent `/data` and `/backups`, readiness, init, verified fresh startup/restart persistence, a host-supervised pinned `HEALTHY_PLANNED_RESTORE_ONLY` path, an explicit offline stdin-transfer/forensic-pre-state recovery path, and an isolated launcher-local planned restore/safety-restore exercise. | Add real server-mode reverse-proxy planned/offline restore release evidence, broader backup-volume fixtures, retained hosted/native egress/load/failure tests, image scanning, alerting, and stricter API networking where deployable. |
| Release CI and evidence | **Partial** | Current checkpoints include core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, installer 62/62 across 5 files, launcher 212/212, all seven typechecks/builds, editor/prototype/administration behavior 3/3, direct public authorization 106/106 with zero uncovered, Chrome selection alignment 12/12, exact-current Firefox/WebKit alignment 12/12 once plus three identical historical immediately prior fit-sync repeats, revision inspect 1/1, handoff execution 1/1, visual baselines 7/7, the migration-12-corrected 20-step release E2E 1/1, the 1,000-node browser budget 1/1, renderer-egress canary 1/1, and exact-current same-host copied-bundle recovery 1/1. Five repository-native workflows are covered by 8/8 workflow-contract tests; cross-browser runner tests pass 2/2, off-host simulation tests pass 7/7, release-evidence tests pass 8/8, macOS package-evidence tests pass 12/12, and macOS runtime-smoke tests pass 10/10. The exact-current local image and current 342-component zero-violation source evidence pass. The retained schema-12 package's frozen package-integrity and non-installing extracted-runtime evidence also pass, but it is not current-source. A high-severity dependency-audit gate and exact-image Firefox/WebKit job exist but have no retained hosted run. The retained macOS PKG is unsigned, unnotarized, not independently reproducible, unscanned, and untested through privileged native lifecycle operations. | Keep release closed on Chromium/license-policy approval, signing/notarization, independent reproducibility, artifact/image/OS scanning, clean macOS/Linux/Windows lifecycle proof, real server-mode and remote-host/off-site disaster recovery, complete hosted security/deployment suites, provenance, and retained GitHub-hosted evidence. |
| Signing/notarization/OAuth/GPG | **Blocked externally** | No credentials are fabricated | Produce reproducible unsigned artifacts and exact operator instructions until real credentials are supplied |

## Release-blocking gaps

Production readiness remains **NO-GO** until all of the following are resolved
and evidenced:

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
  matches the current packaged workspace outputs, passes private extracted-byte
  runtime checks, and was not installed. It is still only an engineering
  checkpoint: its same-host repeat changed the outer PKG bytes despite identical
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
  smoke tests exist, and the current Sharp-free source-workspace permissive
  gate passes. The schema-12 package matches the current packaged workspace
  outputs, but its same-host outer bytes are nondeterministic and none of the
  remaining legal, signing, scanning, or native lifecycle gates is closed.

## Current operator conclusion

FormaSpec now has substantial enterprise-oriented foundations and a usable
source development path, including automatic Codex/Minimal UI connection.
Those foundations are suitable for continued local evaluation and incremental
development. They are not sufficient evidence for an enterprise production
deployment, migration, or signed native release.

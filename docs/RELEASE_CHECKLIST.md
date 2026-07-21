# FormaSpec release checklist

Last updated: 2026-07-21

Current decision: **NO-GO — enterprise-foundation checkpoint**

This checklist is evidence-based. Check an item only when implementation,
migration, documentation, and relevant tests exist in the repository and have
passed for the release candidate.

## Baseline evidence

- [x] Baseline worktree was clean before enterprise work.
- [x] `pnpm test:run` passed 36 tests: 23 core, 8 server, 5 web.
- [x] `pnpm typecheck` passed.
- [x] `pnpm build` passed.
- [x] `pnpm test:launcher` passed 158 tests.
- [x] `docker compose config --quiet` passed.
- [x] Resize-border defect reproduced and recorded with exact pan/error values.
- [x] A deterministic 1,000-node core/apply/service-preview harness and initial
  p50/p95 measurements exist; the current local browser/Chromium budgets pass
  below, while retained cross-platform release-CI evidence remains open.

Run the current verification set:

```bash
pnpm test:launcher
pnpm typecheck
pnpm test:run
pnpm build
docker compose config --quiet
```

The last broad checkpoint on 2026-07-21, before schema 13 and source-backed
component insertion, passed core 47/47 across 8 files,
server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9
files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files,
installer 62/62 across 5 files, and launcher 212/212. All seven workspace
typechecks and builds passed. Browser gates passed editor/prototype/
administration behavior 3/3, selection
alignment 12/12, revision inspect 1/1, visual regression 7/7, the complete
20-step release scenario 1/1, and the 1,000-node performance gate 1/1. That
checkpoint's source evidence passed with 342 components and zero policy violations. Workflow
contracts pass 8/8, cross-browser runner tests pass 2/2, off-host simulation
tests pass 7/7, release-evidence tests pass 8/8, macOS package-evidence tests
pass 12/12, and macOS runtime-smoke tests pass 10/10. The then-current local-
uncommitted schema-12
image passed the Docker smoke, renderer-egress canary, same-host copied-bundle
restore, and Firefox/WebKit 12/12 once. The immediately prior fit-sync image
adds three consecutive identical 12/12 runs after the initial-fit race fix as
historical browser-stability evidence. The retained pre-current-SSE-authorization
unsigned schema-12 macOS PKG has passing frozen integrity and non-installing
extracted-runtime evidence, but current-source verification records drift and a
same-host repeat changed the outer PKG bytes despite identical payload and
workspace trees. It is not reproducible, signed, notarized, scanned, installed,
or lifecycle-qualified. The preserved schema-11 and schema-10 packages are
historical.

Current source is database schema 13, command engine 2, renderer 3, renderer
IPC protocol 2, with 52 MCP tools, 25 resources, and 108 protected non-MCP
routes. Focused current gates include core build/typecheck, server/web
typecheck, component-source/design-system/insertion tests, component-library/
insertion server 16/16, browser component-library 6/6, CLI command 23/23, MCP
contract 5/5, and route contract/coverage 12/12. The complete current
application suite passes 678/678, launcher 212/212, and all seven workspaces
pass typecheck/build. Schema-13 Playwright passes editor/admin/component
insertion 4/4, selection 12/12, handoff 1/1, visual 7/7, revision inspect 1/1,
the 20-step release scenario 1/1, and the 1,000-node budget 1/1. Current Docker
restart/egress, Firefox/WebKit 12/12, and copied-bundle recovery pass locally.
Temporary current-source SBOM/license generation/checking passes with 342
components and zero violations, but it predates the subsequent lock-only
upgrade from linked `drizzle-orm` 0.44.7 to declared 0.45.2. The updated lock
passes offline frozen validation; audit reports info 0, low 0, moderate 2,
high 0, critical 0 across 416 dependencies. No packages were installed, so all
678 tests and browser/Docker/recovery runs still exercised 0.44.7. A fresh
frozen install, full rerun, and regenerated SBOM are mandatory. No current
native macOS package, hosted provenance, image/OS scans, or real server-mode/
off-site release evidence exists.
Release remains `NO-GO`. The separate disposable recovery exercise below
proves one local Docker recovery path but not the complete enterprise release
matrix.

Recorded disposable evidence on 2026-07-20 used an isolated Compose project on
port `4397`. It restored
`backup_0dda1a60c54c5805557426a428739e505e089425` with operation
`restore_e2ea0123456789abcdef0123456789`, then restored safety backup
`backup_7697fb29100b0bc8adc22707114c50947ed3a668` with operation
`restore_e2eb0123456789abcdef0123456789`. The first result contained only design
A; the second contained A and B; original IDs/revisions were preserved; one
grant, connection, and nonce were revoked; the connection remained revoked; and
the disposable containers, volumes, and network were deleted.

## Phase 0 gate

- [x] `docs/IMPLEMENTATION_STATUS.md` records actual status and limitations.
- [x] Current and target architecture are distinguished.
- [x] Security posture and threat model document current P0 findings.
- [x] Editor coordinate defect and target contract are documented.
- [x] Current backup/restore limitations and operator recovery are documented.
- [x] Operations and release gates contain copyable secret-free commands.
- [ ] Every enterprise document named in the product specification exists.
  Remaining documents are delivered with their implementing phases.

## Phase 1 blocking gate

Do not start a production rollout or V2 head migration until every item passes:

- [ ] `ViewportTransform` is the only coordinate conversion implementation.
- [ ] Moveable/Selecto use an untransformed interaction overlay and stable
  target wrappers.
- [ ] Selection alignment is within 0.75 CSS px for the full zoom/pan/scroll/
  DPR/layout/node/direction matrix.
- [ ] One gesture creates one normalized command and preserves fractional
  geometry/rotation.
- [x] Auto-layout drag/resize semantics are browser-tested at DPR 1/2: linear,
  wrapped, and grid reorder/insertion; cross-container reparent; and
  fill/hug-to-fixed resize commit one normalized command without writing x/y
  or losing fractional geometry/rotation.
- [x] The deterministic 1,000-node service harness and 20-sample pinned-
  Chromium browser gate exist; all specified local interaction and render
  budgets pass without software fallback.
- [ ] Numbered database migrations pass clean install and legacy upgrade.
- [x] Deterministic source-built schema 1 and schema 7–11 fixtures apply the
  genuine migration prefix, lock reviewed schema/data digests, preserve V1
  revision/asset/hash and enterprise-row evidence through schema 12, and prove
  migration 12 creates decision integrity without fabricating decisions.
  Focused schema-13 tests also upgrade a genuine schema-12 fixture without
  fabricating component sources or exact upgrade-preview metadata.
- [x] `formaspecctl` source recognizes server database schema 13 for migration status,
  backup compatibility, restore compatibility, and support-bundle reporting.
- [x] Startup, backup verification, restore preflight, and restore control source
  checks fail closed when migration-9/10/11/12/13 ledger rows lack required tables, columns,
  indexes, triggers, normalized schema SQL, or forbidden-trigger removal.
  Full current backup/restore and operator-suite verification remains pending.
- [ ] Legacy data is backfilled into one organization without ID loss.
- [ ] Role/scope/project/expiry/revocation authorization matrix passes for
  REST, SSE, MCP, assets, previews, revisions, and contexts. Focused
  project-scoped REST/MCP/SSE isolation and fail-closed trusted-identity tests
  pass. A declarative manifest and build-time route collector prove exact
  closure of all 108 protected non-MCP routes (54 project, 48 organization, six
  explicit exceptions). The current application suite rejects missing/
  malformed identities before parsing or mutation, exercises mapped/disabled
  identities and pairing nonce replay, and provides direct behavioral
  authorization across all 108 routes with zero uncovered. The ten previously
  uncovered opaque-ID
  routes, all four product-specification routes, all twelve handoff routes,
  implementation-mapping creation, all six Redesign assessment routes, Agent
  Connections, Repository Inventory, backup artifact control, and organization
  policy/audit retention now have direct HTTP role/foreign-ID/swapped-ID/non-
  leak/no-mutation coverage plus project-scoped agent service/MCP and
  revocation probes remain covered, and the schema-13 component-library/
  insertion interfaces are included.
  Both
  actual SSE routes pass real HTTP replay/live filtering and immediate
  revocation/401 reconnect tests. The broader human-role/project/parent-child
  combinatorial lifecycle matrix remains open.
- [ ] Local mode binds to loopback and ignores proxy identity headers.
- [ ] Server mode fails closed without HTTPS/public URL, trusted proxy ranges,
  a separate internal proxy hop secret, Host/Origin allowlists, identity
  mapping, CSRF/CSP/security headers, and MCP auth. Focused configuration/
  launcher tests plus a controlled actual-socket 1/1 lifecycle pass for
  overwrite/strip, direct-peer denial, ambiguous append rejection, and restart-
  bound rotation. Real Nginx/TLS, identity-provider, firewall/routing, public-
  port, and compromise-response deployment evidence remains open.
- [ ] Preview and committed canonical bytes and hashes are exactly equal.
- [ ] Revision hash chain verification and corruption tests pass.
- [ ] Two concurrent commits from one base produce one success and one
  `VERSION_CONFLICT` with no orphan revision/event/idempotency success.
- [ ] Idempotent retries survive restart and never duplicate revisions.
- [ ] Persisted previews survive restart until expiry and have complete state/
  engine/hash/ID/change metadata.
- [ ] Transactional outbox publishes only committed events.
- [ ] SSE replays from `Last-Event-ID` and reports retention gaps.
- [x] Active SSE streams reauthorize every delivered event and heartbeat and
  close after grant revocation or organization-policy denial.
- [ ] Every ordinary/direct archive bypass is rejected.
- [ ] Image worker fully decodes, rejects animation, strips metadata,
  re-encodes deterministically, enforces limits, and quarantines legacy BLOBs.
- [ ] Renderer runs separately, non-root, sandboxed, bounded, deterministic,
  and without external network.
- [ ] Production render failure returns a render error without software
  fallback or API termination.
- [x] Migration 11 persists API-owned render/raster-normalization jobs through
  queued/running/terminal states with leases, heartbeats, expired-owner
  recovery, organization/internal scopes, bounded safe metadata, and permit-
  guarded exact 30-day retention; worker/database separation and trigger/table
  tamper checks pass focused tests.
- [x] Backup verifier focused tests cover strict manifests/checksums, exact
  asset-manifest/file matching, normalized asset and legacy BLOB integrity,
  canonical snapshots, typed operations, revision hash chains, contiguous
  history, and exact project heads.
- [x] Backup/import/restore design-system integrity tests validate pin
  organization/project ownership, exact immutable release/system/version
  identity, published or legitimately deprecated current pins, V2 head-to-pin
  equality, the exact rowless bundled-Foundation exception, historical V2
  releases, and transitional V1 pins. V2 import atomically inserts only valid
  published local custom pins, incompatible restores fail with
  `USED_TOKEN_REMOVED`/`USED_COMPONENT_REMOVED`, restore provenance is durable,
  and migration backup eligibility includes later pin changes.
- [x] Externally supervised launcher-local Docker restore foundations and
  focused tests cover maintenance fencing, opaque backup IDs, verified safety
  backup, closed-database journaled cutover, deterministic renderer smoke,
  audit/outbox reconciliation, restored-agent revocation, status/resume, and
  eligible rollback behavior. They also cover the exact mode-`0600` Docker
  runtime binding, shared non-expiring worker lock, durable `prepared` /
  `cutover_committed` / `reconciled` / `rolled_back` states, safe abort, and
  proven-stale-lock clearing. Live volume inspection rejects plugin, NFS,
  bind-backed, and aliased backing identities; health probes have absolute
  deadlines; unsafe launcher-lock paths are not deleted; and planned pre-cutover
  resume/rollback worker failures restart and verify the unchanged API.
- [x] A disposable local-Docker backup-A/mutate-B/restore-A/restore-safety-B
  exercise passes with original design/revision IDs and restored credential
  revocation, using the exact IDs recorded in Baseline evidence.
- [ ] Expand the Docker/server exercise to the full recovery matrix: normalized
  and legacy assets, design-system data, historical customer fixtures, failure
  injection, reconnect/revocation lifecycle, and cross-platform artifact
  comparison.
- [x] The current schema-13 isolated 20-step Playwright scenario covers browser-created product
  context, backup-gated V1→V2 migration,
  all 22 planning sections, a scoped MCP
  task, multi-screen preview/lint/render/commit, human correction, selection
  refinement, immutable history restore, canonical/portable export, verified
  source-local backup, stopped-database restore, restart, exact hashes, product
  specification, planning/task state, drift removal, and PNG smoke.
- [x] Managed restore opens the source with `O_NOFOLLOW`, copies/hashes it into
  private mode-`0700` staging on `/backups`, changes the pinned file to mode
  `0400`, validates expected managed size/SHA-256, and uses only those pinned
  bytes for journal matching, verification, and extraction. Source-local restore
  passes its exact verified tar-stream hash/size into the same engine. The
  valid-bundle swap test passes, and committed journal evidence survives a
  pinned-source cleanup failure. Whole-workflow capacity is forecast before
  maintenance, each copy/extraction step rechecks capacity, active-operation
  source pins are preserved during orphan cleanup, and downloads stream an
  opened private pinned descriptor rather than a replaceable managed pathname.
- [ ] Backup authenticity/provenance is established through an approved signing
  and key-management design; current checksums prove consistency only.
- [ ] Server mode has a release-tested deployment-specific external supervisor for
  locking, maintenance, API/renderer lifecycle, safety backup, planned restore,
  offline recovery, verification, rollback, alerting, and recovery after
  interruption. Managed-ID restore is `HEALTHY_PLANNED_RESTORE_ONLY`; the
  separate `backup restore offline <bundle> --yes` path implements stdin-only
  pinned transfer, pre-stdin/whole-workflow/forensic pre-copy capacity gates,
  full target verification, exact corrupt-safe forensic pre-state capture,
  standard revocation, one combined 4 MiB-default child stdout/stderr budget,
  and resume/rollback semantics. Focused process-runner coverage passes 5/5,
  including a SIGTERM-resistant child that proves the 5-second SIGKILL fallback.
  Successful forensic rollback keeps maintenance active and the API
  stopped; direct clear is rejected and only a newly verified offline restore
  may atomically take over. Offline failures never auto-abort/restart; takeover
  retains the predecessor until replacement preparation is durable. Resume uses
  the current maintenance owner for `offlinePrepare` and the replacement worker,
  rather than reusing the retained predecessor's operation ID. Abort
  returns `VALIDATION_FAILED` rather than unfencing corrupt/non-SQLite state. A
  disposable unique-Compose worker/control smoke
  passed real schema-11 design/PNG restore from corrupt live bytes, credential
  revocation, exact forensic byte rollback, durable offline state, and cleanup.
  A subsequent real unique-project `formaspecctl` smoke validates the persisted
  Compose identity end to end. That schema-12 image also passed a second
  same-machine source-to-clean-target copied-bundle simulation with independent
  projects/volumes, exact bundle/snapshot/revision/asset/render equality,
  SQLite integrity/foreign-key checks, verified local Docker context, non-root
  runtime proof, and complete cleanup. The summary is
  `/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json`.
  Its SHA-256 is
  `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`.
  Server-mode proxy, packaged-runtime, real remote-host/network/TLS/off-site
  storage, and broader recovery evidence remains open.
- [ ] Scheduled backup execution, retention failure recovery, off-host storage,
  and the 7/4/12 policy pass release scenarios. Durable scheduled-attempt
  start/success/failure audit/outbox evidence, overdue/stalled/failed/retention-
  backlog diagnostics, ready-health aggregation, and CLI warnings now exist.
  Failed or stalled attempts remain critical even when the current window has
  a valid backup;
  installed external invocation and alert delivery remain open.
- [ ] No critical or high security finding remains in the installed/tested
  candidate. The lockfile fixes GHSA-gpj5-g38j-94v9 with `drizzle-orm` 0.45.2
  and audit reports zero high/critical findings, but installed modules and all
  runtime tests still used 0.44.7; fresh frozen install and full verification
  are required.

## Phase 2 gate

- [x] Strict V1 read/import compatibility corpus passes across every V1 node
  and token kind, layouts/styles, prototypes, RTL metadata, component
  overrides, stable IDs, and legacy quarantined asset kinds/MIME types.
- [x] Strict V2 schema and deterministic V1-to-V2 fixtures pass.
- [x] Historical V1 revisions remain immutable and exportable.
- [x] Current-head migration preserves every stable ID and records quarantine
  diagnostics.
- [ ] Foundation token layers and light/dark/high-contrast LTR/RTL contexts pass.
- [x] Component contracts, instances, lifecycle, releases, pinning, and upgrade
  preview tests pass. New versions require an authorized immutable V2 source,
  persist canonical detached state trees plus SHA-256, and legacy null-source
  versions remain readable but cannot enter a new release. Project pin controls
  clear stale state, and assigning or upgrading a pin atomically synchronizes
  one V2 head revision while leaving V1 heads unchanged. Schema-13 V2 upgrade
  previews persist and commit the exact result snapshot, materialize target
  tokens/component masters, and block removed states, missing dependencies,
  asset copying, legacy sources, and unsupported property/slot bindings. An
  exact project/revision-bound REST, MCP-tool, and MCP-resource read returns the
  release used by an authorized historical revision without exposing the
  organization catalog.
- [x] Exact pinned-release insertion exists through the read-only component
  library, REST preview, MCP PNG preview, and ordinary preview commit. The
  Components tab requires a clean matching V2 head, exposes source/asset
  blockers, lets a reviewer select state/parent/position/name, renders
  diagnostics and the result hash, and explicitly commits or discards. Focused
  server 16/16 and web 6/6 pass. Property-to-node/slot bindings, content-hash
  asset copying, and broader accessibility/conflict/backup/export/restore
  evidence remain open.
- [x] Product specification natural-language/structured synchronization passes.
- [x] All 22 interview sections persist, resume, edit, and version correctly in
  service/integration tests and in the integrated browser release E2E.
- [x] Enterprise editor navigation, panels, administration, click-through
  prototype behavior, and exact manual component insertion pass the current
  4/4 browser gate for Pages/Layers/
  Components/Assets,
  Canvas/Prototype/Before-After, Design/Content/Component/Logic/Prototype/
  Accessibility, activity/diagnostics/revision/handoff navigation, and
  click-to-frame navigation without document mutation. The insertion case
  verifies backup-gated V1→V2 migration, exact Foundation catalog loading,
  isolated rendered preview without head mutation, ordinary CAS commit,
  version-3 reload, and an active projected instance.
- [x] Revision-pinned inspect API/view remains on the requested immutable
  revision when the project head changes and exposes integrity hashes, resolved
  tokens, assets, components, rules, acceptance criteria, implementation
  mappings, stable IDs, and JSON paths. The fresh revision-inspect immutability
  E2E passes 1/1, independently of the 12/12 selection-alignment gate;
  broader cross-browser/accessibility evidence remains open.
- [x] Enterprise V2 lint rules cover raw values, missing states, hierarchy,
  accessibility, touch targets, prototypes, RTL, detached/deprecated
  components, typed property/slot/state contracts, and missing rule/entity
  links; 7/7 representative visual snapshots including Persian RTL pass.
- [ ] `.formaspec.zip` rejects traversal/symlinks/bombs and round-trips
  losslessly.
- [x] Mutating portable import requires Organization Administrator access and an
  idempotency key; default preserve-ID conflict failure and explicit
  deterministic clone mode, V1/V2 local-version rebasing, product-specification
  persistence, isolated raster normalization, metadata-only legacy quarantine,
  transactional rollback, immutable migration-10 provenance, implicit bundled
  Foundation handling, and atomic validation/insertion of custom local-
  organization V2 pins pass. Arbitrary external system/release IDs are rejected.
- [x] Portable ZIP parsing rejects mismatched central/local headers,
  descriptors, CRCs, unsupported flags/features/types, symlinks/directories,
  duplicate/overlapping entries, false sizes, empty/trailing compressed data,
  and limit overflows before bounded 16 KiB per-entry streaming inflation.
- [x] Multipart uploads stream into private disk staging and ZIP entries inflate
  independently in bounded 16 KiB chunks into private files; the request and
  complete extracted set are not retained in memory simultaneously.
- [ ] Add larger adversarial, concurrent-import, sustained-resource, and
  packaged cross-platform evidence for the streaming import path.
- [x] DTCG and bounded platform token exporters pass golden tests.

## Phase 3 gate

- [x] MCP server ID is `formaspec`, display name is Minimal UI, resources use
  `formaspec://`, and the safe workflow is self-contained in the first 512
  instruction characters.
- [x] Every MCP tool has a strict schema, correct annotations, and scoped
  authorization. The executable 52-tool/25-resource matrix now proves strict
  top-level inputs; exact strict `ok:true` success and `ok:false,error` output
  branches; annotations; every static agent scope; secondary design-read gates;
  and all scoped resources. Temporary-ID preview operations mirror the strict
  core operation union across all ten variants; task/redesign inputs use strict
  discriminated bounded schemas; every success result family has an exact
  nested DTO with ID/hash/version/state correlations; structured
  `error.details` is the only bounded generic JSON envelope. Dynamic
  handoff/redesign scopes have dedicated focused coverage.
  `design_system_component_insert_preview` resolves only the exact pinned
  release, returns PNG plus source/release/instance metadata, and commits only
  through `design_commit_preview`; generic operations reject the server-only
  insertion record. The current 108-route application authorization run passes
  with zero uncovered.
- [x] Agent task inputs are immutable and transitions are append-only.
- [x] Claim/progress/complete/cancel/expiry/base-version/output validation pass
  in service and HTTP/MCP integration tests.
- [x] Dashboard and editor prompt boxes create tasks and never call an embedded
  AI API.
- [x] One explicit Codex authorization configures, verifies, and installs the
  managed `minimal-ui` integration without a token in generated TOML.
- [x] Codex recognizes “Use FormaSpec” and “Use Minimal UI” through the managed
  skill/plugin and `[@Minimal UI](plugin://minimal-ui@formaspec)` mention.
- [x] Agent pairing nonce, scope, project restriction, expiry, reconnect, and
  immediate revocation tests pass.
- [x] Unsupported MCP clients receive safe generic instructions; unknown
  configuration files are not modified.
- [x] Task-scoped before/after review provides side-by-side/toggle modes,
  changed-node highlighting, diagnostics, exact PNG access, base/proposed
  versions and hashes, exact commit, and atomic discard/preview expiry.
- [x] Product-manager-to-Codex preview/render/lint/commit/deep-link E2E passes
  inside the complete 20-step isolated release scenario.

## Phase 4 and 5 gate

- [x] Workspace Bridge is a separate local process; it does not expose shell or
  repository mutation. Packaged native credential-store evidence remains open.
- [x] Repository selection/grant is explicit, expiring/revocable, and read-only.
- [x] Organization exclusion patterns are persisted with the grant, symlinks
  are not followed, and the uploaded inventory contains opaque location IDs
  rather than arbitrary paths.
- [x] Framework-aware web, Android, iOS/Xcode, Flutter, React Native, and
  generic-Git scanners plus exact implementation-authorized launch pass 37/37
  bounded fail-closed fixtures. Coverage
  includes worktree pointer/back-reference validation, ancestor-swap defense,
  dual directory enumeration, nested-monorepo detection, stable opaque IDs,
  and explicit depth/count/aggregate-byte truncation. Automatic mapping
  suggestions, incremental rescans, and richer framework semantics remain open.
- [x] A connected grant automatically persists its bounded path-free inventory
  through REST or the authorized token-free MCP bridge. Direct REST still
  requires a compatible API identity/bearer channel in trusted-header setups.
- [x] Design/spec/source mappings are created through strict REST/MCP/browser
  flows, pinned to exact revision/product-spec/inventory hashes, immutable,
  scoped, idempotent, audited, replayable, and revision-inspectable. Portable
  mapping round-trip semantics and broader tamper/browser E2E remain open.
- [x] Selected-workspace `launch-codex` revalidates the exact local grant,
  central inventory binding, repository fingerprint, policy, and the final
  immutable `approved` → `implementing` `start_implementation` transition; it
  starts Codex with exact repository `cwd`,
  `shell: false`, one secret-free task argument, a minimal environment, and
  POSIX process-group revocation monitoring. Packaged Windows Job Object or
  equivalent descendant containment remains open.
- [x] Plan approval, branch/worktree isolation, diff review, validation
  approval, commit approval, push authorization, and pull-request request/
  disposition are independently persisted, authorized, audited, idempotent,
  and CAS-protected. Start derives plan/isolation gates; completion derives all
  seven dispositions and accepts only a summary. Plan approval requires
  `expectedPriorDecisionId`, so a stale approval cannot supersede a newer
  denial. REST/MCP/public-contract coverage and the focused browser flow pass;
  packaged supervision and the broader role/browser matrix remain open.
- [x] Seven redesign stages are resumable and reuse canonical spec/system/task/
  handoff primitives. Strict immutable stage artifacts and fail-closed
  readiness require reviewed evidence before forward transitions and approved
  evidence before approval/completion. Future-state entry additionally requires
  current design/inventory pins and fully verified immutable mapping evidence;
  missing, stale, forged, draft, or blocked evidence stops the transition.
- [x] Browser “one click” explicitly selects a project and active per-platform
  inventory, creates assessment/planning only, excludes untrusted project names
  from the fixed instruction, and never modifies source.
- [ ] Assessment, proposal, design, handoff, and implementation grants are
  independently revocable.

## Phase 6 delivery gate

- [ ] Perform a fresh frozen install from the lockfile with `drizzle-orm`
  0.45.2, then rerun all 678 application tests, launcher, typecheck/build,
  browser, Docker/egress, Firefox/WebKit, recovery, and SBOM/license gates.
- [x] Strict versioned organization-policy read/update through the guided
  12-section Administration form and Expert JSON, MCP read/resource,
  secret-free YAML export, optimistic configuration-hash concurrency,
  repository/agent/asset/backup/export enforcement, and exact backup binding
  pass focused tests.
- [x] Organization-admin audit retention uses an exact expiring preview,
  minimum-policy cutoff, restart-safe idempotency, atomic guarded deletion,
  replay gaps, and immutable hash-chained evidence.
- [ ] Delegated administration and policy roles, installed external schedule
  invocation and alert delivery, policy rollout/version migration, broader organization
  lifecycle evidence, and the exhaustive browser/HTTP/MCP matrix pass.
- [ ] Self-contained `formaspecctl` commands pass clean-system tests.
- [ ] `designer` migrates legacy state and delegates without data loss.
- [ ] Release-ready macOS PKG, Windows WiX v4 MSI, and Linux DEB/RPM
  artifacts are produced and pass their platform gates.
- [x] Deterministic Linux DEB/RPM source builders, payload layout, hardened
  systemd API/renderer units, data-preserving lifecycle scripts, strict
  protocol registration, and focused unit tests exist. No real Linux artifact
  or lifecycle evidence exists.
- [x] A native-Windows-only WiX v4 unsigned-MSI builder foundation checks
  internally consistent caller-supplied service-host/WiX inputs, uses one cross-
  architecture UpgradeCode, copies verified payloads into private staging,
  invokes WiX with a minimal environment, and bounds command duration. Tests
  use fake PE/CFB/WiX fixtures; no trust anchor, real WiX compile, extracted MSI
  validation, artifact,
  qualified service host, SCM/ACL/Job Object/named-pipe/Chromium/protocol/
  signing/lifecycle evidence exists.
- [ ] Clean install, automatic startup, upgrade, uninstall, reinstall, and
  protocol registration tests pass on each supported OS.
- [ ] Setup wizard completes agent authorization, backup destination, render
  verification, and health checks.
- [ ] The single `formaspec/server` image with two long-lived API/renderer
  services and the profiled one-shot restore worker passes non-root,
  capability, filesystem, migration, readiness, restart, restore, and egress
  tests.
- [x] Fresh disposable schema-13 project `formaspeccischema13da9af9d064` used
  image `sha256:166d74686a8ebd52c2765d0c12b362690717af8488a7a4b83f0f1e348d620b97`,
  reached readiness, rendered the same 512×339 PNG hash before/after API
  restart, denied DNS/TCP/non-loopback egress, and cleaned up. The same image
  passed Firefox/WebKit 12/12 and source-to-clean-target copied-bundle recovery
  with exact snapshot/revision/asset/render/SQLite/FK comparisons. Docker,
  cross-browser, and recovery summary SHA-256 values are respectively
  `13c608ce5ddec282d8e0b8497d54f9971f4f20764d035122ea5e64dfd31f1e0f`,
  `c128ee3f6a7341cd75189dba612d6b01d25abd2b57fb26db1970c152f1f665bc`,
  and `1dfecf9b4a4773fed25f73eaa181bc88e30fc21df8b0679c3325241af3ccd433`.
  This is local `NO-GO` evidence, not hosted provenance or native lifecycle
  qualification.
- [x] The prior schema-12 disposable project `formaspeccischema118e2818fed6`, built from
  the `local-uncommitted-final437-eventauth-sqlbounded-cli` checkpoint,
  reached migration 12 Playwright-worker
  readiness without fallback, created design
  `document_0e6b4b61e3964110b9a4533ef2a63398` at revision
  `revision_aea2807b70cb4c8c9b6588c191de0218`,
  rendered a 512×339 PNG with SHA-256
  `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`,
  restarted only the API, recovered the same design/version, and rerendered the
  exact same hash. API and renderer used identical image
  `sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`;
  both were non-root/read-only/capability-free/no-new-privileges and resource-
  limited. The renderer used `network_mode: none` with only `/run/formaspec`
  mounted; its egress canary returned DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and
  zero external interfaces. Independent cleanup verification found no remaining disposable
  containers, volumes, or networks. The summary in
  `/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json` is
  historical local `NO-GO` evidence with SHA-256
  `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`, not
  retained-CI, provenance, scanning, or independent-reproducibility proof.
- [x] That schema-12 reviewed image passed Firefox/WebKit alignment 12/12 once in a
  network-disabled, read-only, non-root disposable Linux runner with all
  capabilities dropped and complete cleanup. Its summary is
  `/private/tmp/formaspec-cross-browser-docker-20260721-final437-eventauth-sqlbounded-cli/summary.json`
  with SHA-256
  `2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`.
  The immediately prior fit-sync image passed three consecutive 12/12 runs
  after the initial canvas fit moved synchronously into `useLayoutEffect`,
  eliminating the WebKit initial-fit race. Its main summary is
  `/private/tmp/formaspec-cross-browser-docker-20260721-final430-auth106-supervision-egress-fit-sync-runtime/summary.json`.
  The runner-only `seccomp=unconfined` exception is not used by production
  services. The prior main, `-repeat2`, and `-repeat3` summaries are byte-identical
  with SHA-256
  `0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`;
  hosted and cross-OS evidence remains open.
- [x] Provider-neutral, offline, deterministic CycloneDX 1.6 source-workspace
  SBOM generation, approved-license reporting, notice hashes, checksum
  generation, stale-evidence checking, and focused tests exist.
- [x] Current Darwin ARM64 source-workspace evidence passes the
  permissive-only gate: 342 third-party components, zero violations, and no
  Sharp/libvips dependency.
- [x] The earlier unsigned macOS ARM64 PKG candidate at
  `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
  has checkpoint offline evidence: SHA-256
  `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`,
  184,835,514 bytes, integrity `PASS`, 349 linked components, seven exact
  workspace trees, and two bundled runtimes.
- [x] A preserved pre-final-patch unsigned macOS ARM64 PKG checkpoint
  `artifacts/candidates/schema11-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
  was recorded at size 176.3 MiB, SHA-256
  `3aad0cd887a7ce83e59cd85e0527500083e71eb31e9340d96dec2eca958017c2`,
  349 packaged components, seven workspace trees, and two runtimes. It was not
  installed. Its latest evidence gate fails because packaged core `dist`
  differs from the workspace, so it does not represent the present source. The
  schema-10 candidate remains historical only.
- [x] The retained pre-current-SSE-authorization unsigned schema-12 macOS ARM64
  engineering checkpoint
  at
  `artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
  is 185,279,180 bytes with SHA-256
  `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`.
  It was not installed. Package integrity passes with 349 components, seven
  exact workspace trees, two bundled runtimes, payload-tree SHA-256
  `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`,
  and workspace-tree SHA-256
  `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`.
  The non-installing extracted-runtime smoke passed Node v24.14.0, Chromium
  headless shell revision 1228, schema-12 health, real PNG rendering, exact
  51-tool/25-resource MCP inventory, native state paths, cleanup, and unchanged
  system install targets/receipts. Its summary SHA-256 is
  `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`.
- [x] The schema-12 candidate-root `SHA256SUMS` manifest verifies all 14
  retained package, sidecar, source, runtime, reproducibility, and documentation
  entries.
- [x] Same-host PKG reproducibility was tested and failed. The repeat artifact
  is 185,279,075 bytes with SHA-256
  `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0`;
  its outer bytes differ while payload/workspace-tree hashes remain identical.
  Diagnostic summary SHA-256 is
  `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`.
- [ ] A frozen final macOS package passes the release gate. Chromium/license-
  policy approval, Developer ID signature, notarization, independent
  reproducibility, vulnerability scans, and clean install/autostart/protocol/
  upgrade/uninstall/reinstall evidence remain open.
- [ ] Artifact-specific container, Windows, and Linux SBOMs; image/OS scans;
  reproducibility; signed provenance; and retained CI results exist. A
  fail-closed high-severity dependency audit with retained JSON is configured
  but has no hosted result yet.
- [x] Five repository-native least-privilege workflows cover frozen source gates,
  Chromium plus Firefox/WebKit alignment, Chromium visual/performance/release
  suites, a Docker smoke workflow under the compatibility filename (current
  source requires schema 13),
  dependency-audit JSON, deterministic source SBOM/license evidence, and
  unsigned Linux DEB/RPM evidence. The main/manual macOS workflow also builds the
  unsigned package and exercises privately expanded runtime bytes without
  installing it. The Docker job runs Firefox/WebKit
  against the exact image it just built, runs a DNS/direct-TCP/non-loopback
  renderer-egress canary, and retains a separate
  `NO-GO-cross-browser-docker-*` artifact, then restores a copied verified
  bundle into an independent clean project and retains
  `NO-GO-offhost-restore-*`. Workflow contract tests pass 8/8,
  cross-browser runner tests pass 2/2, off-host simulation tests pass 7/7,
  release-evidence tests pass 8/8, macOS package-evidence tests pass 12/12,
  and macOS runtime-smoke tests pass 10/10.
- [ ] Retain the updated schema-13 Docker/off-host gates on hosted runners and
  build a current macOS package for the extracted-runtime gate. Local Docker,
  Firefox/WebKit, and off-host-simulation executions pass; current scripts
  require schema 13, and the macOS smoke requires all 52 tools including
  `design_system_component_insert_preview`, but no schema-13 native package has
  satisfied it.
- [ ] Retain successful GitHub-hosted runs and real Ubuntu DEB/RPM artifacts;
  current workflow presence and local contracts are not hosted release evidence.
- [ ] Signing/notarization uses real operator credentials or artifacts are
  clearly marked unsigned with exact operator steps.
- [ ] Documentation matches the release candidate and final report is generated
  from verified evidence.

## Release performance budgets

Representative projects must contain at least 1,000 nodes.
The measurements below are from the schema-13 Chrome performance run before
the lock-only `drizzle-orm` 0.45.2 update. They pass the budgets but must be
repeated after a fresh frozen install.

| Measurement | Required p95 / hard limit | Current evidence |
| --- | --- | --- |
| Initial interactive load | at most 2.5 seconds p95 | **Pass:** 230.70 ms p95, 20 cold samples |
| Selection response | at most 50 ms p95 | **Pass:** 20.50 ms p95, 20 samples |
| Gesture frames | at most 16.7 ms p95; no frame over 50 ms | **Pass:** 16.70 ms cadence-normalized p95 and 16.70 ms maximum across the measured gesture frames |
| Local commit/autosave | at most 500 ms p95 | **Pass:** 273.20 ms p95, 20 samples |
| History load | at most 1 second p95 | **Pass:** 17.60 ms p95, 20 samples |
| 1440 by 900 render | at most 5 seconds p95; 15-second hard timeout | **Pass:** 221.37 ms p95, pinned Playwright Chromium, no fallback/warnings |
| Preview validation excluding render | at most 1 second p95 | **Pass:** 280.48 ms p95, 20 samples; no render endpoint invoked |

The focused service benchmark also passes at 20.43 ms p95 validation, 49.65 ms
p95 apply, 134.43 ms p95 preview persistence, and 116.83 ms p95 render.

Record hardware, OS, browser, DPR, dataset seed/hash, warm/cold state, sample
count, p50, p95, maximum, and profiler artifact. A single manual timing does not
pass a budget.

## Security and recovery scenarios

- [ ] Path traversal, absolute path, symlink/device, duplicate path, file count,
  size, and decompression-bomb tests pass.
- [ ] Oversized operations, documents, assets, renders, exports, tasks, and
  repository inventories return structured errors.
- [ ] Malformed PNG/JPEG/WebP, animated images, MIME mismatch, SVG, and metadata
  tests pass.
- [ ] Unauthorized object IDs and forged identity/proxy/origin/host requests
  fail without existence leaks.
- [x] Focused regressions prove prompt-like design, product-specification, and
  repository-inventory text remains bounded data and cannot create task/archive
  side effects or expand authority. Real connected-agent semantic-resistance
  and approval-flow evidence remains open.
- [x] The current schema-13 renderer egress canary cannot resolve or connect
  externally: DNS returns `EAI_AGAIN`, direct TCP returns `ENETUNREACH`, and no
  external interfaces are visible. Hosted and native-package evidence remains
  open.
- [ ] No credentials appear in logs, audit payloads, exports, bundles, tasks,
  diagnostics, support bundles, or generated client config.
- [x] Focused backup tests reject semantic corruption in assets, snapshots,
  operations, revision chains, and project heads after archive checks pass.
- [x] Focused restore-worker/supervisor tests keep maintenance active on
  uncertainty and cover resumable durable state, safety-backup reconciliation,
  renderer smoke, restored credential revocation, and conclusive rollback.
- [x] The isolated port-4397 local-Docker exercise proves A-only restore followed
  by A+B safety restore with original design/revision IDs, credential revocation,
  and disposable resource cleanup.
- [x] The isolated 20-step source-local scenario restores canonical V2 project
  hashes, product specification, completed 22-section planning state, completed
  agent task, immutable history, and a representative PNG after proving
  post-backup drift and a sentinel project disappear.
- [ ] A copied `/data`/backup restore reproduces projects, assets, revisions,
  systems, specifications, tasks, hashes, and a representative PNG.
- [ ] Restore failure rolls back to the pre-restore state.

## Enterprise definition of done

- [ ] Non-developer install requires neither Node.js nor pnpm.
- [ ] Application starts automatically.
- [ ] Supported agent connects after one explicit authorization.
- [ ] Agent understands “Use Minimal UI.”
- [ ] Unsupported MCP clients have a safe generic flow.
- [ ] Agent connections are scoped, auditable, expiring, and revocable.
- [x] Product managers create structured product/business specifications in UI.
- [x] Product managers complete the step-by-step interview.
- [ ] AI screens use organization tokens/components by default.
- [ ] Linked components and instances are versioned/manageable.
- [x] Selection controls remained within 0.75 CSS px in the preceding Chrome DPR 1/2 matrix; a schema-13 rerun remains required for release.
- [x] Concurrent same-base writes yield one success/one conflict.
- [x] Retried commits create no duplicate revision.
- [x] Persisted previews survive restart until expiry.
- [ ] Backup restore reproduces all required data.
- [ ] Repository analysis occurs before redesign proposals.
- [ ] Repository files are unchanged without an approved plan.
- [x] Product manager can initiate a redesign assessment from the website.
- [x] Engineer can inspect exact pinned tokens/components/assets/rules/mappings
  in the focused revision-pinned inspect path; broader role/browser coverage
  remains part of the release authorization matrix.
- [x] Renderer cannot access external network in the verified Docker topology (`network_mode: none`).
- [x] Production application and renderer do not run as root in the verified Docker image.
- [x] Representative 1,000-node budgets pass.
- [ ] No critical/high security defects remain.
- [x] Source-workspace production dependencies comply with the approved
  license policy in the temporary pre-lock-update schema-13 evidence. The
  schema-12 macOS PKG matches
  its frozen packaged workspace outputs and passes private extracted-runtime
  checks, but it predates schema 13 and the 52-tool/108-route interface. The
  lock now declares `drizzle-orm` 0.45.2; regenerate the SBOM/license evidence
  after a fresh frozen install. Chromium legal
  approval, reproducibility, signing/notarization, vulnerability scans, and
  privileged lifecycle evidence remain required; container/Windows/Linux
  artifact evidence is also incomplete.
- [ ] Documentation matches actual behavior.
- [ ] Clean install, upgrade, backup, restore, and uninstall tests pass.

## Final release sign-off

Required evidence:

- release candidate commit and source archive checksum;
- migration/compatibility report and verified backup ID;
- complete command log with test outputs;
- visual/security/performance reports;
- SBOM, license report, dependency/image scan results;
- installer/container artifact checksums and signing status;
- external credential/permission blockers, if any;
- updated [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).

Current sign-off: **not authorized**.

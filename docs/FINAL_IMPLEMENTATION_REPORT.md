# FormaSpec enterprise upgrade implementation report

Report date: 2026-07-22

Release decision: **NO-GO for enterprise production**

## Executive result

The repository has advanced from the earlier UI-designer MVP into a substantial
FormaSpec enterprise foundation without rewriting the working V1 application
or discarding existing projects, revisions, assets, launcher state, or Docker
volumes. The product remains usable for local evaluation and continued
development, including automatic Codex connection through the FormaSpec
identity.

Current source is now at database schema 15, command engine 2, renderer 3,
renderer IPC protocol 2, and font bundle 1. Migration 14 adds browser-session
authentication; migration 15 adds bounded write-once exact preview-render
metadata. The complete seven-package suite passes 840/840: core 59, server 466,
web 91, CLI 96, local bridge 20, Workspace Bridge 37, and installer 71. Launcher
225/225, all seven workspace typechecks/builds, editor/Administration E2E 5/5,
release E2E 1/1, focused preview integration 2/2, and macOS runtime-smoke
contracts 11/11 pass.

Live agent acceptance also passed. Exact preview
`preview_dd4da6b79f5e4ddf8b3fd111094c5189` rendered at 1440x900 with PNG SHA-256
`ad356b73d742c7852a86a022f86d68928dae021ab6710bd7b1d852f7e048e26c`, then
committed the project from version 1 to version 2 and completed its task. The
preview and committed revision documents are byte-identical at 76,099 JSON
bytes. Result snapshot SHA-256
`b84512db8bde0e1acdb8c1e8dbc81f6361530a54d880675e301a665a101292a5` and
operation SHA-256
`6ccf0226ccf0a59d6dbd3fd3ab62069c2a45fd522b5f5f9b5f842728428896be`
both match their persisted records.

The broad Chrome selection/handoff/visual/inspect/performance/20-step,
Firefox/WebKit, Docker restart/egress, copied-bundle recovery, and exact
SBOM/license evidence remains historical schema-13 evidence and has not been
rerun against schema 15. Audit at that historical checkpoint had zero high or
critical findings; remaining advisories are still under remediation. Native
installers, image/OS scans, hosted provenance, and real server-mode/off-site
recovery also remain open. The retained macOS package is schema-12 historical
evidence.

Production readiness is intentionally not declared. A retained pre-current-
SSE-authorization unsigned schema-12 macOS ARM64 engineering checkpoint passes its original
package-integrity and private non-installing extracted-runtime evidence, but it
was not installed and is not release-approved. Its same-host repeat produced different outer PKG bytes
despite identical payload and workspace trees, so reproducibility is explicitly
failed rather than inferred. The preserved schema-11 and schema-10 candidates
are historical only. Linux DEB/RPM and Windows WiX v4 source-builder
foundations exist, but no platform has release-qualified native lifecycle
evidence. Chromium legal approval, macOS signing/notarization, vulnerability
scanning, independent reproducibility, a real Windows service host and ACL/
process-tree/runtime proof, real Linux lifecycle proof, server-mode and packaged
real remote-host/off-site disaster-recovery evidence, signed backup provenance,
the comprehensive security/cross-platform browser matrices, and several
advanced product/design-system workflows remain release blockers. Exact local
SBOM/license evidence now reflects the linked 0.45.2 dependency tree, but it is
still temporary `NO-GO` evidence rather than hosted provenance.

## Implemented foundation

- Corrected canvas/Moveable coordinate handling with one viewport transform,
  an untransformed interaction overlay, geometry invalidation, memoized node
  rendering, and browser alignment tests at DPR 1 and 2. Single auto-layout
  children now reorder/reparent with one normalized `move_node` command and
  resize fixed/fill/hug constraints without writing absolute x/y.
- Added strict local/server security modes, organization/project
  authorization, scoped agent grants, append-only audit/outbox records,
  replayable events, archive-only destructive flows, normalized raster assets,
  and bounded renderer IPC. Server mode now requires both a trusted raw proxy
  peer and a separate server-generated internal hop secret on every non-health
  request; launcher generation/storage/scrubbing and exclusion from bindings,
  logs, support bundles, and normal output have focused coverage. Real proxy
  deployment and rotation evidence remains open.
- Added focused project-scoped REST/MCP/SSE authorization coverage. Trusted
  identities fail closed, project-restricted redesign inventory does not leak,
  the bootstrap Organization Administrator survives later Codex pairing, and
  automatic Codex grants omit redesign approval/implementation/cancellation.
  MCP now has an executable 52-tool/25-resource source contract with strict bounded
  inputs, exact correlated nested success DTOs, strict structured errors,
  annotation checks, static scope probes, and scoped-resource probes. Bounded
  generic JSON remains only in `error.details`; temporary-ID previews mirror
  the strict canonical operation union across all ten variants. `handoff_list`
  now returns dedicated bounded summaries with authorization-bound checksummed
  keyset cursors instead of materializing full histories. A separate
  declarative manifest plus build-time route collector now closes the actual
  protected non-MCP surface at exactly 108 routes (54 project, 48 organization,
  six explicit exceptions). Project-scoped task listing now authorizes the
  requested design before querying and has direct HTTP no-leak/no-mutation
  tests. The current 466-test server suite covers exact closure, generated
  authentication rejection, and direct behavioral authorization for all 108
  routes with zero uncovered, including the component-library and insertion
  routes. The evidence includes role/scope,
  foreign/swapped IDs, preview/task ownership, stream revocation, renderer,
  multipart/storage, non-leak, and rejected-state preservation.
  This work fixed authorization-before-expiry for design-system and product-
  specification previews, redundant role writes on mapped reads, cross-
  principal handoff idempotency cleanup, exact mapping cleanup, denied-plan
  bypass, release access outside allowed current project pins, and Redesign
  authorization ordering and schema-validation leaks. It also added an exact
  project/revision-bound REST, MCP-tool, and MCP-resource interface for reading
  the release that rendered a historical revision, and moved `task_list`
  project/status filtering into SQL before `LIMIT`.
- Fixed the actual SSE HTTP authentication boundary. Bearer-token requests to
  `/events` and `/api/events` now resolve to scoped, revocable grant actors
  instead of silently becoming local/trusted browser actors. Real loopback
  streams now enforce one runtime-exhaustive policy across all 18 event
  families. Each family has an explicit agent read scope, human-role allowlist,
  and project/organization/optional/control boundary. Replay applies the policy
  in SQL before `LIMIT`, byte bounds, and cursor calculation; live delivery
  uses the same predicate. Seven focused tests prove that design-only agents
  cannot observe task, handoff, Redesign, connection, backup, audit-retention,
  or other administration events; task-only agents can receive task events
  without `design:read`; administrator-only families stay restricted; and
  policy removal or revocation closes existing streams while preserving
  project/organization isolation and rejected reconnect behavior.
- Added a strict versioned organization policy with a guided 12-section
  Administration form, Expert JSON, optimistic configuration hashes, REST/MCP
  reads, secret-free YAML export, exact backup binding, and enforcement
  across legacy MCP authentication, trusted-header role mapping, live SSE,
  Codex connection scope/expiry/project restrictions, repositories, assets,
  backups, and portable-bundle export/import defaults.
- Added Organization Administrator audit retention with exact 15-minute
  previews, a 30-day hard minimum, at most 2,000 rows and 8 MiB of canonical
  evidence per audit/outbox kind, conservative pre-sizing plus exact-byte
  verification, policy/CAS revalidation, restart-safe idempotency, atomic
  audit/published-outbox deletion, replay-gap signaling, permanently retained
  governance/restore evidence, and immutable SHA-256 chained run records
  through REST and `formaspecctl`.
- Added backup-schedule supervision foundations: every scheduled attempt emits
  durable start/success/failure audit and outbox evidence; overdue, stalled,
  failed-run, and retention-backlog diagnostics feed `/health/ready` and
  bounded `formaspecctl` output. A failed or stalled attempt remains critical
  even when the current schedule window already has a valid backup. Installed external invocation and alert
  delivery remain release work.
- Replaced Sharp/libvips with pinned Chromium raster normalization in the
  isolated renderer worker, including PNG/JPEG/WebP full decode, WebP/JPEG EXIF
  orientation, animation/MPO rejection, metadata stripping, deterministic PNG
  output, and versioned API/worker limit parity.
- Added a source-controlled renderer-egress canary covering DNS, direct TCP,
  and non-loopback interface visibility, plus workflow-contract enforcement so
  it cannot be silently removed. The prior schema-12 image failed closed with
  DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and zero external interfaces.
- Added focused prompt-injection-data regressions proving prompt-like design,
  product-specification, and repository-inventory text stays bounded data and
  cannot create task/archive side effects or expand authority. Real connected-
  agent semantic-resistance and approval-flow evidence remains open.
- Added content-addressed Brotli snapshots, revision hash chains, exact
  persisted previews, atomic CAS commits, durable idempotency, and numbered
  schema migrations through version 15. Current runtime metadata is document
  schema 2, command engine 2, renderer 3, renderer IPC protocol 2, raster
  normalizer 1, font bundle 1, export format 1, and application build `0.2.0`.
  Historical migration-2 defaults remain frozen at command engine 1, renderer
  2, and font bundle 1. Migration 11 adds API-owned persistent
  render/raster-normalization job state with owner leases, heartbeats,
  expired-owner recovery, bounded hash/version/dimension/warning/error metadata,
  organization/internal scope separation, and permit-guarded exact 30-day
  terminal-record retention. The renderer remains database-free and job rows
  contain no document/image bytes or paths. Startup and backup/restore
  validation fail closed when migration-9/10/11/12/13/14/15 ledger rows exist without
  the required schema objects, normalized SQL, or forbidden-trigger removal.
  Migration 12 adds append-only, independently authorized handoff execution
  decisions with CAS/lifecycle integrity triggers. Migration 13 adds paired
  canonical component source JSON/SHA-256 and immutable exact base/result
  snapshot metadata for V2 design-system upgrade previews without fabricating
  historical values. Migration 14 adds the password/session/bootstrap schema
  without creating an administrator or active session. Migration 15 adds a
  bounded nullable `previews.render_metadata_json` column and immutable-once-
  recorded trigger. New MCP previews persist exact page/node/max-size options,
  dimensions, renderer backend, warnings, and PNG SHA-256 after authorization,
  ownership, expiry, and lifecycle rechecks inside `BEGIN IMMEDIATE`. Exact HTTP
  and MCP resources reuse those options, reject overrides, verify renderer/font
  versions plus backend/dimensions/SHA-256, and reserve `mode=adhoc` for explicit
  non-exact rendering. Deterministic source-built schema 1 and schema 7–11
  fixtures previously migrated through schema 12 while
  preserving exact V1 document/operation bytes, IDs, snapshots, revision hash
  chains, legacy asset bytes, organization ownership, enterprise rows, and
  schema-11 render jobs; migration 12 creates no synthetic decision records.
  Focused schema-13 tests additionally upgrade a genuine schema-12 fixture with
  null legacy source/exact-preview fields. Current migration-14/15 tests preserve
  enterprise rows, add authentication and preview-render schema without
  fabricating historical state, and keep old render metadata null. The CLI now
  recognizes schema 15 and its complete suite passes 96/96.
- Added mutating portable project import behind an Organization Administrator
  boundary. Validation remains read-only; commit requires an idempotency key and
  supports preserve-ID conflict failure or deterministic clone remapping. V1/V2
  projects and product specifications rebase to local version 1, raster assets
  are normalized through the isolated worker, legacy assets stay quarantined,
  and migration 10 stores immutable source/target provenance and the ID map.
  Multipart bytes stream into private disk staging; ZIP entries are validated
  through bounded central/local metadata reads, descriptors, CRCs, flags,
  versions, types, sizes, duplicates, and trailing-data checks, then inflated
  one at a time in bounded 16 KiB chunks into private files rather than being
  retained as one request/archive buffer set.
- Added coherent design-system data-integrity checks across backup, import,
  restore, and migration. Backup verification validates pin ownership, exact
  immutable release identity including legitimately deprecated current pins,
  V2 head-to-pin equality, the exact implicit bundled-Foundation exception,
  historical V2 releases, and transitional V1 pins. V2 import atomically
  inserts only valid published local custom pin rows. Restore
  preserves the active pin only when it still contains every token/component
  used by historical content, otherwise returning structured
  `USED_TOKEN_REMOVED`/`USED_COMPONENT_REMOVED` diagnostics. Restore policy is
  durable in revision metadata and audit history, and migration backup
  eligibility includes later pin changes.
- Added strict canonical V2 documents plus deterministic V1 compatibility,
  backup-gated/idempotent active-head migration, immutable historical V1
  preservation, V2 rendering/lint/MCP/JSON/portable export, and strict V1/V2
  restore verification. The strict V1 corpus now covers every node/token kind,
  prototype action, RTL metadata, fractional geometry, and legacy assets;
  unsupported GIF/font/video/binary assets retain their IDs and metadata as
  non-rendered quarantine data rather than being dropped.
- Added product specifications, the 22-section planning workflow, design-system
  releases/pins/upgrades, source-backed typed component-contract authoring with
  immutable draft/publish/deprecate transitions and role-aware read-only catalogs,
  revision inspection, platform token exporters, Workspace Bridge
  inventories/handoffs, and the seven-stage Redesign Studio foundation. The
  revision-pinned inspect API/view now separates the pinned revision from the
  current head and presents integrity hashes, measurements, resolved tokens,
  assets, components, rules, acceptance criteria, implementation mappings,
  stable IDs, and JSON paths.
- Added canonical source-backed component versions. New versions capture an
  authorized immutable V2 revision as bounded detached state trees, persist
  canonical bytes and SHA-256, and may receive a server-generated opaque ID on
  first creation. Legacy null-source versions remain readable but cannot enter
  a new release. Browser authoring now selects real visible container roots and
  shows source hash/node-count status.
- Added exact pinned-release component insertion through
  `GET /api/designs/:id/component-library`,
  `POST /api/designs/:id/component-insertion-previews`, and MCP
  `design_system_component_insert_preview`. The server verifies the pinned
  release/source, hydrates transitive tokens, materializes deterministic
  archived/locked masters, creates and renders an exact prepared V2 preview,
  and commits only through ordinary `design_commit_preview`. Generic MCP
  operations reject the server-only `insert_component_instance` record.
  Asset-bearing sources remain blocked until content-hash copying exists, and
  property/slot overrides remain blocked where no visual binding model exists.
- Added a browser Components-tab insertion workflow over those same server
  contracts. It lists only the exact pinned release with source/asset blockers,
  requires a clean matching project head, lets the user choose component state,
  parent, absolute position where applicable, and instance name, renders the
  exact preview with diagnostics, result hash, persisted dimensions, and PNG
  SHA-256, and explicitly commits or
  discards it. Commit creates the ordinary immutable revision and reselects the
  inserted instance; no parallel browser-only mutation path exists.
- Added project design-system pin controls in the editor with stale-state
  clearing and loading/mutation guards. Assigning or upgrading a real pin now
  creates exactly one atomic synchronized V2 head revision; V1 heads remain
  unchanged. Schema-13 V2 upgrade previews materialize target tokens and
  verified component masters into an exact stored result snapshot; commit uses
  that stored snapshot without recalculation. Removed states, missing token
  dependencies, asset dependencies, legacy null sources, and unsupported
  property/slot bindings block the upgrade. Pin, revision, snapshot, audit,
  outbox, and preview rollback remains atomic.
- Restructured the editor into Pages/Layers/Components/Assets,
  Canvas/Prototype/Before-After, Design/Content/Component/Logic/Prototype/
  Accessibility, and activity/diagnostics/revision/handoff navigation. The
  Before-After archive comparison supports minimize/reopen and correct modal
  focus/inert/Escape behavior; components/assets navigate to their owning page.
  Its current editor/Administration browser gate passes 5/5,
  including real click-to-frame navigation without canonical document mutation
  and the guided policy form plus Expert JSON/YAML workflows.
- Added deterministic V2 enterprise lint for raw values, component states,
  hierarchy, accessibility, touch targets, prototype gaps, RTL, component
  lifecycle/contracts, and product-rule/entity links.
- Added immutable agent tasks, the `formaspec` MCP identity, `formaspec://`
  resources, a token-free loopback bridge, OS credential storage, automatic
  Codex configuration, the managed `formaspec` skill/plugin, and the mention
  `[@FormaSpec](plugin://formaspec@formaspec)`.
- Added task-scoped before/after proposal review with side-by-side and toggle
  modes, changed-node highlighting, diagnostics, exact PNG dimensions/SHA-256,
  exact commit, and atomic discard/preview expiry. Expired or unreadable
  previews clear stale approval controls, PNG failures offer Retry, and commit
  stays disabled until the persisted exact PNG loads successfully.
- Connected Workspace Bridge grants now load enforced repository exclusions,
  keep `generic-git` as a fallback detector, and automatically persist bounded
  path-free inventories through REST or the authorized local MCP bridge.
- Hardened automatic Codex reconnection so a stored grant is reused only when
  its bearer-only authorization context exactly matches the current managed
  least-privilege scope and project sets. Stale, missing, overbroad, malformed,
  or unavailable context rotates through one-time pairing without exposing the
  credential to Codex.
- Added bounded fail-closed framework-aware scanners for web, Android,
  iOS/Xcode, Flutter, React Native, and generic Git. Worktree pointer/back-
  reference validation, ancestor-swap defense, dual directory enumeration,
  nested-monorepo discovery, stable opaque IDs, and explicit depth/count/byte
  truncation plus exact implementation-authorized launch are covered by the
  37/37 Workspace Bridge suite.
- Added strict immutable implementation mappings through REST, MCP resources/
  tools, independent agent scopes, replayable events, and reviewed browser UI.
  Mapping creation accepts only exact V2 design IDs and opaque inventory entity
  IDs, derives source metadata from the active hash-pinned inventory, and pins
  the revision chain and product-specification/inventory integrity metadata.
- Added strict stage artifacts and readiness to all seven Redesign Studio
  stages. Artifact changes are immutable CAS revisions through REST/MCP/UI;
  forward transitions require reviewed evidence, approval/completion require
  approved evidence, and draft or blocked item outcomes fail closed. Browser
  assessment entry explicitly selects an active per-platform inventory, and
  future-state entry requires fully verified exact-revision mapping evidence.
- Added approval-gated selected-workspace Codex launch: grants bind to the exact
  central inventory, the final immutable transition must be `approved` →
  `implementing` with `start_implementation`, process creation
  uses the selected repository as exact `cwd`, `shell: false`, one secret-free
  task argument, and a minimal environment. POSIX process-group monitoring
  reacts to revocation, expiry, policy withdrawal, handoff closure, and
  inventory changes. Windows Job Object/equivalent containment remains open.
- Added migration-12 handoff execution decisions for plan approval,
  branch/worktree isolation, diff review, validation approval, commit approval,
  push authorization, and pull-request request/disposition. Each decision is
  append-only, kind-scoped, CAS/idempotency protected, audited, replayable, and
  exposed through REST, MCP, resources, and browser controls. Start derives the
  plan/isolation gates; completion derives all seven persisted dispositions and
  accepts only a summary. Plan approval requires `expectedPriorDecisionId`, so
  stale approval cannot silently supersede a newer denial.
- Added verified backups, 7/4/12 retention, preview-first pruning, support
  bundles, external launcher-pinned Docker/server planned-restore supervision,
  safety backups, maintenance/lock fencing, crash journals, whole-workflow
  capacity preflight, descriptor-pinned verify/download/restore bytes, and final
  credential revocation checks. Runtime verification rejects plugin, NFS,
  bind-backed, or aliased Docker volumes by inspecting driver/scope/options and
  distinct bounded absolute backing mountpoints. Health probes have absolute
  deadlines; unsafe launcher-lock paths fail closed; and planned pre-cutover
  resume/rollback worker failures restart and re-verify the unchanged API. This
  path is `HEALTHY_PLANNED_RESTORE_ONLY`. Added a separate explicit offline bundle
  path that descriptor-pins the verified host source, transfers only stdin to
  the isolated worker, performs full target/raster verification, captures an
  exact corrupt-safe forensic pre-state bundle, and then uses the ordinary
  verified cutover/revocation/readiness flow. Receive, whole-workflow, and
  forensic pre-copy capacity gates fail before unsafe disk use, and child
  stdout/stderr shares one combined 4 MiB budget by default. Focused process-
  runner coverage passes 5/5, including the 5-second SIGKILL fallback for a
  SIGTERM-resistant over-budget child. Forensic rollback restores bytes
  while keeping maintenance active and the API stopped; direct clear is
  rejected, and only a newly verified offline recovery may atomically take over
  that fence. Offline failures never auto-abort/restart the API, takeover keeps
  the predecessor durable until replacement preparation succeeds, and resumed
  takeover runs `offlinePrepare` plus the replacement worker under the current
  maintenance owner rather than the predecessor ID. Corrupt/
  non-SQLite abort attempts fail with structured `VALIDATION_FAILED`.
- Hardened the single Docker image into separate API and renderer services. The
  renderer is non-root, read-only, capability-free, network-disabled, bounded,
  and fails startup if production `/data` or `/backups` mounts are present.
- Added a deterministic 20-sample pinned-Chromium 1,000-node gate covering cold
  load, selection, gesture pacing/work, commit/autosave, history, preview
  validation, and full 1440×900 rendering; the historical schema-13 run passed
  every specified local budget and requires a schema-15 release-candidate rerun.
- Added a 20-step product-manager-to-backup-restore scenario whose historical
  schema-13 run passed, spanning
  the real browser prompt box, all 22 interview sections, scoped MCP pairing and
  task execution, multi-screen design, human/agent iteration, immutable
  history, portable export, verified stopped-database restore, restart, exact
  hashes/state, and PNG smoke.
- Added fail-closed unsigned macOS artifact-evidence tooling that verifies the
  checksum sidecar, package/BOM/payload/scripts, bundle and install-manifest
  identities, content/mode/symlink tree, packaged component linkage, bundled
  Node/Chromium runtimes, and exact workspace equality for every packaged
  `dist` tree and managed CLI asset. The retained schema-12 candidate passes that
  equality gate and a separate private extracted-runtime smoke without package
  installation. The same-host repeat exposed different outer PKG bytes despite
  identical payload/workspace trees; the tooling therefore records failed
  reproducibility and does not claim signature, notarization, scanning, legal
  approval, or lifecycle proof.
- Added deterministic unsigned Linux DEB/RPM source builders with pinned
  runtimes, hardened systemd API/renderer services, strict secret-free protocol
  registration, and data-preserving lifecycle scripts. Added a native-Windows-
  only WiX v4 MSI builder foundation that checks internally consistent caller-
  supplied service-host/WiX inputs, uses one cross-architecture UpgradeCode,
  copies verified payloads into private staging, minimizes the WiX environment,
  and bounds packaging commands. Its tests use fake PE/CFB/WiX fixtures; no
  trust anchor, extracted-MSI validation, or real WiX compile has occurred.
  Neither platform has
  release-qualified artifact or lifecycle evidence.

## Latest verified checkpoint changes

- Schema-15 delta: migration 15 persists immutable exact preview-render evidence
  and the CLI now recognizes the same migration level. The complete seven-
  package suite passes 840/840, launcher passes 225/225, all seven workspaces
  pass typecheck/build, editor/Administration E2E passes 5/5, release E2E passes
  1/1, focused preview integration passes 2/2, and macOS runtime-smoke contracts
  pass 11/11. Source inventory remains 52 MCP tools, 25 resources, and 108
  protected non-MCP routes. The schema-13 Chrome, Firefox/WebKit, Docker,
  recovery, visual, performance, and SBOM/license checkpoints remain historical
  and require schema-15 release-candidate reruns. Native installers, image/OS
  scans, hosted provenance, and real server-mode/off-site evidence remain open.
- Live exact-preview acceptance rendered
  `preview_dd4da6b79f5e4ddf8b3fd111094c5189` at 1440x900 with PNG SHA-256
  `ad356b73d742c7852a86a022f86d68928dae021ab6710bd7b1d852f7e048e26c`,
  committed version 1→2, completed the task, and proved exact 76,099-byte
  preview/revision JSON equality. Persisted result snapshot SHA-256
  `b84512db8bde0e1acdb8c1e8dbc81f6361530a54d880675e301a665a101292a5`
  and operation SHA-256
  `6ccf0226ccf0a59d6dbd3fd3ab62069c2a45fd522b5f5f9b5f842728428896be`
  both matched.
- Authorization: `enterprise-domain-http-routes.ts` and
  `workspace-handoff-service.ts` now preflight all four Repository Inventory
  routes; `operations-http-routes.ts` and `operations-service.ts` preflight
  backup prune-preview/commit, verify, and download; and
  `organization-policy-http-routes.ts` plus `organization-policy-service.ts`
  preflight policy update and audit-retention preview/commit/list. Their three
  real server-mode authorization suites cover eight tests and twelve routes.
- MCP handoff discovery: `handoff_list` uses bounded dedicated summaries and
  authorization-bound checksummed keyset cursors instead of returning full
  histories.
- Retained CI: the compatibility-named Docker workflow builds the runtime
  topology, runs Firefox/WebKit against that exact image, restores a copied
  verified bundle into an independent clean project, and retains three
  separate `NO-GO-*` artifacts. Workflow contracts prevent any of those gates
  from disappearing silently.
- Recovery runner: `scripts/ci-offhost-restore-smoke.mjs` fails closed on Docker
  endpoint overrides, untrusted Compose input, root execution, image drift,
  incomplete restore comparisons, and unverifiable cleanup. Its unit suite is
  7/7.
- Runtime packaging: `.dockerignore` excludes documentation, CI control files,
  scripts, and prior evidence from the runtime build context, so documenting an
  image no longer changes the image bytes.

## Verification evidence

| Gate | Result |
| --- | --- |
| Current schema-15 application/source gate | The seven-package suite passes 840/840: core 59, server 466, web 91, CLI 96, local bridge 20, Workspace Bridge 37, and installer 71. Launcher passes 225/225; all seven workspaces pass typecheck/build; editor/Administration passes 5/5; release E2E passes 1/1; preview integration passes 2/2; macOS runtime-smoke contracts pass 11/11. MCP/resource/route authorization remains 52/25/108 with zero uncovered. |
| Historical schema-13 application/source gate | Installed/link verification confirmed `drizzle-orm` 0.45.2. Application suites passed 678/678, launcher 212/212, and all seven workspaces passed typecheck/build. Audit had zero high/critical findings. This is historical, not schema-15 qualification. |
| Prior schema-12 package checkpoint | Core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, and installer 62/62 across 5 files passed. Coverage included all 51 then-registered MCP tools and all 106 then-protected routes with zero uncovered. This remains regression evidence, not current-source qualification. |
| Exhaustive event authorization | 7/7 focused policy and real-HTTP tests pass across exactly 18 event families. The matrix proves per-family agent scopes, human-role allowlists, project/organization/optional/control boundaries, task-only access without design access, denial of task/handoff/Redesign/admin events to design-only agents, Organization-Administrator-only connection/backup/audit families, SQL replay filtering before limits/bounds/cursors, live/replay parity, and closure after policy removal or revocation. |
| Typecheck | All seven buildable workspace packages passed |
| Production build | Core, server, web, CLI, local bridge, Workspace Bridge, and installer passed |
| Launcher | 225/225 passed |
| Enterprise editor and administration | Current targeted E2E passes 5/5. The broader schema-13 checkpoint remains historical and must be rerun at schema 15. |
| Exact preview acceptance | A 1440x900 persisted PNG was reviewed and committed version 1→2; the task completed; preview and revision JSON matched at 76,099 bytes; persisted PNG, snapshot, and operation hashes all matched. |
| Selection alignment | The historical schema-13 pre-0.45.2 Playwright checkpoint passed 12/12 within 0.75 CSS px; rerun at schema 15. |
| Revision inspect | The historical schema-13 pre-0.45.2 immutability E2E passed 1/1 after correcting the head-change fixture; rerun at schema 15. |
| Visual regression | The historical schema-13 pre-0.45.2 baselines passed 7/7; rerun at schema 15. |
| 1,000-node foundation | Validation 20.43 ms p95; apply 49.65 ms p95; preview persistence 134.43 ms p95; render 116.83 ms p95 |
| 1,000-node browser gate | The historical schema-13 pre-0.45.2 budget passed 1/1 (230.70/20.50/16.70/273.20/17.60/280.48/221.37 ms p95 metrics); rerun at schema 15. |
| Integrated release scenario | Current targeted release E2E passes 1/1. The historical schema-13 complete 20-step scenario passed 1/1 and still requires a schema-15 release-candidate rerun. |
| Historical migration/restore fixtures | Genuine schema 1 and schema 7–11 prefixes previously passed through schema 12. Current schema-14/15 tests preserve enterprise rows, add authentication and immutable preview-render schema without synthesizing historical values, and the focused migration/backup/restore/maintenance set passes 59/59. Same-image copied-bundle recovery remains historical schema-13 evidence. Broader server-mode/off-site/native restore evidence remains open. |
| Dependency/security gate | `drizzle-orm` moved from 0.44.7 to installed/linked 0.45.2 after GHSA-gpj5-g38j-94v9. Audit reports info 0, low 0, moderate 2, high 0, critical 0 across 416 dependencies; the remaining advisories are under active remediation. |
| Historical SBOM/license evidence | Exact schema-13 linked-tree evidence at `/private/tmp/formaspec-release-evidence-schema13-drizzle0452-20260721-current` reports 342 components and zero policy violations. SHA-256 values: `82794fb6d820633ba4687126f3668ab21f045c6ceb73cd7761d3abd48b204bf8` (`SHA256SUMS`), `2519a41a66f84120ed8db9d48c4ee6706d40faf7a279bca79fb74120c81aaf9a` (CDX), `d296b7340521a7f7854dc13fbf4b9e245d79e23ca7169da4146babb23eca52b0` (licenses). Local temporary `NO-GO`, not schema-15 or hosted provenance. |
| Retained-CI foundation | Repository-native workflows cover source, dependency audit, browser, Docker/egress/recovery, deterministic evidence, unsigned Linux, and non-installing macOS gates. The retained Docker, Firefox/WebKit, off-host recovery, and SBOM results are schema-13 historical evidence. No GitHub-hosted current run, current macOS package, or real Ubuntu artifact has been retained. |
| Reverse-proxy lifecycle | Controlled actual TCP sockets pass 1/1 for caller-header replacement, direct-peer denial, ambiguous identity/secret append rejection, canonical principal bootstrap, and restart-bound secret rotation. This is not real Nginx/TLS or public-network proof. |
| Unsigned macOS PKG checkpoint | `artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`, SHA-256 `9724f2874c520b5b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`, size 185,279,180 bytes, is retained historical unsigned evidence and was not installed. Its frozen package/runtime checks cover schema-12 health and the 51-tool/25-resource inventory. It predates migrations 13–15, exhaustive event authorization, revision-bound release reads, source-backed component authoring/library/insertion, exact preview-render evidence, and the 52-tool/108-route interface. The candidate-root checksum manifest and original evidence remain valid only for those frozen bytes. The preserved schema-11 and schema-10 candidates are older historical evidence. |
| macOS reproducibility diagnostic | Same-host repeat artifact SHA-256 `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0`, size 185,279,075 bytes, differs from the current checkpoint's outer PKG while retaining identical payload and workspace-tree hashes. Reproducibility therefore failed. The checksum-bound diagnostic summary SHA-256 is `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`. Chromium LGPL policy approval, signing, notarization, independent reproducibility, vulnerability scanning, and clean privileged native lifecycle proof remain open. |
| Compose | `docker compose config --quiet` passed |
| Historical dependency-linked Docker smoke | Project `formaspeccischema1369037dfc8a`, image `sha256:55601784007855ffac507b20c8025d64d9ca5f572eb9a2834a0fb239a30378a0`, reached schema 13, created design `document_c304f0d8e19d449fa450b335e79c182e` at revision `revision_b71067ccd8e548b1b5385c366dabb263`, and rendered PNG SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf` before/after restart. Egress and cleanup passed. Summary SHA-256 `8e0d3baa22b934f90d7e6f36022365a825f5b6457ca6bb6e51f993a1fb59caed`. |
| Historical dependency-linked cross-browser | The same schema-13 image passed Firefox/WebKit 12/12 with cleanup. Summary SHA-256 `a4c16b03a094abba6abd2144c9ed0af78684897c97956c77789526f57eb6f41c`. |
| Historical dependency-linked copied-bundle recovery | Schema-13 recovery from `formaspecdrsource8878ef1a23` to `formaspecdrtarget8878ef1a23` preserved design `document_34da61e488444c48b144646e778f7edc` at revision `revision_5da62614cff8498db21be8d9346eb34a`; bundle SHA-256 `3fcba430b476f1dc2ce943405af418a1b1fdc629876f1e8407b8cf5b725c2fef`. All comparisons/cleanup passed; summary SHA-256 `198f93aace5caf60f550e95436711b10107433acc7d85b9175fce8d4722dcc6d`. |
| Prior schema-12 Docker smoke | Disposable project `formaspeccischema118e2818fed6` previously passed migration-12 readiness, deterministic restart rendering, non-root/read-only/capability/egress boundaries, and cleanup. Its summary remains historical regression evidence at `/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json` (SHA-256 `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`). |
| Prior schema-12 cross-browser | The schema-12 image passed Firefox/WebKit alignment 12/12 once; its summary is `/private/tmp/formaspec-cross-browser-docker-20260721-final437-eventauth-sqlbounded-cli/summary.json` (SHA-256 `2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`). The immediately prior fit-sync image `sha256:544a1c72cecaaf335a750a0fd4775f03a11f185e90ad441b1503dfdfa1b8ddeb` remains valid historical stability evidence: it passed three consecutive 12/12 runs after initial fitting was made synchronous in `useLayoutEffect`; its main, `-repeat2`, and `-repeat3` summaries are byte-identical with SHA-256 `0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`. |
| Prior schema-12 offline recovery CLI evidence | A disposable worker/control stack recovered a schema-11 design/PNG from corrupt live SQLite, preserved forensic rollback, and validated persisted Compose identity through `formaspecctl`. The schema-12 copied-bundle summary remains historical at `/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json` (SHA-256 `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`). Server-mode, packaged native, real remote-host/TLS/off-site, and broader lifecycle evidence remain open. |
| Restore control | Maintenance inactive; no operation; no worker lock |
| Repository hygiene | `git diff --check` passed |

The foundation render remains a coarse service comparison only. The historical
schema-13 browser gate proves the 1440×900 Chromium budget locally; a schema-15 pinned cross-
platform release CI image and retained artifact history are still needed.

## Runtime and data-preservation evidence

The historical disposable Docker smoke verified schema 13, Playwright rendering
without fallback, a deterministic PNG hash, and exact design/version
persistence across API-only restart. The same image passed DNS/TCP/interface
egress denial, Firefox/WebKit 12/12, and source-to-clean-target copied-bundle
recovery with exact snapshot/revision/asset/render and SQLite integrity/foreign-
key equality. All disposable resources were cleaned up. This was run from local
source; it is not retained GitHub-hosted evidence, provenance, a vulnerability
scan, or independent reproducibility.

Earlier installed-volume evidence remains separately recorded: project
`miare courier app` was version 31 at revision
`revision_36dd0a2e4cdc4d35b1e1b4e50087ef59` through the schema-8 checkpoint.
That historical record is preservation evidence, not a substitute for broader
customer upgrade fixtures.

The launcher also refreshed its exact mode-`0600` Docker runtime binding,
started the local bridge, verified MCP `formaspec`, and reinstalled/verified the
managed FormaSpec integration without placing a bearer token in generated
Codex configuration.

## macOS release blockers

The retained pre-current-SSE-authorization schema-12 PKG was not installed. Its
original package integrity and private extracted-runtime smoke remain valid,
but it is not an artifact of the current source tree. The current verifier
reports expected event-authorization and project/revision-bound historical-
  release interface drift, migrations 13–15, source-backed component-library/
  insertion, session authentication, preview-render evidence, and canonical
  FormaSpec identity drift. Its
same-host repeat produced identical payload and
workspace-tree hashes but different outer PKG bytes, so reproducibility remains
failed. A frozen final candidate still requires:

1. An explicit Chromium/LGPL notice and artifact license-policy decision.
2. A real Developer ID Installer signature.
3. Apple notarization and stapling evidence.
4. Independent reproducibility evidence, including resolution of the observed
   same-host outer-PKG nondeterminism.
5. Retained dependency, native-binary, Chromium, and OS vulnerability scans.
6. Clean install, automatic-startup, protocol, upgrade, uninstall, and
   reinstall lifecycle proof.

## Additional enterprise evidence still required

- Freeze and rebuild the final macOS candidate, resolve its outer-PKG
  nondeterminism, then prove clean install/autostart/protocol/upgrade/uninstall/
  reinstall. Build and test Linux DEB/RPM artifacts
  on real targets. Supply and qualify the Windows service host, then produce/
  test the WiX MSI including SCM,
  DPAPI/ACL, named-pipe/Chromium, Job Object/equivalent process-tree, protocol,
  signing, and clean lifecycle behavior.
- Qualify deployment-specific server-mode external planned/offline restore,
  installed backup scheduling, external alert delivery, real remote-host/off-
  site policy, and long-duration recovery. Managed-
  ID restore remains `HEALTHY_PLANNED_RESTORE_ONLY`; explicit offline recovery
  is implemented with stdin-only pinned transfer, corrupt-safe forensic
  pre-state capture, full target verification, standard credential revocation,
  bounded capacity/output handling, and fenced non-ready forensic rollback. The
  production worker/control path has disposable evidence, but isolated top-
  level CLI and server-mode lifecycle proof remain open. Approve a signing and
  key-management design because backup hashes prove consistency, not authorship.
- Complete the cross-platform browser/visual and broader authorization/security,
  decompression, and secret-exclusion matrices; add real connected-agent prompt-
  data approval-flow evidence and retained hosted/native renderer-egress runs;
  rerun the passing performance and 20-step release scenarios in retained,
  pinned release CI environments.
- Retain larger adversarial, concurrent-import, sustained-resource, and
  packaged cross-platform evidence for the implemented portable-import path.
  Multipart bodies now stream to private disk and entries inflate one at a time
  into private files; individual JSON/raster entries are read under the 64 MiB
  per-entry cap when parsed or normalized.
- Complete property-to-node and slot-anchor binding semantics, safe content-
  hash asset copying, and broader component-library accessibility, stale-head,
  conflict, backup, portable-export/import, and restore evidence around the
  implemented exact browser/MCP insertion flow. Complete richer design-system
  release authoring and visual upgrade comparison around the implemented
  project pin controls and atomic V2 head sync. Add
  automatic mapping suggestions, incremental rescans, portable mapping round
  trips, and broader tamper/role/browser coverage around the implemented seven-
  decision handoff gate and selected-workspace Codex launch. Run the strict
  seven-stage Redesign artifacts/readiness and mapping-evidence path against
  full real repository/design/handoff browser fixtures and the independent
  permission/revocation matrix. Path-free inventory persistence and explicit
  mapping creation already work through the authorized local MCP bridge.
- Run and retain the repository-native workflows on GitHub-hosted runners,
  build real Ubuntu DEB/RPM artifacts, then produce artifact-specific container/
  Windows/Linux SBOMs, vulnerability scans, and retained release provenance.
  Replace or explicitly constrain the local-filesystem
  check-then-rename cutover race where Node lacks a portable atomic
  no-replacement directory rename primitive.

## Operator handoff

### Local evaluation

Docker mode installs prerequisites inside the containerized runtime:

```bash
./designer --yes install docker
./designer --yes start docker --no-open
./designer doctor docker --strict
./designer status
```

Source-local mode remains a development path and requires Node.js 24 plus
pnpm 11:

```bash
./designer --yes install local
./designer start local --no-open
./designer doctor local --strict
```

Do not install the unsigned macOS PKG as a production release. It is retained
only as a non-installed engineering checkpoint.

### Server deployment

Generate and review strict server-mode configuration, configure the documented
HTTPS reverse-proxy identity/header/hop-secret boundary, then start the pinned
Compose topology:

```bash
./designer server init --public-url https://design.example.com
./designer start server
./designer doctor server --strict
```

The reverse proxy and recovery requirements are authoritative in
[`SERVER_DEPLOYMENT.md`](./SERVER_DEPLOYMENT.md) and
[`deployment.md`](./deployment.md). No real TLS/reverse-proxy production
qualification is claimed by this checkpoint.

### Supported Codex connection

```bash
./designer --yes agent connect codex --pairing-nonce <nonce> [--connection-id <id>]
```

Administration supplies the short-lived one-time pairing nonce. This performs
the single explicit authorization, starts/verifies the loopback
bridge, installs the credential-free `formaspec` MCP configuration and managed
FormaSpec skill/plugin, and retains the upstream grant in the operating-system
credential store. In Codex, use one of:

- `Use FormaSpec`
- `Design this with FormaSpec`
- `Refine this selection with FormaSpec`
- `[@FormaSpec](plugin://formaspec@formaspec)`

### Backup and restore

Create, list, and independently verify a bundle:

```bash
pnpm formaspecctl -- backup create
pnpm formaspecctl -- backup list
pnpm formaspecctl -- backup verify /safe/path/formaspec-backup.tar
```

Source-local restore requires explicit approval:

```bash
pnpm formaspecctl -- backup restore /safe/path/formaspec-backup.tar --yes
```

Launcher-recorded Docker/server recovery uses either a healthy managed backup
ID or the separately authorized offline path:

```bash
pnpm formaspecctl -- backup restore --backup-id backup_<id> --yes
pnpm formaspecctl -- backup restore offline /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore status
```

The exact safety, resume, rollback, and forensic-fence semantics are documented
in [`BACKUP_AND_RESTORE.md`](./BACKUP_AND_RESTORE.md).

### Compatibility, migrations, and modified subsystems

- Strict V1 read/import and immutable historical revisions remain supported;
  V2 is separate and V1→V2 migration preserves stable IDs. Current database
  migration level is 15. Existing legacy columns/history remain in the
  expand/verify window.
- Verify a backup before migration or restore. Packaged native arbitrary-bundle
  restore fails closed until native supervision is implemented.
- Major modified subsystems are `packages/core/`; `apps/server/`; `apps/web/`;
  `apps/cli/`, `apps/local-bridge/`, and `apps/workspace-bridge/`;
  `apps/installer/` and `designer`; Docker/CI/release scripts; native packaging
  workflows; and the documentation/status/evidence tree. The per-requirement
  source and test mapping is authoritative in
  [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md).

Detailed evidence and phase-by-phase limitations remain authoritative in
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) and
[`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). The exact unsigned package
evidence and its five release blockers are recorded in
[`MACOS_PKG_EVIDENCE.md`](./MACOS_PKG_EVIDENCE.md).

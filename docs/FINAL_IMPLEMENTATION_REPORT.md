# FormaSpec enterprise upgrade implementation report

Report date: 2026-07-21

Release decision: **NO-GO for enterprise production**

## Executive result

The repository has advanced from the Minimal UI MVP into a substantial
FormaSpec enterprise foundation without rewriting the working V1 application
or discarding existing projects, revisions, assets, launcher state, or Docker
volumes. The product remains usable for local evaluation and continued
development, including automatic Codex connection through the Minimal UI
alias.

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
advanced product/design-system workflows remain release blockers. The current
source-workspace permissive-only license gate passes with 342 third-party
components and zero policy violations.

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
  MCP now has an executable 51-tool/25-resource contract with strict bounded
  inputs, exact correlated nested success DTOs, strict structured errors,
  annotation checks, static scope probes, and scoped-resource probes. Bounded
  generic JSON remains only in `error.details`; temporary-ID previews mirror
  the strict canonical operation union across all ten variants. `handoff_list`
  now returns dedicated bounded summaries with authorization-bound checksummed
  keyset cursors instead of materializing full histories. A separate
  declarative manifest plus build-time route collector now closes the actual
  protected non-MCP surface at exactly 106 routes (52 project, 48 organization,
  six explicit exceptions). Project-scoped task listing now authorizes the
  requested design before querying and has direct HTTP no-leak/no-mutation
  tests. Generated authentication probes and direct behavioral evidence now
  cover all 106 protected routes with zero uncovered, including role/scope,
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
  it cannot be silently removed. The exact-current image failed closed with
  DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and zero external interfaces.
- Added focused prompt-injection-data regressions proving prompt-like design,
  product-specification, and repository-inventory text stays bounded data and
  cannot create task/archive side effects or expand authority. Real connected-
  agent semantic-resistance and approval-flow evidence remains open.
- Added content-addressed Brotli snapshots, revision hash chains, exact
  persisted previews, atomic CAS commits, durable idempotency, and numbered
  schema migrations through version 12. Migration 11 adds API-owned persistent
  render/raster-normalization job state with owner leases, heartbeats,
  expired-owner recovery, bounded hash/version/dimension/warning/error metadata,
  organization/internal scope separation, and permit-guarded exact 30-day
  terminal-record retention. The renderer remains database-free and job rows
  contain no document/image bytes or paths. Startup and backup/restore
  validation fail closed when migration-9/10/11/12 ledger rows exist without
  the required schema objects, normalized SQL, or forbidden-trigger removal.
  Migration 12 adds append-only, independently authorized handoff execution
  decisions with CAS/lifecycle integrity triggers. Deterministic source-built
  schema 1 and schema 7–11 fixtures now migrate through schema 12 while
  preserving exact V1 document/operation bytes, IDs, snapshots, revision hash
  chains, legacy asset bytes, organization ownership, enterprise rows, and
  schema-11 render jobs; migration 12 creates no synthetic decision records.
  The CLI now recognizes schema 12 for status, backup/restore compatibility,
  and support-bundle reporting.
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
  releases/pins/upgrades, typed component-contract authoring with immutable
  draft/publish/deprecate transitions and role-aware read-only catalogs,
  revision inspection, platform token exporters, Workspace Bridge
  inventories/handoffs, and the seven-stage Redesign Studio foundation. The
  revision-pinned inspect API/view now separates the pinned revision from the
  current head and presents integrity hashes, measurements, resolved tokens,
  assets, components, rules, acceptance criteria, implementation mappings,
  stable IDs, and JSON paths.
- Added project design-system pin controls in the editor with stale-state
  clearing and loading/mutation guards. Assigning or upgrading a real pin now
  creates exactly one atomic synchronized V2 head revision; V1 heads remain
  unchanged, existing V1 pins survive migration, and rollback covers the pin,
  revision, snapshot, audit, outbox, and preview state.
- Restructured the editor into Pages/Layers/Components/Assets,
  Canvas/Prototype/Before-After, Design/Content/Component/Logic/Prototype/
  Accessibility, and activity/diagnostics/revision/handoff navigation. The
  Before-After archive comparison supports minimize/reopen and correct modal
  focus/inert/Escape behavior; components/assets navigate to their owning page.
  Its focused editor/prototype/administration browser gate passes 3/3,
  including real click-to-frame navigation without canonical document mutation
  and the guided policy form plus Expert JSON/YAML workflows.
- Added deterministic V2 enterprise lint for raw values, component states,
  hierarchy, accessibility, touch targets, prototype gaps, RTL, component
  lifecycle/contracts, and product-rule/entity links.
- Added immutable agent tasks, the `formaspec` MCP identity, `formaspec://`
  resources, a token-free loopback bridge, OS credential storage, automatic
  Codex configuration, the managed `minimal-ui` skill/plugin, and the mention
  `[@Minimal UI](plugin://minimal-ui@formaspec)`.
- Added task-scoped before/after proposal review with side-by-side and toggle
  modes, changed-node highlighting, diagnostics, exact PNG access, exact commit,
  and atomic discard/preview expiry.
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
  validation, and full 1440×900 rendering; every specified local budget passes.
- Added a passing 20-step product-manager-to-backup-restore scenario spanning
  the real browser prompt box, all 22 interview sections, scoped MCP pairing and
  task execution, multi-screen design, human/agent iteration, immutable
  history, portable export, verified stopped-database restore, restart, exact
  hashes/state, and PNG smoke.
- Added fail-closed unsigned macOS artifact-evidence tooling that verifies the
  checksum sidecar, package/BOM/payload/scripts, bundle and install-manifest
  identities, content/mode/symlink tree, packaged component linkage, bundled
  Node/Chromium runtimes, and exact workspace equality for every packaged
  `dist` tree and managed CLI asset. The current schema-12 candidate passes that
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
| Focused package checkpoints | Core 47/47 across 8 files, server 437/437 across 78 files, web 69/69 across 17 files, CLI 89/89 across 9 files, local bridge 18/18 across 2 files, Workspace Bridge 37/37 across 4 files, and installer 62/62 across 5 files passed. Coverage includes exact nested success DTOs and bounded discriminated inputs across all 51 MCP tools, generated full-surface authentication rejection, direct behavioral authorization on all 106 protected routes with zero uncovered, real HTTP SSE grant/revocation behavior, exact implementation mappings, seven-gate handoff decisions, Redesign authorization/source-evidence gating, implementation-authorized launch, automatic stale managed-grant rotation, duplicate effective trusted-identity rejection, strict native state-path resolution, design-system integrity, genuine historical migration fixtures, project-scoped authorization, editor/administration behavior, scanner hardening, Chromium/Unix-socket rendering, portable streaming, offline recovery, bounded processes, and proxy-hop-secret behavior. Linux/Windows packaging coverage remains source/fixture evidence, not native lifecycle proof. |
| Exhaustive event authorization | 7/7 focused policy and real-HTTP tests pass across exactly 18 event families. The matrix proves per-family agent scopes, human-role allowlists, project/organization/optional/control boundaries, task-only access without design access, denial of task/handoff/Redesign/admin events to design-only agents, Organization-Administrator-only connection/backup/audit families, SQL replay filtering before limits/bounds/cursors, live/replay parity, and closure after policy removal or revocation. |
| Typecheck | All seven buildable workspace packages passed |
| Production build | Core, server, web, CLI, local bridge, Workspace Bridge, and installer passed |
| Launcher | 212/212 passed after proxy-secret lifecycle hardening |
| Enterprise editor and administration | 3/3 browser checks passed for the four navigation sections, three central workspaces, six inspector sections, activity/diagnostic/revision/handoff area, click-to-frame prototype navigation without canonical mutation, and the guided 12-section policy form with Expert JSON, YAML export, and optimistic hash updates |
| Selection alignment | 12/12 fresh Playwright checks passed at DPR 1/2 across 12/25/50/100/149/150/200/320% zoom, positive/negative fractional pan, LTR/RTL/mixed, normalized uploaded image, selectable frame/ellipse, rotated single/multi-selection, hidden/locked exclusion, nested scroll plus actual delayed-font/image invalidation, exact fractional group drag, vertical/wrapped/grid reorder/reparent, and 149% auto-layout resize, staying within 0.75 CSS px |
| Revision inspect | 1/1 immutability E2E passed: the pinned revision remained exact after the project head changed and continued to expose engineering evidence |
| Visual regression | 7/7 baselines passed: desktop, phone, tablet, Persian RTL, typography, clipping, image |
| 1,000-node foundation | Validation 20.43 ms p95; apply 49.65 ms p95; preview persistence 134.43 ms p95; render 116.83 ms p95 |
| 1,000-node browser gate | All budgets passed over the fresh 20-sample run: 225.90 ms p95 load; 21.10 ms p95 selection; 16.70 ms gesture p95 and maximum; 255.00 ms p95 commit/autosave; 16.10 ms p95 history; 205.02 ms p95 preview validation; 217.78 ms p95 for the 1440×900 pinned-Chromium render |
| Integrated release scenario | 1/1 Playwright project passed the complete 20-step PM→MCP→human correction→history→export→backup/restore/restart scenario after stale migration-11 assertions were corrected to migration 12 |
| Historical migration/restore fixtures | Genuine schema 1 and schema 7–11 prefixes are source-built from the production migration ledger, locked by reviewed schema/data digests, and pass focused migration plus verified-backup restore coverage through schema 12. A tampered V1 revision fails atomically before migration 2 is recorded. |
| Release evidence | Current deterministic source evidence passes with 342 installed third-party components and zero policy violations. |
| Retained-CI foundation | Five repository-native, least-privilege workflows cover frozen source gates, a retained-JSON high-severity dependency audit, Chromium plus Firefox/WebKit alignment, Chromium visual/performance/release suites, schema-12 Docker smoke, an in-container DNS/direct-TCP/non-loopback renderer-egress canary, exact-built-image Firefox/WebKit smoke, same-image copied-bundle recovery, deterministic source evidence, unsigned Linux packages, and a main/manual non-installing macOS extracted-runtime gate. Workflow contract tests pass 8/8, cross-browser runner tests pass 2/2, off-host simulation tests pass 7/7, release-evidence tests pass 8/8, macOS package-evidence tests pass 12/12, and macOS runtime-smoke tests pass 10/10. The exact-current image passed the Docker, Firefox/WebKit 12/12, and copied-bundle recovery gates locally; the immediately prior fit-sync image contributes three identical 12/12 repeats as historical browser-stability evidence. No GitHub-hosted audit/cross-browser/recovery/native-package run or real Ubuntu artifact has yet been retained. |
| Reverse-proxy lifecycle | Controlled actual TCP sockets pass 1/1 for caller-header replacement, direct-peer denial, ambiguous identity/secret append rejection, canonical principal bootstrap, and restart-bound secret rotation. This is not real Nginx/TLS or public-network proof. |
| Unsigned macOS PKG checkpoint | `artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`, SHA-256 `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`, size 185,279,180 bytes, is the retained pre-current-SSE-authorization unsigned engineering checkpoint. It was not installed. Its frozen source evidence passes with 342 components and zero violations; original package integrity passes with 349 components, seven exact workspace trees, two bundled runtimes, payload-tree SHA-256 `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`, and workspace-tree SHA-256 `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`. The retained non-installing extracted-runtime smoke passed Node v24.14.0, Chromium headless shell revision 1228, schema-12 health, real PNG rendering, exact 51-tool/25-resource MCP inventory, native state paths, cleanup, and unchanged install targets/receipts; its summary SHA-256 is `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`. The current verifier records expected drift because packaged `apps/server/dist` predates the exhaustive event-authorization policy and the project/revision-bound historical design-system release interface. The candidate-root `SHA256SUMS` binds all 14 retained files after updating only the README entry. The preserved schema-11 and schema-10 candidates are older historical evidence. |
| macOS reproducibility diagnostic | Same-host repeat artifact SHA-256 `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0`, size 185,279,075 bytes, differs from the current checkpoint's outer PKG while retaining identical payload and workspace-tree hashes. Reproducibility therefore failed. The checksum-bound diagnostic summary SHA-256 is `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`. Chromium LGPL policy approval, signing, notarization, independent reproducibility, vulnerability scanning, and clean privileged native lifecycle proof remain open. |
| Compose | `docker compose config --quiet` passed |
| Exact-current Docker smoke | Disposable project `formaspeccischema118e2818fed6`, built from source identity `local-uncommitted-final437-eventauth-sqlbounded-cli`, reached migration 12 Playwright-worker readiness and backup-supervision health without fallback; created design `document_0e6b4b61e3964110b9a4533ef2a63398` at revision `revision_aea2807b70cb4c8c9b6588c191de0218`; rendered a 512×339 PNG with SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`; restarted only the API; recovered the same design/version; and rerendered the exact same hash. API and renderer used identical image `sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`; both ran as non-root `pwuser` with read-only roots, dropped capabilities, no-new-privileges, and resource bounds. The renderer used `network_mode: none`, mounted only `/run/formaspec`, and failed the egress canary closed with DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and zero external interfaces. Cleanup was complete. The local `NO-GO` summary is `/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json` (SHA-256 `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`); it is not retained CI or provenance proof. |
| Exact-current cross-browser | The exact-current image passed Firefox/WebKit alignment 12/12 once; its summary is `/private/tmp/formaspec-cross-browser-docker-20260721-final437-eventauth-sqlbounded-cli/summary.json` (SHA-256 `2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`). The immediately prior fit-sync image `sha256:544a1c72cecaaf335a750a0fd4775f03a11f185e90ad441b1503dfdfa1b8ddeb` remains valid historical stability evidence: it passed three consecutive 12/12 runs after initial fitting was made synchronous in `useLayoutEffect`; its main, `-repeat2`, and `-repeat3` summaries are byte-identical with SHA-256 `0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`. |
| Exact-current offline recovery CLI evidence | A disposable unique-Compose worker/control stack verified a schema-11 bundle, recovered an exact design/PNG from corrupt live SQLite, revoked one grant/connection/nonce, and preserved exact forensic rollback evidence. A subsequent real unique-project `formaspecctl` smoke validated persisted Compose identity through the end-to-end CLI. Image `sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f` then passed a same-machine copied-bundle simulation from source project `formaspecdrsourcede20d670cd` into clean target `formaspecdrtargetde20d670cd`, preserving design `document_9989d40c2c194b5dafb7f7da08bfc4b9` at revision `revision_3b6cbf1a84f5421b9f57c370d4541db2` with exact snapshot/revision/asset/render equality. Bundle SHA-256 was `f12887796030081d495ef3b266abf7b22f58cdb01fbe494072171e57ce73bfcc`; SQLite integrity/foreign-key checks, local Docker-context and non-root runtime proof, and complete cleanup passed. Its local `NO-GO` summary is `/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json` (SHA-256 `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`). Product semantics reject direct fence clearing; the earlier smoke's manual cleanup clear was disposable cleanup only. Server-mode proxy, packaged native lifecycle, real remote-host/network/TLS/off-site storage, and broader lifecycle evidence remain open. |
| Restore control | Maintenance inactive; no operation; no worker lock |
| Repository hygiene | `git diff --check` passed |

The foundation render remains a coarse service comparison only. The separate
browser gate proves the 1440×900 Chromium budget locally; a pinned cross-
platform release CI image and retained artifact history are still needed.

## Runtime and data-preservation evidence

The fresh disposable Docker smoke verified schema 12, Playwright rendering
without fallback, a real deterministic PNG hash, and exact design/version
persistence across API-only restart. It also verified an identical API/renderer
image ID, the two-service user/filesystem/capability/resource boundaries,
renderer `network_mode: none` with only `/run/formaspec` mounted, and complete
disposable project cleanup. This was run from local uncommitted source; it is not
a retained GitHub-hosted run, provenance signature, vulnerability scan, or
independent reproducibility result.

Earlier installed-volume evidence remains separately recorded: project
`miare courier app` was version 31 at revision
`revision_36dd0a2e4cdc4d35b1e1b4e50087ef59` through the schema-8 checkpoint.
That historical record is preservation evidence, not a substitute for broader
customer upgrade fixtures.

The launcher also refreshed its exact mode-`0600` Docker runtime binding,
started the local bridge, verified MCP `formaspec`, and reinstalled/verified the
managed Minimal UI integration without placing a bearer token in generated
Codex configuration.

## macOS release blockers

The retained pre-current-SSE-authorization schema-12 PKG was not installed. Its
original package integrity and private extracted-runtime smoke remain valid,
but it is not an artifact of the current source tree. The current verifier
reports expected event-authorization and project/revision-bound historical-
release interface drift. Its
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
- Complete richer design-system release authoring and visual upgrade comparison
  around the implemented project pin controls and atomic V2 head sync. Add
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
./designer --yes agent connect codex
```

This performs the single explicit authorization, starts/verifies the loopback
bridge, installs the credential-free `formaspec` MCP configuration and managed
Minimal UI skill/plugin, and retains the upstream grant in the operating-system
credential store. In Codex, use one of:

- `Use FormaSpec`
- `Use Minimal UI`
- `Design this with FormaSpec`
- `[@Minimal UI](plugin://minimal-ui@formaspec)`

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
  migration level is 12. Existing legacy columns/history remain in the
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

# FormaSpec release checklist

Last updated: 2026-07-20

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

Current verification on 2026-07-20 passed 393 tests: 40 core, 230 server, 30
web, 49 CLI, 12 local bridge, 9 Workspace Bridge, and 23 installer.
All seven workspace typechecks and production builds, 164 launcher tests, 6/6
Chrome DPR alignment/auto-layout/inspect tests, 7/7 visual baselines, the 1/1 20-step
release E2E, the 1/1 1,000-node browser gate, source evidence with 342
third-party components and zero violations, exact macOS-PKG integrity
verification, `docker compose config --quiet`, and `git diff --check` also
passed. The separate disposable recovery exercise below proves one local Docker
recovery path but not the complete enterprise release matrix.

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
- [x] Auto-layout drag/resize semantics are browser-tested at DPR 1/2: reorder,
  cross-container reparent, and fill/hug-to-fixed resize commit one normalized
  command without writing x/y or losing fractional geometry/rotation.
- [x] The deterministic 1,000-node service harness and 20-sample pinned-
  Chromium browser gate exist; all specified local interaction and render
  budgets pass without software fallback.
- [ ] Numbered database migrations pass clean install and legacy upgrade.
- [x] Startup, backup verification, restore preflight, and restore control fail
  closed when migration-9/10 ledger rows lack required tables, columns, indexes,
  triggers, trigger SQL, or forbidden-trigger removal.
- [ ] Legacy data is backfilled into one organization without ID loss.
- [ ] Role/scope/project/expiry/revocation authorization matrix passes for
  REST, SSE, MCP, assets, previews, revisions, and contexts.
- [ ] Local mode binds to loopback and ignores proxy identity headers.
- [ ] Server mode fails closed without HTTPS/public URL, trusted proxy ranges,
  Host/Origin allowlists, identity mapping, CSRF/CSP/security headers, and MCP
  auth.
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
- [x] Backup verifier focused tests cover strict manifests/checksums, exact
  asset-manifest/file matching, normalized asset and legacy BLOB integrity,
  canonical snapshots, typed operations, revision hash chains, contiguous
  history, and exact project heads.
- [x] Externally supervised launcher-local Docker restore foundations and
  focused tests cover maintenance fencing, opaque backup IDs, verified safety
  backup, closed-database journaled cutover, deterministic renderer smoke,
  audit/outbox reconciliation, restored-agent revocation, status/resume, and
  eligible rollback behavior. They also cover the exact mode-`0600` Docker
  runtime binding, shared non-expiring worker lock, durable `prepared` /
  `cutover_committed` / `reconciled` / `rolled_back` states, safe abort, and
  proven-stale-lock clearing.
- [x] A disposable local-Docker backup-A/mutate-B/restore-A/restore-safety-B
  exercise passes with original design/revision IDs and restored credential
  revocation, using the exact IDs recorded in Baseline evidence.
- [ ] Expand the Docker/server exercise to the full recovery matrix: normalized
  and legacy assets, design-system data, historical customer fixtures, failure
  injection, reconnect/revocation lifecycle, and cross-platform artifact
  comparison.
- [x] The isolated 20-step Playwright scenario covers browser-created product
  context, backup-gated V1→V2 migration, all 22 planning sections, a scoped MCP
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
- [ ] Server mode has a tested deployment-specific external supervisor for
  locking, maintenance, API/renderer lifecycle, safety backup, restore,
  verification, rollback, alerting, and recovery after interruption.
- [ ] Scheduled backup execution, retention failure recovery, off-host storage,
  and the 7/4/12 policy pass release scenarios.
- [ ] No critical or high security finding remains.

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
  preview tests pass.
- [x] Product specification natural-language/structured synchronization passes.
- [x] All 22 interview sections persist, resume, edit, and version correctly in
  service/integration tests and in the integrated browser release E2E.
- [ ] Enterprise editor navigation and panels pass browser E2E/accessibility.
- [x] Revision-pinned inspect API/view remains on the requested immutable
  revision when the project head changes and exposes integrity hashes, resolved
  tokens, assets, components, rules, acceptance criteria, implementation
  mappings, stable IDs, and JSON paths. The current 6/6 browser run passes;
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
  transactional rollback, immutable migration-10 provenance, and the current
  focused/integration rerun pass.
- [x] Portable ZIP parsing rejects mismatched central/local headers,
  descriptors, CRCs, unsupported flags/features/types, symlinks/directories,
  duplicate/overlapping entries, false sizes, empty/trailing compressed data,
  and limit overflows before bounded 16 KiB per-entry streaming inflation.
- [ ] Stream the multipart request body and avoid retaining all extracted entry
  buffers simultaneously; add larger adversarial, concurrent-import, and
  packaged cross-platform evidence.
- [x] DTCG and bounded platform token exporters pass golden tests.

## Phase 3 gate

- [x] MCP server ID is `formaspec`, display name is Minimal UI, resources use
  `formaspec://`, and the safe workflow is self-contained in the first 512
  instruction characters.
- [ ] Every MCP tool has a strict schema, correct annotations, and scoped
  authorization.
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
- [x] Initial web, Android, iOS/Xcode, Flutter, and React Native detectors pass
  bounded fixtures; `generic-git` is used only when no specific platform is
  detected. Rich framework-aware semantic scanners remain open.
- [x] A connected grant automatically persists its bounded path-free inventory
  through REST or the authorized token-free MCP bridge. Direct REST still
  requires a compatible API identity/bearer channel in trusted-header setups.
- [ ] Design/spec/source mappings are pinned and inspectable.
- [ ] Handoff launch uses a secret-free task reference and selected local
  workspace only.
- [ ] Plan, branch/worktree, diff, validation, commit, push, and PR permissions
  are independently enforced and audited.
- [ ] Seven redesign stages are resumable and reuse canonical spec/system/task/
  handoff primitives.
- [ ] “One click” creates assessment/planning only and never modifies source.
- [ ] Assessment, proposal, design, handoff, and implementation grants are
  independently revocable.

## Phase 6 delivery gate

- [x] Strict versioned organization-policy read/update, Administration JSON
  editing, MCP read/resource, secret-free YAML export, repository/agent/asset/
  backup/export enforcement, and exact backup binding pass focused tests.
- [x] Organization-admin audit retention uses an exact expiring preview,
  minimum-policy cutoff, restart-safe idempotency, atomic guarded deletion,
  replay gaps, and immutable hash-chained evidence.
- [ ] Complete form-based organization administration, delegated policy roles,
  scheduled retention supervision/alerting, policy rollout/migration, and the
  exhaustive browser/HTTP/MCP matrix pass.
- [ ] Self-contained `formaspecctl` commands pass clean-system tests.
- [ ] `designer` migrates legacy state and delegates without data loss.
- [ ] Release-ready macOS PKG, Windows WiX v4 MSI, and Linux DEB/RPM
  artifacts are produced and pass their platform gates.
- [ ] Clean install, automatic startup, upgrade, uninstall, reinstall, and
  protocol registration tests pass on each supported OS.
- [ ] Setup wizard completes agent authorization, backup destination, render
  verification, and health checks.
- [ ] The single `formaspec/server` image with two long-lived API/renderer
  services and the profiled one-shot restore worker passes non-root,
  capability, filesystem, migration, readiness, restart, restore, and egress
  tests.
- [x] A fresh disposable schema-10 Docker smoke reached Playwright-worker
  readiness without fallback, processed a real 1,303-byte PNG, preserved a
  project across API restart, verified both services as `pwuser` with read-only
  roots/capability drops/resource bounds, verified renderer `network_mode: none`
  and a digest-pinned base image, and removed the project and volumes.
- [x] Provider-neutral, offline, deterministic CycloneDX 1.6 source-workspace
  SBOM generation, approved-license reporting, notice hashes, checksum
  generation, stale-evidence checking, and focused tests exist.
- [x] The current Darwin ARM64 source workspace passes the permissive-only gate:
  342 third-party components, zero violations, and no Sharp/libvips dependency.
- [x] The fresh unsigned macOS ARM64 PKG candidate at
  `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg` has current-
  tree offline evidence: SHA-256
  `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`,
  184,835,514 bytes, integrity `PASS`, 349 linked components, seven exact
  workspace trees, and two bundled runtimes.
- [ ] The macOS package passes the release gate. It remains blocked by Chromium
  LGPL-notice allowlist review, missing Developer ID signature, missing
  notarization, missing independent reproducibility evidence, and missing
  vulnerability scans—the same five blocker codes recorded for this candidate.
- [ ] Artifact-specific container, Windows, and Linux SBOMs; dependency/image/
  OS scans; reproducibility; signed provenance; and CI artifact retention
  exist.
- [ ] Signing/notarization uses real operator credentials or artifacts are
  clearly marked unsigned with exact operator steps.
- [ ] Documentation matches the release candidate and final report is generated
  from verified evidence.

## Release performance budgets

Representative projects must contain at least 1,000 nodes.

| Measurement | Required p95 / hard limit | Current evidence |
| --- | --- | --- |
| Initial interactive load | at most 2.5 seconds p95 | **Pass:** 232.8 ms p95, 20 cold samples |
| Selection response | at most 50 ms p95 | **Pass:** 20.8 ms p95, 20 samples |
| Gesture frames | at most 16.7 ms p95; no frame over 50 ms | **Pass:** 16.7 ms cadence-normalized p95 and 16.7 ms maximum across the measured gesture frames |
| Local commit/autosave | at most 500 ms p95 | **Pass:** 261.9 ms p95, 20 samples |
| History load | at most 1 second p95 | **Pass:** 19.0 ms p95, 20 samples |
| 1440 by 900 render | at most 5 seconds p95; 15-second hard timeout | **Pass:** 199.22 ms p95, pinned Playwright Chromium, no fallback/warnings |
| Preview validation excluding render | at most 1 second p95 | **Pass:** 216.65 ms p95, 20 samples; no render endpoint invoked |

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
- [ ] Prompt-like design/spec/repository text remains data and cannot expand
  authority.
- [ ] Renderer egress canary cannot resolve or connect externally.
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
- [x] Selection controls remain within 0.75 CSS px in the current Chrome DPR 1/2 matrix.
- [x] Concurrent same-base writes yield one success/one conflict.
- [x] Retried commits create no duplicate revision.
- [x] Persisted previews survive restart until expiry.
- [ ] Backup restore reproduces all required data.
- [ ] Repository analysis occurs before redesign proposals.
- [ ] Repository files are unchanged without an approved plan.
- [x] Product manager can initiate a redesign assessment from the website.
- [ ] Engineer can inspect exact pinned tokens/components/assets/rules/mappings.
- [x] Renderer cannot access external network in the verified Docker topology (`network_mode: none`).
- [x] Production application and renderer do not run as root in the verified Docker image.
- [x] Representative 1,000-node budgets pass.
- [ ] No critical/high security defects remain.
- [x] Source-workspace production dependencies comply with the approved
  license policy; the exact unsigned macOS PKG has separate fail-closed
  evidence, while container/Windows/Linux artifact evidence remains required.
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

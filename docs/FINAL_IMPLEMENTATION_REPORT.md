# FormaSpec enterprise upgrade implementation report

Report date: 2026-07-20

Release decision: **NO-GO for enterprise production**

## Executive result

The repository has advanced from the Minimal UI MVP into a substantial
FormaSpec enterprise foundation without rewriting the working V1 application
or discarding existing projects, revisions, assets, launcher state, or Docker
volumes. The product remains usable for local evaluation and continued
development, including automatic Codex connection through the Minimal UI
alias.

Production readiness is intentionally not declared. An exact self-contained
unsigned macOS ARM64 PKG and its offline artifact-specific integrity/SBOM
evidence now exist, but that artifact is not release-approved. Windows/Linux
installers, macOS signing/notarization and lifecycle proof, server-mode restore
supervision, signed backup provenance, the comprehensive security/cross-
platform browser matrices, vulnerability scanning and reproducibility, and
several advanced product/design-system workflows remain release blockers. The
source-workspace permissive-only license gate now passes.

## Implemented foundation

- Corrected canvas/Moveable coordinate handling with one viewport transform,
  an untransformed interaction overlay, geometry invalidation, memoized node
  rendering, and browser alignment tests at DPR 1 and 2. Single auto-layout
  children now reorder/reparent with one normalized `move_node` command and
  resize fixed/fill/hug constraints without writing absolute x/y.
- Added strict local/server security modes, organization/project
  authorization, scoped agent grants, append-only audit/outbox records,
  replayable events, archive-only destructive flows, normalized raster assets,
  and bounded renderer IPC.
- Added a strict versioned organization policy with Administration editing,
  REST/MCP reads, secret-free YAML export, exact backup binding, and enforcement
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
- Replaced Sharp/libvips with pinned Chromium raster normalization in the
  isolated renderer worker, including PNG/JPEG/WebP full decode, WebP/JPEG EXIF
  orientation, animation/MPO rejection, metadata stripping, deterministic PNG
  output, and versioned API/worker limit parity.
- Added content-addressed Brotli snapshots, revision hash chains, exact
  persisted previews, atomic CAS commits, durable idempotency, and numbered
  schema migrations through version 10. Startup and backup/restore validation
  now fail closed when migration-9/10 ledger rows exist without the required
  tables, columns, indexes, triggers, trigger SQL, or forbidden-trigger removal.
- Added mutating portable project import behind an Organization Administrator
  boundary. Validation remains read-only; commit requires an idempotency key and
  supports preserve-ID conflict failure or deterministic clone remapping. V1/V2
  projects and product specifications rebase to local version 1, raster assets
  are normalized through the isolated worker, legacy assets stay quarantined,
  and migration 10 stores immutable source/target provenance and the ID map.
  ZIP entries are validated against central/local metadata, descriptors, CRCs,
  flags, versions, types, sizes, duplicates, and trailing compressed data, then
  inflated in bounded 16 KiB chunks rather than aggregate `unzipSync`.
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
- Added verified backups, 7/4/12 retention, preview-first pruning, support
  bundles, external launcher-local Docker restore supervision, safety backups,
  maintenance/lock fencing, crash journals, whole-workflow capacity preflight,
  descriptor-pinned verify/download/restore bytes, and final credential
  revocation checks.
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
- Added an unsigned macOS ARM64 package plus offline artifact-specific evidence
  that verifies the checksum sidecar, package/BOM/payload/scripts, bundle and
  install-manifest identities, content/mode/symlink tree, packaged component
  linkage, bundled Node/Chromium runtimes, and exact workspace equality for
  every packaged `dist` tree and managed CLI asset. Missing, extra, tampered,
  or stale compiled files fail integrity without claiming signature,
  notarization, scanning, or reproducibility.

## Verification evidence

| Gate | Result |
| --- | --- |
| Workspace tests | 393 passed: 40 core, 230 server, 30 web, 49 CLI, 12 local bridge, 9 Workspace Bridge, and 23 installer |
| Typecheck | All seven buildable workspace packages passed |
| Production build | Core, server, web, CLI, local bridge, Workspace Bridge, and installer passed |
| Launcher | 164/164 passed |
| Selection alignment, auto-layout, and inspect | 6/6 Playwright tests passed, including DPR 1/2 alignment, reorder, cross-container reparent, constraint resize, canonical geometry preservation, and immutable revision inspection after head change |
| Visual regression | 7/7 baselines passed: desktop, phone, tablet, Persian RTL, typography, clipping, image |
| 1,000-node foundation | Validation 17.71 ms p95; 25 updates 36.18 ms p95; preview persistence 132.17 ms p95; 512×320 Playwright render 118.12 ms p95 |
| 1,000-node browser gate | All budgets passed over the final 20-sample run: 232.8 ms p95 load; 20.8 ms p95 selection; 16.7 ms gesture p95 and maximum; 261.9 ms p95 commit/autosave; 19.0 ms p95 history; 216.65 ms p95 preview validation; 199.22 ms p95 1440×900 pinned-Chromium render |
| Integrated release scenario | 1/1 Playwright project passed the complete 20-step PM→MCP→human correction→history→export→backup/restore/restart scenario |
| Release evidence | 8/8 focused tests passed; deterministic CycloneDX/license/checksum generation is byte-identical; 342 installed third-party components pass with zero policy violations |
| Unsigned macOS PKG evidence | Integrity verification passed for `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`, SHA-256 `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`, size 184,835,514 bytes. All 349 packaged components link; exactly seven workspace trees and two bundled runtimes are inventoried. Release remains `NO-GO` on the same five blocker codes. |
| Compose | `docker compose config --quiet` passed |
| Fresh Docker smoke | A disposable schema-10 project reached healthy Playwright-worker readiness with no fallback, processed a real 1,303-byte PNG, and preserved a project across API restart. Both services ran as `pwuser` with read-only roots, dropped capabilities, and resource bounds; renderer networking was disabled; the base image was digest-pinned; cleanup completed. |
| Restore control | Maintenance inactive; no operation; no worker lock |
| Repository hygiene | `git diff --check` passed |

The foundation render remains a coarse service comparison only. The separate
browser gate proves the 1440×900 Chromium budget locally; a pinned cross-
platform release CI image and retained artifact history are still needed.

## Runtime and data-preservation evidence

The current disposable Docker smoke verified schema 10, Playwright rendering
without fallback, a real PNG path, and project persistence across API restart.
It also verified the two-service user/filesystem/capability/resource boundaries,
renderer network denial, base-image digest pinning, and complete disposable
project cleanup.

Earlier installed-volume evidence remains separately recorded: project
`miare courier app` was version 31 at revision
`revision_36dd0a2e4cdc4d35b1e1b4e50087ef59` through the schema-8 checkpoint.
That historical record is preservation evidence, not a substitute for broader
customer upgrade fixtures.

The launcher also refreshed its exact mode-`0600` Docker runtime binding,
started the local bridge, verified MCP `formaspec`, and reinstalled/verified the
managed Minimal UI integration without placing a bearer token in generated
Codex configuration.

## Current macOS artifact blockers

The fresh PKG candidate has integrity status `PASS` for its exact current-tree
bytes. Its release gate remains **NO-GO** with these five blocker codes:

1. Chromium headless shell's LGPL notices need an explicit allowlist/legal
   policy decision.
2. The package lacks a real Developer ID Installer signature.
3. Apple notarization and stapling evidence is missing.
4. A second independent build has not reproduced the artifact bytes.
5. Retained dependency, native-binary, Chromium, and OS vulnerability scans are
   missing.

## Additional enterprise evidence still required

- Prove clean macOS install/autostart/protocol/upgrade/uninstall/reinstall and
  produce/test Windows WiX MSI and Linux DEB/RPM packages, including packaged
  Windows DPAPI/ACL/runtime behavior.
- Implement deployment-specific server-mode external restore supervision,
  alerting, off-host policy, and long-duration recovery; approve a signing and
  key-management design because backup hashes prove consistency, not authorship.
- Complete the cross-platform browser/visual, authorization/security,
  prompt-data, renderer-egress, decompression, and secret-exclusion matrices;
  rerun the passing performance and 20-step release scenarios in retained,
  pinned release CI environments.
- Reduce portable-import peak memory beyond the implemented 16 KiB per-entry
  streaming inflater: multipart request bodies and extracted entry buffers are
  still retained within the configured caps. Add larger adversarial,
  concurrent-import, and packaged cross-platform evidence.
- Complete editor pinning/upgrade comparison and V2-head synchronization for
  authored components, richer Workspace Bridge mappings and selected-workspace
  Codex implementation launch, plus stage-specific Redesign Studio artifacts.
  Path-free inventory persistence itself is automatic when the bridge has a
  compatible REST identity or uses the authorized local MCP bridge.
- Produce artifact-specific container/Windows/Linux SBOMs and retained release
  provenance, and replace or explicitly constrain the local-filesystem
  check-then-rename cutover race where Node lacks a portable atomic
  no-replacement directory rename primitive.

## Operator handoff

```bash
./designer --yes start docker --no-open
./designer doctor docker --strict
./designer backup restore status
./designer status
```

In Codex, use one of:

- `Use FormaSpec`
- `Use Minimal UI`
- `Design this with FormaSpec`
- `[@Minimal UI](plugin://minimal-ui@formaspec)`

Detailed evidence and phase-by-phase limitations remain authoritative in
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) and
[`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). The exact unsigned package
evidence and its five release blockers are recorded in
[`MACOS_PKG_EVIDENCE.md`](./MACOS_PKG_EVIDENCE.md).

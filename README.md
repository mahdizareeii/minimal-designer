# FormaSpec

FormaSpec is a self-hosted, AI-first product and UI design workspace.
**FormaSpec** is the product and primary agent-facing identity: a product
manager can describe a web, phone, or tablet experience to Codex, review a
rendered preview, and continue editing the same structured document in the
browser.

The supported agent identity is exactly
`[@FormaSpec](plugin://formaspec@formaspec)`. Upgrades remove installer-owned
legacy identities after FormaSpec 0.4.0 has been installed and verified.

The application does not embed the OpenAI API and does not require an OpenAI
API key. Codex connects through the local FormaSpec MCP bridge. Your Codex
subscription or API usage remains separate.

> **Current release status:** the enterprise upgrade is in active development.
> Core design, persistence, MCP, product-specification, planning, and Codex
> connection foundations exist, but the repository is **not production-ready**.
> See [Implementation status](docs/IMPLEMENTATION_STATUS.md) for the verified
> gaps and release blockers.

## Install and start

Run one installer command from the repository root. It checks the operating
system and requirements, prepares the selected runtime, starts FormaSpec and
the loopback bridge, and—when Codex is detected—configures the token-free
`formaspec` MCP server and the managed FormaSpec 0.4.0 plugin.

Docker is the easiest source installation:

```bash
./designer --yes install docker
```

For a local Node.js installation:

```bash
./designer --yes install local
```

The Docker installer and container-local security mode are implemented. The
current schema-16 local checkpoint uses image
`sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1`.
It reaches renderer readiness without fallback, renders the same real PNG
before and after an API restart, and denies renderer DNS, direct-TCP, and
external-interface egress. The same image passes Firefox/WebKit alignment
12/12 and same-machine copied-bundle recovery into an independent clean
Compose project. Evidence is retained at
`artifacts/ci/docker-schema11/summary.json`,
`artifacts/ci/cross-browser-docker/summary.json`, and
`artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json`; the compatibility
directory name `docker-schema11` is intentionally unchanged. These are local
uncommitted-source `NO-GO` checkpoints, not hosted provenance, a real remote-
host/TLS recovery exercise, or production qualification.

The compatibility `designer` launcher preserves existing `.designer` state and
delegates supported commands to `formaspecctl`. Remove `--yes` if you want one
explicit authorization prompt before setup and Codex configuration.

After startup, open:

- FormaSpec: [http://127.0.0.1:4310](http://127.0.0.1:4310)
- Local MCP bridge: [http://127.0.0.1:4312/mcp](http://127.0.0.1:4312/mcp)

For source development after dependencies are installed:

```bash
pnpm dev
```

Development uses the Vite editor at
[http://127.0.0.1:4311](http://127.0.0.1:4311), the API at port 4310, and the
local bridge at port 4312.

## Use FormaSpec from Codex

The installer normally performs this connection automatically. To connect or
repair it later, run:

```bash
./designer --yes agent connect codex
```

Then start a new Codex task with any of these:

```text
Use FormaSpec to design this product flow.
Design this with FormaSpec.
Refine this selection with FormaSpec.
[@FormaSpec](plugin://formaspec@formaspec) create a professional mobile onboarding flow.
```

FormaSpec 0.4.0 is the only managed plugin. Start a new Codex task after an
installation or upgrade because an already-open task retains its original
plugin inventory.

The connection is intentionally token-free in Codex configuration. Codex talks
to the loopback bridge; the bridge holds the short-lived upstream scoped grant
in macOS Keychain, Linux Secret Service, or a Windows current-user DPAPI blob.
The installer sets automatic tool approval only on the trusted local
`[mcp_servers.formaspec]` entry, so Codex does not prompt for every FormaSpec
tool call. `doctor` and `status` verify that this entry still targets the exact
active credential-free loopback bridge before reporting it trusted. Global
Codex approval and sandbox settings remain unchanged.
Windows code-level DPAPI tests pass; a real packaged Windows lifecycle test is
still required before release.

FormaSpec’s MCP server is named `formaspec`.

The website does not create agent tasks. Start work from Codex or the CLI;
after the exact Product, Design, base version, and selection are confirmed,
FormaSpec creates the durable MCP task. Codex claims it, reads its authorized
context, creates the exact preview, inspects its PNG, runs linting, and
transitions it to `awaiting_approval` with the `previewId`. The agent must not
commit the preview or complete the task. A human reviews the exact preview in
FormaSpec and chooses **Commit** or **Discard**.

For a direct, non-task request, the agent creates a task first and uses the same
human approval boundary:

1. Read project, product-specification, version, and editor-selection context.
2. Read the Product, canonical product specification, effective design-system
   release, reusable components, tokens, and connected repository mappings.
3. Create a bounded preview without changing history.
4. Inspect the exact rendered PNG, lint diagnostics, accessibility, RTL,
   responsive variants, interaction states, and engineering feasibility.
5. Publish the task as `awaiting_approval`; only the website's **Commit** button
   may save the exact preview.
6. Return the exact rendered PNG and secret-free review links for human approval.

Archive operations use their own destructive preview and commit tools. A
`VERSION_CONFLICT` requires a fresh read and preview; V1 never auto-merges.
See [Codex configuration](docs/codex-config.toml.example) for the manual
fallback.

## Current control commands

Run the CLI through pnpm while developing:

```bash
pnpm formaspecctl -- help
pnpm formaspecctl -- doctor auto
pnpm formaspecctl -- ensure-running --json
pnpm formaspecctl -- status
pnpm formaspecctl -- start docker
pnpm formaspecctl -- stop
pnpm formaspecctl -- restart
pnpm formaspecctl -- migrate status
pnpm formaspecctl -- backup create
pnpm formaspecctl -- backup list
pnpm formaspecctl -- backup schedule show
pnpm formaspecctl -- backup schedule enable --at 02:00
pnpm formaspecctl -- backup schedule run
pnpm formaspecctl -- backup prune preview
pnpm formaspecctl -- backup verify /path/to/formaspec-backup.tar
pnpm formaspecctl -- backup restore /path/to/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore --backup-id backup_<id> --yes
pnpm formaspecctl -- backup restore offline /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore status
pnpm formaspecctl -- backup restore resume --yes
pnpm formaspecctl -- backup restore resume --offline-bundle /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore rollback --yes
pnpm formaspecctl -- backup restore abort --yes
pnpm formaspecctl -- backup restore clear-stale-lock --yes
pnpm formaspecctl -- agent config generic --format json
pnpm formaspecctl -- support-bundle preview
```

Currently implemented `formaspecctl` workflows are:

| Command | Current behavior |
| --- | --- |
| `install local\|docker` | Checks/prepares the source runtime, starts FormaSpec and the bridge, and offers supported Codex setup. |
| `doctor auto\|local\|docker\|server` | Diagnoses the selected runtime, renderer, data-store identity, bridge alignment, and authenticated FormaSpec MCP connection. |
| `ensure-running` | Recovers only the recorded runtime and data store, verifies the bridge, and returns structured blocker details with `--json`; it never guesses or silently switches runtime modes. |
| `start`, `stop`, `restart`, `status` | Delegates application lifecycle to the compatibility launcher and manages the bridge. |
| `migrate status` | Reports the numbered migration ledger for a source-mode database. |
| `backup create` | Asks the running loopback FormaSpec API to create and immediately verify a managed backup. |
| `backup list` | Lists opaque managed backup records without exposing server filesystem paths. |
| `backup schedule show\|enable\|disable\|run` | Configures one UTC daily window and provides same-window-idempotent supervisor execution under fixed 7/4/12 retention. |
| `backup prune preview\|execute` | Produces an exact expiring plan, permanently exempts manual backups, and requires plan hash plus explicit `--yes` before revalidated deletion. |
| `backup verify` | Independently verifies an existing bounded `formaspec-backup` bundle. |
| `backup restore <bundle>` | With explicit `--yes`, verifies and atomically restores source-local `./data`, creates a stopped-service safety copy, rolls back on health failure, and refuses Docker/server modes. |
| `backup restore --backup-id <id>` | Externally supervises a `HEALTHY_PLANNED_RESTORE_ONLY` operation for the launcher-recorded local Docker/server runtime through its pinned runtime binding, maintenance fence, shared worker lock, verified managed safety backup, render/database checks, credential revocation, and readiness-gated restart. This planned path still requires the current API/database for backup-ID resolution and preflight. |
| `backup restore offline <bundle>` | With explicit `--yes`, verifies the operator-selected bundle before mutation, pins the same regular file by identity/hash/size, capacity-gates stdin and the whole workflow, streams only stdin into the network-disabled restore worker, applies forensic pre-copy capacity checks, creates and verifies an exact snapshot of the existing `/data` bytes even when SQLite is corrupt, then uses the standard verified cutover, schema/render checks, audit/outbox reconciliation, credential revocation, and readiness-gated restart. Child stdout/stderr shares one combined 4 MiB budget by default, with a 5-second SIGKILL fallback when SIGTERM is ignored. Any failure after fencing remains in maintenance for explicit resume; it never auto-aborts or restarts the API. |
| `backup restore status\|resume\|rollback\|abort\|clear-stale-lock` | Inspects or safely recovers the exact durable Docker restore operation. Offline interruption before preparation resumes with `--offline-bundle <same-bundle>` under the current maintenance owner; `offlinePrepare` and the replacement worker never reuse a retained forensic predecessor's ID. Forensic rollback restores exact pre-state bytes, keeps maintenance active and the API stopped, and reports `maintenanceCleared: false`/`serviceReady: false`; direct clear is rejected and only a newly verified offline restore may atomically take over that fence. Abort accepts only pristine/prepared pre-cutover state with no journal/worker lock and a reverified healthy live database, so corrupt state remains fenced; stale-lock clearing requires proof that the pinned worker container is absent. |
| `agent connect codex` | Starts or refreshes the bridge, configures token-free MCP with server-scoped automatic tool approval, installs and verifies the single managed FormaSpec 0.4.0 plugin, removes only installer-owned legacy identities, and verifies the connection without changing global Codex approval or sandbox policy. |
| `agent config generic` | Prints validated token-free loopback JSON/TOML and verification guidance without reading or modifying an unknown client. |
| `support-bundle preview\|create` | Previews or explicitly creates a deterministic bounded diagnostic archive with aggressive redaction and no database, assets, backups, environment values, source, or credentials. |

Automatic supervisor installation/alerting, native package installation,
autostart, and full upgrade/uninstall workflows are not complete CLI features
yet. Launcher-pinned Docker/server restore now has two separately authorized
paths: `HEALTHY_PLANNED_RESTORE_ONLY` by managed backup ID, and offline recovery
from an explicitly selected verified bundle. The offline path does not depend
on a healthy current API/database, but it still lacks a retained real Docker/
server corrupt-database lifecycle exercise. Backup create/list/schedule/prune
still require the local loopback service, while bundle verification,
source-local restore, and support-bundle creation remain separate.

## What is implemented

- Structured V1 design documents with stable IDs, typed operations, tokens,
  assets, prototype links, immutable revisions, PNG rendering, and JSON handoff.
- Content-addressed Brotli snapshots, SHA-256 revision chains, persisted exact
  previews, idempotent atomic commits, archive-only destructive paths, and
  replayable organization-scoped SSE.
- Organizations, principals, roles, project ownership, expiring scoped agent
  grants, audit records, and service-layer project authorization foundations.
- A shared `ViewportTransform`, untransformed interaction overlay, coalesced
  Moveable geometry refresh, memoized node views, selection normalization, and
  an automated Chrome DPR/zoom/pan/LTR/RTL alignment foundation.
- Strict V2 schemas and deterministic V1-to-V2 migration utilities, plus the
  FormaSpec Foundation System model.
- Product-specification preview/commit, the 22-section planning model, agent
  tasks/connections, and revision-pinned inspection. The inspect API/view keeps
  the requested revision separate from the current head and exposes integrity,
  resolved tokens, assets, components, rules, acceptance criteria, mappings,
  stable IDs, and JSON paths.
- Checksum-validated portable export, read-only validation, and administrator-
  authorized mutating import with idempotent preserve-ID conflict failure or
  deterministic clone remapping, isolated raster normalization, local-version
  rebasing, and immutable migration-10 provenance.
- Streamable HTTP MCP tools/resources under the `formaspec` identity and
  `formaspec://` resource scheme.
- A separate bounded Unix-socket Playwright renderer service in Docker with a
  non-root user, no network, read-only root, dropped capabilities, deterministic
  contexts, resource limits, and fail-closed health.
- Schema 11 persistent render-job records for rendering and raster
  normalization. The API owns the database lifecycle (`queued` → `running` →
  terminal), uses owner leases and heartbeats for rolling-process recovery,
  retains only bounded hashes/versions/dimensions/warnings/safe errors, and
  performs permit-guarded 30-day terminal-record retention. The renderer worker
  remains database-free and output image bytes are not stored in the job row.
- PNG/JPEG/WebP decode and deterministic normalization with byte/pixel limits,
  generated content-addressed files, integrity verification, and legacy-BLOB
  fallback.
- A read-only Workspace Bridge foundation with explicit expiring/revocable
  repository grants, secret/symlink/generated-file exclusion, supported-platform
  detection, bounded inventories, and path-free upload mappings.
- Automatic managed Codex grant reconciliation: authorized startup reuses a
  stored credential only when its exact scopes and project restrictions match
  current organization policy, otherwise it rotates through one-time pairing;
  Codex configuration remains token-free.
- Approval-gated selected-workspace Codex launch. A grant is bound to the exact
  central inventory, the handoff must carry the exact immutable
  `approved` → `implementing` `start_implementation` transition, Codex starts
  with the selected repository as its exact working directory, one secret-free
  task argument, `shell: false`, and a minimal environment. POSIX process-group
  monitoring terminates the launch after revocation, expiry, policy withdrawal,
  handoff closure, or inventory change; packaged Windows descendant containment
  still requires a Job Object or equivalent.
- Persisted organization design systems with append-only token/component
  versions, immutable releases, project pins, exact upgrade previews, REST/MCP
  interfaces, and initial Administration UI.
- Central path-free repository inventories, immutable design/spec/source
  mappings pinned to exact revision and inventory hashes, and revision-pinned
  engineering handoffs with reviewed mapping UI, human approval/implementation
  gates, replayable events, and no central filesystem-path input.
- A persisted seven-stage Redesign Studio with independent scopes, immutable
  stage history, design-version CAS, a planning-only one-click entry, REST/MCP,
  and a dedicated browser workspace. Future-state entry requires current
  repository inventory and verified exact-revision mapping evidence.
- A deterministic 1,000-node core/service performance comparison harness.
- Fixed 7-daily/4-weekly/12-monthly managed backup planning with supervisor-run
  UTC scheduling, preview-first revalidated pruning, and permanent manual-backup
  exemption.
- Organization Administrator audit retention with exact expiring previews,
  30-day minimum enforcement, bounded 2,000-row/8-MiB-per-kind batches, guarded
  atomic deletion, replay gaps, and immutable SHA-256 chained run evidence.
- Externally supervised launcher-local Docker restore with a mode-`0600` exact
  runtime binding, fail-closed maintenance, shared non-expiring worker lock,
  crash-resumable journal states, verified safety backup, database/render
  checks, `O_NOFOLLOW` source pinning on `/backups`, committed-journal retention
  on cleanup failure, restored credential revocation, and explicit recovery
  commands. Source-local restore passes its exact verified tar-stream hash/size
  into the same pinning engine.
- A bounded deterministic support bundle with read-only preview, adjacent local
  manifest, redacted logs/config-key inventory, and explicit creation approval.

These foundations do not close the release gates listed below.

## Important current limitations

- Windows renderer named pipes, native lifecycle proof, and continuous
  egress/failure/load proof remain unfinished beyond the verified Docker
  network-denied worker. Render and raster-normalization jobs persist a bounded
  hash-only, owner-leased lifecycle with exact 30-day retention, but
  organization-configurable retention dashboards and packaged load evidence
  remain open.
- Current schema-16 local evidence passes editor/Administration 5/5, release
  E2E 1/1, preview integration 2/2, Chromium alignment 12/12,
  Firefox/WebKit alignment 12/12, visual regression 7/7, and all 1,000-node
  browser budgets. The Docker restart/egress and copied-bundle recovery gates
  also pass locally. Hosted supported-OS repetition, the current security/
  SBOM/image scans, signed native lifecycle evidence, and real remote-host/TLS
  recovery remain open.
- Five repository-native least-privilege workflows now cover frozen source
  gates, browser alignment/visual/performance/release suites, historical Docker
  smoke, deterministic SBOM/license evidence, unsigned Linux packages, and the
  non-installing macOS extracted-runtime gate. The local evidence helpers pass
  workflow contracts 8/8, cross-browser runner tests 2/2, off-host simulation
  tests 7/7, release-evidence tests 8/8, macOS package-evidence tests 12/12,
  and macOS runtime-smoke contract tests 11/11; no GitHub-hosted run or real Ubuntu
  DEB/RPM artifact has yet been retained.
- Complete component/release authoring and upgrade-review UI, framework-aware
  Workspace Bridge mapping/upload/implementation launch, and full Redesign
  Studio artifact/E2E coverage remain unfinished. Portable import now streams
  the multipart upload into a private mode-`0700` staging directory, pins the
  archive by hash/size, validates its central/local headers from bounded reads,
  and inflates each entry in 16 KiB chunks into private files. It no longer
  retains the multipart body or all extracted entries in memory. Individual
  JSON/raster entries are still read under the 64 MiB per-entry cap when parsed
  or normalized; broader concurrent/adversarial and packaged evidence remains.
- Verified backup creation/list/verification/download and portable validation/
  import are exposed in `/administration`; source-local restore,
  supervisor-callable schedule/prune, launcher-pinned planned restore, and the
  explicitly authorized offline bundle path exist. Installed supervision/
  alerting, signed provenance, an isolated end-to-end `formaspecctl` offline
  lifecycle, and broader failure-recovery evidence remain unfinished. A real
  unique-project `formaspecctl` smoke now exercises the offline worker/control
  path through the validated persisted Compose identity. Server-mode proxy
  lifecycle, packaged-runtime, real remote-host/network/TLS/off-site recovery,
  and broader proof remain open. A separate same-machine copied-bundle smoke
  now passes against an independent clean target without claiming those remote
  guarantees.
- A retained pre-current-SSE-authorization unsigned schema-12 macOS ARM64
  engineering checkpoint
  is stored at
  `artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
  (185,279,180 bytes; SHA-256
  `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`).
  It was not installed. Package integrity passes with 349 components, seven
  exact workspace trees, two bundled runtimes, and no workspace-output drift;
  the private extracted-runtime smoke also passes schema-12 health, a real
  Playwright PNG, and the exact 51-tool/25-resource MCP inventory. Its
  checksum-bound runtime summary hashes to
  `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`.
  The candidate-root `SHA256SUMS` manifest verifies all 14 retained package,
  sidecar, source, runtime, reproducibility, and documentation entries.
  Its original evidence remains valid for the frozen bytes, but the current
  verifier now reports expected source drift: packaged `apps/server/dist`
  predates the exhaustive event-authorization policy and the project/revision-
  bound historical design-system release interface. It is not a package of the
  current source tree.
  Release remains **NO-GO**: Chromium LGPL notices lack policy approval, the
  package is unsigned and unnotarized, vulnerability scans are missing, clean
  native lifecycle proof is absent, and reproducibility is unresolved. A
  same-host repeat produced a different outer PKG (SHA-256
  `2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0`,
  185,279,075 bytes) even though the payload and workspace-tree hashes were
  identical; the diagnostic summary hashes to
  `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`.
  The preserved `schema11-current` and `schema10-current` candidates are
  historical only. Deterministic Linux DEB/RPM builders and a Windows WiX v4
  unsigned-MSI foundation exist in source, but no release-qualified native
  lifecycle evidence exists. Windows tests use fake PE/CFB/WiX fixtures and do
  not establish a real WiX compile or MSI validity. See
  [Linux packaging](docs/LINUX_PACKAGING.md),
  [Windows packaging](docs/WINDOWS_PACKAGING.md), and
  [macOS PKG evidence](docs/MACOS_PKG_EVIDENCE.md).
- New server initializer output includes the strict server-mode, proxy,
  allowlist, CORS, and container-boundary contract, and the CLI/server migration
  readers both recognize version 16. Migration 9 adds bounded, preview-first
  audit/published-outbox retention with immutable hash-chained execution
  evidence; migration 10 adds immutable portable-import provenance; migration
  11 adds persistent bounded render-job lifecycle records; migration 12 adds
  append-only, independently authorized handoff execution decisions; migration
  13 persists canonical component sources and exact upgrade snapshots;
  migration 14 adds browser-session authentication; migration 15 adds bounded
  write-once exact preview-render evidence; and migration 16 canonicalizes the
  legacy bootstrap-credential trigger without rewriting credential rows.
  Genuine schema 1 and schema 7–12 fixtures are verified to upgrade without changing
  V1 revision bytes, hashes, IDs, or assets; clean reverse-proxy
  deployment and real customer planned/offline backup-restore fixtures remain
  unproven. Server mode now also requires a separate internal
  proxy hop secret on every non-health request; focused server/launcher tests
  pass. A controlled actual-TCP-socket lifecycle test also proves header
  replacement, direct-peer denial, ambiguous append rejection, and restart-
  bound secret rotation; real Nginx/TLS, identity-provider, firewall/routing,
  and public-port evidence remains open.

The recorded local-Docker evidence used an isolated Compose project on port
`4397`: backup `backup_0dda1a60c54c5805557426a428739e505e089425` restored
design A only, then safety backup
`backup_7697fb29100b0bc8adc22707114c50947ed3a668` restored A and B. Original
design/revision IDs were preserved, restored grant/connection/nonce state was
revoked, and the disposable containers, volumes, and network were deleted. This
does not change the overall **NO-GO** release status.

A separate disposable offline-recovery smoke exercised the production worker/
control path on a unique Compose stack: it restored a verified schema-11 bundle
after replacing the live database with corrupt marker bytes, reproduced the
exact design and PNG, revoked one grant/connection/nonce, then restored the
exact corrupt pre-state bytes with durable `rolled_back`/`recovery=offline`
evidence and removed the stack. The earlier worker/control smoke manually
cleared its forensic fence only for disposable cleanup; product semantics keep
maintenance active and the API stopped. A subsequent real unique-project
`formaspecctl` smoke validated persisted Compose ownership end to end, closing
the former hardcoded-project isolation gap.

Do not expose a source build as an enterprise production service until
[Implementation status](docs/IMPLEMENTATION_STATUS.md) changes the release
decision.

## Data and compatibility

Source/native data defaults to `./data`. Launcher state, logs, and generated
runtime configuration remain under the ignored `.designer/` directory.
Docker persists `/data` in its Compose volume.

The migration ledger upgrades existing databases in place and keeps the V1
document/history model readable. V2 conversion utilities preserve project,
page, frame, node, token, asset, and prototype IDs, but automatic V2 head
migration is not enabled as a general operator workflow.

Before an upgrade or restore, follow
[Backup and restore](docs/BACKUP_AND_RESTORE.md).

## Development verification

Current schema-16 source verification passes the seven-package suite 842/842
(core 59, server 467, web 91, CLI 96, local bridge 20, Workspace Bridge 37,
installer 72), launcher 225/225, and all workspace typechecks/builds. Current
local evidence also passes editor/Administration 5/5, release E2E 1/1,
preview integration 2/2, Chromium and Firefox/WebKit alignment 12/12 each,
visual regression 7/7, macOS runtime contracts 11/11, and the 1,000-node
browser budgets. Schema-16 Docker restart/egress, exact-image cross-browser,
and clean-project copied-bundle recovery checkpoints are retained under
`artifacts/ci/`; the exact schema-13 SBOM/license result remains historical.

```bash
pnpm test:run
pnpm typecheck
pnpm build
pnpm test:launcher
pnpm test:e2e:alignment
pnpm test:e2e:alignment:cross-browser
pnpm test:e2e:editor
pnpm test:e2e:visual
pnpm test:e2e:performance
pnpm test:e2e:release
pnpm test:performance
pnpm test:release-evidence
pnpm test:macos-pkg-evidence
pnpm test:macos-pkg-runtime-smoke
pnpm release:evidence:macos:verify
pnpm package:linux:deb
pnpm package:linux:rpm
docker compose config --quiet
```

`pnpm ci:release-evidence` is the strict source-workspace production dependency
gate. Historical linked-0.45.2 schema-13 source evidence passed with 342 third-
party components and zero policy violations after Sharp/libvips was removed;
current schema-16 source-workspace and target-artifact evidence must be
regenerated. The retained `schema12-current`
unsigned PKG passed its frozen package/workspace integrity check and the
non-installing extracted-runtime smoke, but the current verifier now records
expected source drift and it remains an engineering checkpoint: the outer PKG was not
byte-for-byte reproducible even on the same host, and legal approval, signing,
notarization, vulnerability scanning, and privileged native lifecycle proof
remain open. The preserved `schema11-current` and `schema10-current` candidates
are historical; container, Windows, and Linux artifacts still require their own
target-specific evidence.

Passing unit/build checks alone does not establish production readiness. The
browser, security, performance, backup/restore, installer, and release-evidence
gates in [Implementation status](docs/IMPLEMENTATION_STATUS.md) remain
authoritative.

More detail:

- [Getting started](docs/GETTING_STARTED.md)
- [Visual regression testing](docs/VISUAL_REGRESSION_TESTING.md)
- [Local installation](docs/LOCAL_INSTALLATION.md)
- [Architecture](docs/architecture.md)
- [Document schema](docs/DOCUMENT_SCHEMA.md)
- [Design system](docs/DESIGN_SYSTEM.md)
- [Product specification](docs/PRODUCT_SPECIFICATION.md)
- [Retained CI and release evidence](docs/CI_RELEASE_EVIDENCE.md)
- [MCP](docs/MCP.md)
- [Agent connections](docs/AGENT_CONNECTIONS.md)
- [Workspace Bridge](docs/WORKSPACE_BRIDGE.md)
- [Redesign Studio](docs/REDESIGN_STUDIO.md)
- [Operations](docs/OPERATIONS.md)
- [Server deployment](docs/deployment.md)
- [Security](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Support bundles](docs/SUPPORT_BUNDLES.md)
- [Upgrading](docs/UPGRADING.md)
- [Licensing](docs/LICENSING.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Enterprise implementation report](docs/FINAL_IMPLEMENTATION_REPORT.md)

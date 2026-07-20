# FormaSpec

FormaSpec is a self-hosted, AI-first product and UI design workspace. Its
agent-facing name is **Minimal UI**: a product manager can describe a web,
phone, or tablet experience to Codex, review a rendered preview, and continue
editing the same structured document in the browser.

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
the loopback bridge, and—when Codex is detected—configures the `formaspec` MCP
server plus the managed Minimal UI skill/plugin.

Docker is the easiest source installation:

```bash
./designer --yes install docker
```

For a local Node.js installation:

```bash
./designer --yes install local
```

The Docker installer and container-local security mode are implemented. The
Compose file validates, both API and network-denied renderer services reached
healthy state, and a fresh isolated volume preserved a project across API
restart. A separate disposable local-Docker restore/safety-restore exercise also
passed. Keep source evaluation bound to the default host loopback address; this
is not complete server-production evidence.

The compatibility `designer` launcher preserves existing `.designer` state and
delegates supported commands to `formaspecctl`. Remove `--yes` if you want an
authorization prompt before setup and Codex configuration.

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

## Use Minimal UI from Codex

The installer normally performs this connection automatically. To connect or
repair it later, run:

```bash
./designer --yes agent connect codex
```

Then start a new Codex task with any of these:

```text
Use FormaSpec to design this product flow.
Use Minimal UI to improve the selected screen.
Design this with FormaSpec.
[@Minimal UI](plugin://minimal-ui@formaspec) create a professional mobile onboarding flow.
```

The connection is intentionally token-free in Codex configuration. Codex talks
to the loopback bridge; the bridge holds the short-lived upstream scoped grant
in macOS Keychain, Linux Secret Service, or a Windows current-user DPAPI blob.
Windows code-level DPAPI tests pass; a real packaged Windows lifecycle test is
still required before release.

FormaSpec’s MCP server is named `formaspec`. Its required workflow is:

1. Read project, product-specification, version, and editor-selection context.
2. Create a bounded preview without changing history.
3. Inspect the rendered PNG and lint diagnostics.
4. Commit that exact preview with the expected base version.
5. Return the secret-free project/revision deep link for human review.

Archive operations use their own destructive preview and commit tools. A
`VERSION_CONFLICT` requires a fresh read and preview; V1 never auto-merges.
See [Codex configuration](docs/codex-config.toml.example) for the manual
fallback.

## Current control commands

Run the CLI through pnpm while developing:

```bash
pnpm formaspecctl -- help
pnpm formaspecctl -- doctor auto
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
pnpm formaspecctl -- backup restore status
pnpm formaspecctl -- backup restore resume --yes
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
| `doctor auto\|local\|docker\|server` | Runs source-launcher diagnostics and reports Codex/bridge detection. |
| `start`, `stop`, `restart`, `status` | Delegates application lifecycle to the compatibility launcher and manages the bridge. |
| `migrate status` | Reports the numbered migration ledger for a source-mode database. |
| `backup create` | Asks the running loopback FormaSpec API to create and immediately verify a managed backup. |
| `backup list` | Lists opaque managed backup records without exposing server filesystem paths. |
| `backup schedule show\|enable\|disable\|run` | Configures one UTC daily window and provides same-window-idempotent supervisor execution under fixed 7/4/12 retention. |
| `backup prune preview\|execute` | Produces an exact expiring plan, permanently exempts manual backups, and requires plan hash plus explicit `--yes` before revalidated deletion. |
| `backup verify` | Independently verifies an existing bounded `formaspec-backup` bundle. |
| `backup restore <bundle>` | With explicit `--yes`, verifies and atomically restores source-local `./data`, creates a stopped-service safety copy, rolls back on health failure, and refuses Docker/server modes. |
| `backup restore --backup-id <id>` | Externally supervises restore for the launcher-recorded local Docker runtime through its pinned runtime binding, maintenance fence, shared worker lock, verified managed safety backup, render/database checks, credential revocation, and readiness-gated restart. |
| `backup restore status\|resume\|rollback\|abort\|clear-stale-lock` | Inspects or safely recovers the exact durable Docker restore operation. Abort requires no operation/journal/worker evidence; stale-lock clearing requires proof that the pinned worker container is absent. |
| `agent connect codex` | Starts/authorizes the bridge, configures MCP, installs the managed skill/plugin, and verifies the connection. |
| `agent config generic` | Prints validated token-free loopback JSON/TOML and verification guidance without reading or modifying an unknown client. |
| `support-bundle preview\|create` | Previews or explicitly creates a deterministic bounded diagnostic archive with aggressive redaction and no database, assets, backups, environment values, source, or credentials. |

Server-mode restore, automatic supervisor installation/alerting, native package
installation, autostart, and full upgrade/uninstall workflows are not complete
CLI features yet. Launcher-local Docker restore is implemented and externally
supervised; backup create/list/schedule/prune still require the local loopback
service, while offline verification, source-local restore, and support-bundle
creation remain separate.

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
- PNG/JPEG/WebP decode and deterministic normalization with byte/pixel limits,
  generated content-addressed files, integrity verification, and legacy-BLOB
  fallback.
- A read-only Workspace Bridge foundation with explicit expiring/revocable
  repository grants, secret/symlink/generated-file exclusion, supported-platform
  detection, bounded inventories, and path-free upload mappings.
- Persisted organization design systems with append-only token/component
  versions, immutable releases, project pins, exact upgrade previews, REST/MCP
  interfaces, and initial Administration UI.
- Central path-free repository inventories and revision-pinned engineering
  handoffs with immutable versions, human approval/implementation gates,
  replayable events, and an initial editor handoff panel.
- A persisted seven-stage Redesign Studio with independent scopes, immutable
  stage history, design-version CAS, a planning-only one-click entry, REST/MCP,
  and a dedicated browser workspace.
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

- Windows renderer named pipes/native packaging and continuous
  egress/failure/load proof remain unfinished beyond the verified Docker
  network-denied worker. Render and raster-normalization jobs now persist a
  bounded hash-only, owner-leased lifecycle with exact 30-day retention, but
  organization-configurable retention dashboards and packaged load evidence
  remain open.
- The local 20-step browser E2E, seven visual baselines, selection alignment,
  and 1,000-node interaction budgets pass. Cross-platform browser/visual,
  comprehensive security, and server-deployment matrices remain incomplete.
- Complete component/release authoring and upgrade-review UI, framework-aware
  Workspace Bridge mapping/upload/implementation launch, and full Redesign
  Studio artifact/E2E coverage remain unfinished. Portable import now performs
  strict central/local-header, descriptor, CRC, path, entry-type, size, and
  trailing-data checks before bounded 16 KiB per-entry inflation. Multipart
  bodies and extracted entry buffers are still retained within the configured
  caps, so lower-peak end-to-end request streaming and broader stress evidence
  remain.
- Verified backup creation/list/verification/download and portable validation/
  import are exposed in `/administration`; source-local restore, supervisor-callable
  schedule/prune, and launcher-local Docker restore exist. Server-mode restore,
  installed supervision/alerting, signed provenance, and broader
  failure-recovery evidence remain unfinished.
- One fresh self-contained unsigned macOS ARM64 PKG candidate and its offline
  artifact-specific integrity/SBOM evidence match the current schema-10
  workspace. The verifier requires
  exact path/type/content-hash equality for every packaged workspace `dist`
  tree and managed CLI asset, so stale compiled output fails. The package is
  still **NO-GO** for release: Chromium LGPL-notice review,
  signing/notarization, reproducibility, vulnerability scans, and clean
  lifecycle proof remain open. Windows MSI, Linux DEB/RPM, and container
  artifact evidence are not complete. See
  [macOS PKG evidence](docs/MACOS_PKG_EVIDENCE.md).
- New server initializer output includes the strict server-mode, proxy,
  allowlist, CORS, and container-boundary contract, and the CLI/server migration
  readers both recognize version 10. Migration 9 adds bounded, preview-first
  audit/published-outbox retention with immutable hash-chained execution
  evidence; migration 10 adds immutable portable-import provenance. A copied
  version-7 fixture is verified to
  upgrade without changing V1 revision bytes or hashes; clean reverse-proxy
  deployment, server restore, and real customer backup/restore fixtures remain
  unproven.

The recorded local-Docker evidence used an isolated Compose project on port
`4397`: backup `backup_0dda1a60c54c5805557426a428739e505e089425` restored
design A only, then safety backup
`backup_7697fb29100b0bc8adc22707114c50947ed3a668` restored A and B. Original
design/revision IDs were preserved, restored grant/connection/nonce state was
revoked, and the disposable containers, volumes, and network were deleted. This
does not change the overall **NO-GO** release status.

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

```bash
pnpm test:run
pnpm typecheck
pnpm build
pnpm test:launcher
pnpm test:e2e:alignment
pnpm test:e2e:visual
pnpm test:e2e:performance
pnpm test:e2e:release
pnpm test:performance
pnpm test:release-evidence
pnpm test:macos-pkg-evidence
pnpm release:evidence:macos:verify
docker compose config --quiet
```

`pnpm ci:release-evidence` is the strict source-workspace production dependency
gate. The last recorded checkpoint passed with 342 third-party components and
zero policy violations after Sharp/libvips was removed. The exact unsigned
macOS ARM64 PKG also passed offline artifact verification and exact linkage for
seven workspace trees at that checkpoint, while
`pnpm release:evidence:macos:gate` intentionally failed on the five recorded
release blockers. Migrations 9/10 and later import/inspect changes now require a
fresh source-evidence run plus a rebuilt package before current-workspace parity
can be claimed. Container, Windows, and Linux artifacts still require their own
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

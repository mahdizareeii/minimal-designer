# FormaSpec operations

Last audited: 2026-07-20

FormaSpec is the product name. **Minimal UI** is the agent-facing alias used by
Codex and other MCP-capable clients.

## Operational status

The repository has working enterprise foundations, including numbered SQLite
migrations, content-addressed revision snapshots, revision hash chains,
organization/project authorization, scoped agent grants, durable SSE replay,
strict organization-policy enforcement, local/server configuration validation,
bounded Chromium rendering, and the first `formaspecctl`, local-bridge, and
Workspace Bridge workflows.

It is **not production-ready**. The current supported use is local development
and controlled evaluation. Docker separates API and renderer and now includes
an externally supervised one-shot restore-worker foundation for the exact
launcher-recorded local-Docker or server runtime. That command is explicitly
`HEALTHY_PLANNED_RESTORE_ONLY`: the current API/database must be healthy for
backup-ID resolution and preflight, so offline disaster recovery is not
implemented. Release-qualified native installers, clean server-mode planned-
restore evidence, signed provenance, security/browser/performance
matrices, and complete release evidence remain unfinished. A disposable
local-Docker A/B restore exercise has passed, but it does not qualify the server
path or close the broader recovery gate. See
[Release blockers](#release-blockers).

## Fastest installation

Run commands from the repository root.

Docker installer entry point:

```bash
./designer --yes install docker
```

Local source installer entry point:

```bash
./designer --yes install local
```

Both installers perform the available requirement checks, install the frozen
workspace dependencies, build the CLI and local bridge, start FormaSpec, start
the loopback bridge, detect Codex, and configure the managed Minimal UI
integration when Codex is available. `--yes` grants that explicit setup
authorization without further prompts.

The source installer currently needs Node.js 24 or newer and pnpm 11.9 even
when the selected application runtime is Docker, because `formaspecctl` and the
host-side local bridge are built from this checkout. Native packages are
designed to bundle their runtime. The exact unsigned macOS ARM64 PKG is stale
schema-10 engineering evidence, not a current release artifact. Linux DEB/RPM
and Windows WiX v4 builder foundations exist in source, but no current Linux or
Windows artifact/lifecycle evidence qualifies them for release. See
[Linux packaging](./LINUX_PACKAGING.md) and
[Windows packaging](./WINDOWS_PACKAGING.md).

The launcher supports macOS, Linux, and WSL2. Native Windows shells are not
supported by the source launcher. Docker Desktop/Engine and Compose v2 must
already be installed for Docker mode; the launcher can start an installed
daemon but does not install Docker itself.

The Compose file passes the strict mode variables, uses an explicit
`FORMASPEC_CONTAINER_LOCAL` exception for an API container whose host-published
port remains loopback-only, mounts data/backup/socket volumes, and runs a
separate non-root, read-only, capability-free, network-disabled renderer with
resource limits. A fresh isolated local Compose project reached health and
preserved a project across API restart. Treat it as evaluation evidence, not a
release artifact: a separate isolated local-Docker restore and safety-restore
exercise passed, but server-mode proxy/restore evidence, broader recovery fixtures,
upgrade, saturation, and long-running security evidence remain incomplete. Do
not weaken the host binding or publish the port.

## Source development

After dependencies are installed:

```bash
pnpm dev
```

This keeps all development processes attached to the terminal:

- API, MCP, and compatibility health endpoints: `http://127.0.0.1:4310`;
- Vite editor: `http://127.0.0.1:4311`;
- local MCP bridge: `http://127.0.0.1:4312`.

The root development script starts a bridge process directly rather than
through the CLI ownership record. The current `agent connect` command will not
authorize an already-running unowned bridge. Use the installer-managed start
for the one-command Codex pairing flow, or configure the development bridge
manually only if you understand that limitation.

## Current `formaspecctl` commands

Use the source CLI through the root package script:

```bash
pnpm formaspecctl --help
```

| Command | Current behavior |
| --- | --- |
| `pnpm formaspecctl --yes install local` | Prepares and starts the built local application, starts the bridge, and connects supported Codex. |
| `pnpm formaspecctl --yes install docker` | Prepares and starts the current Compose application, starts the host bridge, and connects supported Codex. |
| `pnpm formaspecctl doctor [auto\|local\|docker\|server] [--strict]` | Runs the compatibility launcher's platform/runtime checks, then reports Codex and bridge state. |
| `pnpm formaspecctl status` | Reports the compatibility launcher state and the local bridge state. |
| `pnpm formaspecctl start [local\|docker\|server]` | Starts the requested runtime, ensures the bridge is running, and offers Codex setup. Supported options depend on the target: `--port`, `--no-open`, or `--no-build`. |
| `pnpm formaspecctl stop` | Stops the CLI-owned bridge and the recorded application runtime while preserving application data. |
| `pnpm formaspecctl restart` | Restarts the recorded application runtime and bridge. |
| `pnpm formaspecctl migrate status [--json]` | Reads the numbered migration ledger for `./data/designer.sqlite`; it does not migrate or inspect a Docker volume. |
| `pnpm formaspecctl backup create [--json]` | Requests an online, immediately verified backup from the running loopback service. |
| `pnpm formaspecctl backup list [--json]` | Lists opaque managed backup records without exposing filesystem paths. |
| `pnpm formaspecctl backup schedule show\|enable\|disable\|run [--at HH:MM] [--json]` | Configures one daily UTC window and lets a trusted supervisor invoke its same-window-idempotent backup run. |
| `pnpm formaspecctl backup prune preview [--json]` | Produces an expiring dry-run with exact scheduled-backup IDs, plan hash, byte count, and manual-backup exemptions. |
| `pnpm formaspecctl backup prune execute --preview-id <id> --plan-hash <sha256> --yes [--json]` | Revalidates and commits only the reviewed 7-daily/4-weekly/12-monthly prune plan. |
| `pnpm formaspecctl backup verify <formaspec-backup.tar> [--json]` | Safely extracts and verifies exact archive/checksum coverage, SQLite/foreign-key/migration integrity, assets and legacy BLOB fallback, canonical snapshots, revision hash chains, and project heads. |
| `pnpm formaspecctl backup restore <formaspec-backup.tar> --yes [--json]` | Stops a recorded source-local runtime, creates a safety copy when local data exists, and invokes the atomic verified restore engine for `./data`. It refuses Docker volumes and server runtimes and leaves the app stopped. |
| `pnpm formaspecctl backup restore --backup-id <id> --yes [--json]` | Externally supervises `HEALTHY_PLANNED_RESTORE_ONLY` for the exact launcher-recorded local-Docker or server runtime. It fences traffic, stops only the pinned API container, runs the network-disabled one-shot worker, creates a verified safety backup, verifies exact schema/readiness/renderer state with the configured Host, revokes restored agent credentials, restarts under maintenance, and clears maintenance only after readiness succeeds. The current API/database must be healthy for backup-ID resolution and preflight; this is not offline disaster recovery. |
| `pnpm formaspecctl backup restore status [--json]` | Reads the path-free maintenance marker and durable restore-operation state through a one-shot control process; it does not clear or mutate recovery state. |
| `pnpm formaspecctl backup restore resume [--backup-id <id>] --yes [--json]` | Resumes the exact active pinned Docker/server operation. `--backup-id` is required only when interruption preceded creation of the durable operation record. |
| `pnpm formaspecctl backup restore rollback --yes [--json]` | Restores the verified safety backup as a separately supervised operation when the previous operation is in an eligible conclusive state; an inconclusive interruption must be resumed first. |
| `pnpm formaspecctl backup restore abort --yes [--json]` | Clears only a preflight maintenance attempt for which no durable operation, cutover journal, or shared worker-lock evidence exists. It is not a force-abort. |
| `pnpm formaspecctl backup restore clear-stale-lock --yes [--json]` | Removes only a valid matching worker lock after the pinned Docker supervisor proves the exact worker container no longer exists. |
| `pnpm formaspecctl audit retention preview [--json]` | Produces a 15-minute, organization-scoped, bounded dry-run using the current audit-retention policy, exact candidate counts/ranges, canonical-byte hashes, and a plan hash. |
| `pnpm formaspecctl audit retention list [--json]` | Lists immutable retention-run evidence and SHA-256 chain hashes without exposing deleted audit contents. |
| `pnpm formaspecctl audit retention execute --preview-id <id> --plan-hash <sha256> --yes [--idempotency-key <key>] [--json]` | Revalidates and atomically commits only the reviewed old audit/published-outbox batch, then records immutable hash-chained evidence. |
| `pnpm formaspecctl agent connect codex [--yes]` | Starts/authorizes the bridge, installs the managed Minimal UI skill/plugin, saves MCP server `formaspec`, and verifies the credential-free Codex configuration. |
| `pnpm formaspecctl agent config generic [--format all\|json\|toml]` | Prints validated client-neutral loopback Streamable HTTP configuration and verification guidance; it never reads or modifies an unknown client file. |
| `pnpm formaspecctl support-bundle preview [--json]` | Produces a read-only exact inventory of bounded sanitized diagnostic entries. |
| `pnpm formaspecctl support-bundle create [OUTPUT.tar] --yes [--json]` | Creates the reviewed deterministic archive plus an adjacent local manifest; excludes databases, assets, backups, environment values, source, and credentials. |

The current `backup create/list/schedule/prune` CLI calls use the
credential-free loopback local API and are not a trusted-header server
administration client. In server mode, obtain the exact managed backup ID from
the authenticated Administration UI/API through the configured reverse proxy;
the external restore/status/recovery commands themselves do not use or reveal a
bearer or trusted identity credential.

Both restore paths are operations foundations, not release-qualified production recovery.
Managed restore is intentionally limited to the fixed Compose project and
launcher-recorded local-Docker/server bindings; unknown Compose deployments,
custom volumes, and orchestrators still require deployment-specific procedures. Automatic
supervisor installation/alerting, application autostart, native package
install/upgrade/uninstall, approved backup signing/provenance, and a migration
execution/rollback command are not implemented. The migration-status
reader is synchronized at version 11. Migration 9 adds the preview/run ledger
and guarded exact-delete contract; migration 10 adds immutable portable-import
provenance; migration 11 adds persistent bounded render-job lifecycle records.
None changes stored V1 revisions. The
copied version-7-to-8 migration
fixture preserves V1 revision bytes and hashes. A disposable local-Docker
restore exercise now passes; real customer fixtures, broader data verification,
server-supervisor evidence, and the full release E2E are still required.

## Compatibility `designer` wrapper

`designer` remains the source-install and compatibility entry point. Once the
FormaSpec CLI is built, it delegates `install`, `doctor`, `status`, `start`,
`stop`, `restart`, `migrate`, `agent`, and enterprise backup subcommands to
`formaspecctl`; audit-retention and support-bundle commands are delegated as
well. The CLI in turn calls the proven launcher implementation where
needed. Existing
`.designer` runtime state is reused rather than discarded.

The wrapper still directly owns legacy-only commands such as:

```bash
./designer logs
./designer logs --follow
./designer open
./designer server init --ssh-only
./designer server init --public-url https://designer.company.example
./designer backup
./designer version
```

`./designer codex-config` prints the older direct-MCP configuration and is not
the preferred FormaSpec integration. Use the bridge-based `formaspec` setup
described below. New `server init` output includes strict server/proxy values;
legacy secure env files are overlaid with equivalent Compose values without
rewriting the token-bearing file.

## Codex and MCP connection

Installation connects Codex automatically when the `codex` executable is
detected. If Codex was installed later, or connection was skipped, start
FormaSpec through the managed launcher and run:

```bash
./designer --yes agent connect codex
```

The resulting setup is:

- MCP server ID: `formaspec`;
- local bridge URL: `http://127.0.0.1:4312/mcp`;
- upstream FormaSpec MCP URL: `http://127.0.0.1:4310/mcp` by default;
- Codex mention: `[@Minimal UI](plugin://minimal-ui@formaspec)`;
- natural-language triggers include “Use FormaSpec,” “Use Minimal UI,” and
  “Design this with FormaSpec.”

The Codex MCP configuration contains no bearer token. The loopback bridge
creates a scoped, expiring agent connection and keeps the upstream grant in the
operating-system credential store:

- macOS: Keychain;
- Linux: Secret Service through `secret-tool`;
- Windows: a current-user DPAPI credential blob is implemented and fails closed
  without PowerShell or a private user-local storage root; real packaged
  service/ACL/lifecycle verification remains release work.

Bridge ownership state is stored in
`.designer/run/formaspec-bridge.json`; its log is
`.designer/logs/formaspec-bridge.log`. The credential itself is not written to
either file. The bridge accepts only loopback HTTP MCP upstreams, forwards a
small allowlist of MCP headers, enforces a 1 MiB request limit, and injects only
the stored upstream grant.

Automatic connection first reads the current organization policy. It refuses a
disabled Codex adapter, intersects requested scopes with `allowedScopes`, clamps
expiry to `maximumExpirySeconds`, honors active-connection limits, and includes
project IDs when `requireProjectRestriction` is enabled. If project restriction
is mandatory and no project exists, connection fails with an actionable error
instead of creating an unrestricted grant.

Automatic configuration currently targets Codex only. Other MCP clients can
use print-only JSON/TOML and verification instructions without any unknown file
mutation:

```bash
./designer agent config generic --format json
```

An authorized bridge connection must exist. Generic client-specific pairing
identity/scopes are not yet parameterized.

## Organization policy operations

The Administration workspace exposes the strict JSON policy editor. Updates
require the current configuration hash; concurrent or stale writes fail rather
than overwrite. Agents can read the same policy through MCP
`organization_policy_read` or `formaspec://organizations/current/policy`.
Organization Administrators can download a secret-free YAML representation from
`GET /api/organization/configuration`.

Current enforcement includes:

- legacy environment MCP-token enablement, adapters, scopes, expiry,
  connection limits, and project-restriction policy;
- exact trusted-header role mappings for `identity`, `external_id`, and
  `trusted_user` values;
- reauthorization of open SSE streams on each event and heartbeat;
- Codex pairing scopes, expiry, and required project IDs;
- asset MIME/byte/pixel limits and repository platform/exclusion/inventory
  limits;
- backup enablement/default schedule/retention and portable-bundle export/import
  enablement, token formats, and preview inclusion defaults.

Audit retention is available only to Organization Administrators through the
preview/execute REST and CLI paths. The executor never deletes within the
configured minimum, never prunes unpublished outbox rows or its own retention
evidence, and preserves policy-governance plus restore-recovery records that
remain operational inputs. It rejects policy, expiry, plan-hash, or candidate
drift. Large histories are processed as repeatable batches of at most 2,000
audit rows and 2,000 published-outbox rows, with at most 8 MiB of canonical
evidence per kind. Candidate sizing accounts conservatively for JSON escaping
before rows are materialized, and the final canonical bytes are checked again.
It is intentionally not an MCP agent tool.

Policy corruption after an audited policy update fails closed for agents,
repositories, assets, backups, and portable bundle export/import. Unknown legacy free-form
configuration without policy provenance is preserved but quarantined until an
administrator saves a valid replacement.

## Revision-pinned inspection

Open `/projects/:projectId/revisions/:revisionId/inspect` or call
`GET /api/projects/:projectId/revisions/:revisionId/inspect`. Authorization is
resolved against the project before the opaque revision ID is looked up. The
response reports the requested immutable revision separately from the current
head and includes revision/snapshot/operation hashes, schema/document versions,
node measurements and resolved token references, asset hashes, component
evidence, revision-linked business rules and acceptance criteria,
implementation mappings, stable IDs, and JSON paths. The PNG preview is pinned
to the same revision version.

Historical inspection does not borrow a later product specification or mapping.
If no specification was explicitly linked to that revision, the response says
so instead of presenting current-head data. Focused server/web coverage and a
browser scenario prove the view remains pinned after the head changes; broader
accessibility, authorization, large-project, cross-browser, and post-refactor
release evidence remains required.

## Portable project import

Portable import has a read-only validation step and a separate mutating step:

| Endpoint | Behavior |
| --- | --- |
| `POST /api/imports/validate` | Validates the uploaded `.formaspec.zip`, checks the strict manifest/document/checksum contract, and reports project metadata without creating project state. |
| `POST /api/imports?mode=conflict_fail` | Requires Organization Administrator access plus `Idempotency-Key`; preserves project-scoped IDs and fails atomically when the project or a render-ready asset ID already exists. This is the default mode. |
| `POST /api/imports?mode=clone` | Requires the same authorization/idempotency boundary and deterministically remaps project-scoped IDs from organization, bundle hash, and idempotency key. A different key intentionally creates a different clone. |

The Administration UI validates first, then lets the administrator preserve
IDs or create a deterministic clone and opens the imported project. Imported
V1/V2 documents start as local revision 1. An external V1 product specification
or the exact matching V2 embedded/sidecar specification starts as local product-
specification version 1. Render-ready PNG/JPEG/WebP bytes are fully decoded and
normalized through the isolated worker before database commit; unsupported
legacy assets stay metadata-only quarantine. Project, revision, product-
specification, import-provenance, audit, idempotency, and outbox rows share one
database transaction. Migration 10 stores the immutable source bundle hash,
source revision/hash claim, target revision, canonical ID map, manifest,
diagnostics, actor, and timestamp. The source revision hash is provenance data,
not a locally verified historical chain.

Current archive bounds are 256 MiB compressed, 256 MiB aggregate expansion,
64 MiB per entry, and 20,000 entries. Unsafe/duplicate paths, unsupported
compression/features/entry types, symlinks/directories, mismatched local and
central headers, invalid descriptors/CRCs, incomplete checksums, malformed JSON,
strict-schema mismatches, false sizes, trailing compressed data, and over-limit
bundles are rejected before mutation. Each entry is inflated in bounded 16 KiB
chunks. The multipart request body and extracted entry buffers remain in memory
within the caps; end-to-end body streaming, larger adversarial/concurrent-import
evidence, and packaged cross-platform proof remain release requirements.

## Health and readiness

| Endpoint | Meaning today | Important limitation |
| --- | --- | --- |
| `GET /health/live` | API process liveness. | Does not prove database or renderer readiness. |
| `GET /health/ready` | Reports database availability and the applied migration version. | It is a basic readiness response, not a full read/write or restore smoke test. |
| `GET /health/render` | Probes renderer health and reports worker/in-process mode, Playwright/software renderer, fallback policy, and warnings. Docker readiness fails when the separate worker is unavailable. | It is a bounded health probe, not a full 1440×900 render-performance or visual-correctness gate. |
| `GET /health` | Legacy compatibility liveness. | Retained for older clients; the image health check uses `/health/ready`. |
| `GET /ready` | Legacy compatibility readiness. | Retained for the launcher. |
| `GET http://127.0.0.1:4312/health` | Local bridge process and pairing state. | Does not by itself prove an MCP initialize/tool call succeeds upstream. |

Quick local checks:

```bash
curl --fail --silent --show-error http://127.0.0.1:4310/health/live
curl --fail --silent --show-error http://127.0.0.1:4310/health/ready
curl --fail --silent --show-error http://127.0.0.1:4310/health/render
curl --fail --silent --show-error http://127.0.0.1:4312/health
```

The container image runs `node apps/server/dist/container-healthcheck.js` for
readiness. The helper connects to the internal loopback port without
credentials. Local mode uses an allowed loopback `Host`; strict server mode
uses the exact `Host` derived from `PUBLIC_BASE_URL`, so a public-only Host
allowlist does not make Docker report a healthy API as unhealthy. Run the same
command with `docker compose exec designer` when diagnosing container health.
Do not add bearer tokens, trusted identity, Origin, cookie, or CSRF headers to
the health probe.

## Security modes

`APP_MODE` is strict and accepts only `local` or `server`.

### Local mode

`APP_MODE=local` is the default. `HOST` and `PUBLIC_BASE_URL` must both resolve
to loopback. Requests from non-loopback addresses are rejected, and browser
identity/proxy headers are deliberately ignored. Direct local MCP may operate
as the local actor; the managed Codex flow still uses a scoped grant through
the bridge.

Never publish a local-mode port to a LAN, public interface, ingress controller,
or untrusted container network.

### Server mode

`APP_MODE=server` refuses startup unless all of these conditions are met:

- `PUBLIC_BASE_URL` is HTTPS;
- `AUTH_MODE=trusted-header`;
- `DESIGNER_TOKEN` is configured for the compatibility MCP-token path;
- `FORMASPEC_TRUSTED_PROXIES` is non-empty;
- allowed hosts and exact browser origins are configured;
- the reverse proxy supplies the configured trusted identity header.

The application enforces the Host allowlist, exact CORS origins, trusted-proxy
interpretation, a CSRF intent header on browser API writes, CSP, HSTS, frame
denial, MIME sniffing protection, and a restrictive permissions policy.
Server deployments must prevent clients from reaching the application port
without passing through the authenticated proxy. See
[deployment.md](./deployment.md) and [SECURITY.md](./SECURITY.md).

Important variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_MODE` | `local` | Strict trust-boundary selector. |
| `HOST` | `127.0.0.1` | Must be loopback in local mode. |
| `PORT` | `4310` | API, UI, and upstream MCP port. |
| `DATA_DIR` | `./data` | SQLite and persistent application data root. |
| `BACKUP_DIR` | sibling `backups` directory | Backup-manager destination; the image sets `/backups` and Compose mounts a named backup volume there. |
| `PUBLIC_BASE_URL` | derived from host/port | Must be a loopback URL locally and HTTPS in server mode. |
| `AUTH_MODE` | `none` | Server mode requires `trusted-header`. |
| `DESIGNER_TOKEN` | unset | Minimum 16 characters when token/trusted-header mode is used. Never commit it. |
| `TRUSTED_USER_HEADER` | `x-designer-user` | Must be stripped from client input and set only by the trusted proxy. |
| `FORMASPEC_ALLOWED_HOSTS` | public URL host | Comma-separated exact `Host` values. |
| `FORMASPEC_TRUSTED_PROXIES` | unset | Required in server mode; use only verified proxy addresses/ranges. |
| `DESIGNER_CORS_ORIGINS` | local origins | Comma-separated exact browser origins. |
| `FORMASPEC_CSRF_HEADER` | `x-formaspec-csrf` | Browser API writes require value `1`. The web app sends it. |
| `MAX_UPLOAD_BYTES` | 5 MiB | Multipart upload limit. |
| `DESIGNER_MAX_ASSET_BYTES` | `MAX_UPLOAD_BYTES` | Optional canonical raster input/output byte limit; hard-capped at 64 MiB. |
| `DESIGNER_MAX_ASSET_PIXELS` | `FORMASPEC_RENDER_MAX_PIXELS` | Decoded raster pixel limit; it cannot exceed the renderer pixel limit or the 64,000,000 hard cap. |
| `DESIGNER_PREVIEW_TTL_SECONDS` | 900 | Preview lifetime in seconds. |
| `FORMASPEC_RENDER_TIMEOUT_MS` | 15,000 | Hard render timeout. |
| `FORMASPEC_RENDER_MAX_PIXELS` | 32,000,000 | Render output pixel limit. |
| `FORMASPEC_RENDER_IPC_MAX_BYTES` | 96 MiB | Maximum framed worker message. Startup rejects a value too small for the configured asset limit after base64 expansion. |
| `FORMASPEC_RENDER_CONCURRENCY` | 2 | Renderer-worker concurrency in Docker; source in-process concurrency when explicitly used. |
| `FORMASPEC_RENDER_QUEUE_LIMIT` | 32 | Maximum queued render requests. |
| `FORMASPEC_ALLOW_SOFTWARE_RENDERER` | false | Development-only fallback; keep disabled for release-like checks. |
| `FORMASPEC_ALLOW_SYSTEM_CHROME` | false | Optional source-development fallback to installed Chrome. |
| `FORMASPEC_CONTAINER_LOCAL` | false | Container-only local-mode exception for `HOST=0.0.0.0`/`::`; Compose enables it. It is forbidden in server mode. |

The API and renderer worker must receive the same asset, pixel, and IPC limits.
Their health response includes the renderer version, raster-normalizer version,
IPC protocol, and active normalization caps. A mixed build or mismatched limit
fails explicitly instead of silently changing normalization behavior.

## Data and runtime locations

| Mode | Application data | Runtime state and logs |
| --- | --- | --- |
| Source/native/dev | `./data`, including `designer.sqlite`, WAL files, and application assets | `./.designer/run`, `./.designer/logs`, and `./.designer/env` |
| Launcher Docker | Compose volumes `minimalappdesigner_designer-data` at `/data` and `minimalappdesigner_designer-backups` at `/backups` | Host-side `./.designer`; container logs through Compose |
| Direct Compose | Project-scoped `designer-data` and `designer-backups` volumes | Compose-managed state; no host bridge unless separately started |

SQLite uses WAL and foreign keys. Canonical revision snapshots are
content-addressed and Brotli-compressed in SQLite, and revisions form a hash
chain. Normalized raster bytes are stored under generated
`assets/sha256/<prefix>/<digest>.<ext>` paths with size/digest verification;
legacy SQLite BLOBs remain as a verified quarantine/compatibility fallback.
Treat the whole data directory as one recovery unit.

For a supervised Docker/server restore, `/backups/.formaspec` is also recovery
control state. It holds the path-free maintenance marker, durable restore
operation record, cutover journal, and shared worker lock outside the data
volume being replaced. Host state holds the exact mode-`0600` runtime binding at
`.designer/run/docker-runtime-binding.json`. Do not delete or edit those files
during an interrupted operation; use `backup restore status`, `resume`,
`rollback`, or the narrowly gated `abort`/`clear-stale-lock` commands.

The persistent event outbox is also in SQLite. `/events` and `/api/events`
support `Last-Event-ID`; the server replays authorized events or emits an
`events.gap` event instructing the client to refetch authoritative state.

Do not collect or share `.designer/env`, databases, backups, assets, browser
storage, environment dumps, or authorization headers. Although managed bridge
grants live in the OS credential store, `.designer` still contains private
paths, URLs, logs, and legacy server secrets.

## Diagnostics and logs

Start with:

```bash
pnpm formaspecctl doctor auto
pnpm formaspecctl status
```

Require an installed browser for source rendering checks:

```bash
pnpm formaspecctl doctor local --strict
```

Application logs are still exposed through the compatibility wrapper:

```bash
./designer logs
./designer logs --follow
```

Development logs stay attached to the terminal running `pnpm dev`. The local
bridge log is `.designer/logs/formaspec-bridge.log`.

Use `formaspecctl support-bundle preview` before any diagnostic archive is
created. Creation requires explicit `--yes`, uses fixed file/byte limits and
redaction, writes a local sidecar manifest, and excludes `.designer/env` values,
credential-store output, databases, assets, backups, source, and tokens. Review
the sidecar and sanitized logs before sharing. See
[SUPPORT_BUNDLES.md](./SUPPORT_BUNDLES.md).

## Migrations and upgrades

The server creates and validates a contiguous `schema_migrations` ledger and
applies pending numbered migrations during database startup in an immediate
transaction. It refuses a database whose newest migration is newer than the
application or whose ledger is not a recognized prefix.

For migrations 9 through 11, FormaSpec also validates the required tables,
columns, indexes, trigger targets, normalized table/trigger SQL, and removal of
forbidden legacy triggers. Startup validates before and after applying each
migration. Backup verification, restore preflight/control, and staged restore
validation use the same fail-closed schema-shape contract, so ledger-only
tampering is not accepted.

Migration 11 persists API-side render and raster-normalization job metadata.
Jobs move through `queued`, `running`, and terminal states with owner leases,
heartbeats, and expired-owner recovery. Stored rows contain bounded hashes,
versions, dimensions, warnings, and safe errors only—not documents, image/PNG
bytes, filesystem paths, or filenames. The renderer worker remains database-
free. Exact 30-day terminal retention is guarded by bounded delete permits.

`formaspecctl migrate status` is read-only and currently checks only the source
database at `./data/designer.sqlite`. Docker-volume inspection, migration
execution controls, maintenance locking, downgrade, and automated rollback are
not complete operator workflows.

Treat every source upgrade as a maintenance operation:

1. Create and retain a recoverable copy of all data.
2. Stop the application.
3. Test the new build and migrations against a disposable restored copy.
4. Update the source through the organization's normal process.
5. Install from the lockfile, then run tests, typecheck, build, and Compose
   configuration validation.
6. Start on loopback and validate health, representative designs, history,
   assets, SSE replay, Codex connection, and a real Chromium render before
   restoring access.

Do not run an irreversible V1-to-V2 project-head migration until the verified
backup/restore workflow and deterministic migration gate are complete.

## Backup reality

Two different mechanisms currently exist:

- The server backup library creates deterministic `.tar` bundles with a
  manifest, checksums, an online SQLite backup, assets, and secret-free
  organization configuration. Verification now checks exact archive and asset
  coverage, normalized files and legacy BLOB fallback, canonical strict V1/V2
  snapshots, typed operations, revision hash chains, and exact project heads.
  Organization Administrators have authenticated list/create/verify/download,
  supervisor-run schedule, and preview-first retention APIs. The enforced policy
  comes from the strict organization policy (default 7 daily, 4 weekly, and 12
  monthly); manual backups are exempt. Disabling backups blocks manual creation
  and schedule enablement/run, while schedule reads expose the effective policy
  default when no stored override exists.
- `formaspecctl backup restore <bundle> --yes` provides the stopped
  source-local atomic path with a compatibility safety copy. For the
  launcher-recorded local-Docker or server runtime, the
  `backup restore --backup-id <id> --yes` command externally controls
  maintenance, stops only the API, runs the
  network-disabled one-shot worker, creates a verified managed safety backup,
  performs current-schema/database/Chromium verification, reconciles
  audit/outbox state, revokes restored agent credentials, and restarts before
  clearing maintenance.
- `./designer backup [DESTINATION]` is the legacy fallback. It stops the
  recorded Docker container before copying `/data`, or requires the native
  server to be stopped, then writes a simple directory manifest. It is not the
  verified FormaSpec bundle format accepted by `formaspecctl backup verify`.

The managed path accepts only an opaque ID from the recorded backup catalog and
the exact runtime binding captured after current `formaspecctl` local-Docker or
server startup. It refuses unknown/direct Compose projects, custom project
names, guessed volumes, stale secure environments, and unrecognized
orchestrators. Every binding capture and verification inspects the named data,
backup, and renderer-socket volumes and requires the Docker `local` driver and
scope, no driver options, bounded absolute mountpoints, and three distinct
backing identities. Plugin, NFS, bind-backed, or aliased volumes fail closed.
Server automation/alerting and clean planned-recovery
evidence remain operator/release work even though the supervised command path
is implemented.

The current Docker/server path is `HEALTHY_PLANNED_RESTORE_ONLY`. It resolves
the opaque backup ID and performs target preflight through the healthy current
API/database before entering maintenance. A stopped or corrupt API/database
cannot use this path even when a valid bundle exists. Offline disaster recovery
requires a separately designed and authorized operator workflow.

On 2026-07-20, an isolated Compose project on port `4397` restored
`backup_0dda1a60c54c5805557426a428739e505e089425` in operation
`restore_e2ea0123456789abcdef0123456789`, proving that post-backup design B was
removed while design A retained its IDs and revision. It then restored safety
backup `backup_7697fb29100b0bc8adc22707114c50947ed3a668` in operation
`restore_e2eb0123456789abcdef0123456789`, proving that A and B returned with
their original IDs/revisions. One grant, connection, and nonce were atomically
revoked; the connection stayed revoked after the safety restore, and all
disposable containers, volumes, and the network were deleted.

That evidence is specific to launcher-local Docker. Its worker opens the source
with `O_NOFOLLOW`, copies and hashes it into a private mode-`0700` directory on
`/backups`, changes the pinned bundle to mode `0400`, validates the expected
managed size and SHA-256, and uses only those pinned bytes for journal matching,
verification, and extraction. The source-local CLI likewise hashes the exact
verified tar stream and passes its expected SHA-256/size into the same pinning
engine. Managed downloads also stream a private opened pin rather than the
replaceable managed pathname. The valid-bundle pathname-swap regression test
passes. Bundles are still unsigned, so their integrity checks do not establish
provenance. Follow
[BACKUP_AND_RESTORE.md](./BACKUP_AND_RESTORE.md), and do not treat the current
foundation as release recovery evidence.

## Docker/server restore operations

Start from an exact managed backup ID:

```bash
pnpm formaspecctl backup list
pnpm formaspecctl backup restore --backup-id backup_<40-lowercase-hex> --yes
```

Install, local-Docker/server start, and restart capture a mode-`0600` exact runtime binding
at `.designer/run/docker-runtime-binding.json`. Restore refuses to proceed if
that binding is absent or does not match the Docker context/daemon, image
digest, container and Compose identities, project path, named volumes, renderer
isolation, loopback-published port, recorded mode, secret-redacted environment identity SHA-256,
or required health `Host`. Live volume inspection also revalidates the local
driver/scope, empty options, bounded absolute mountpoints, and distinct backing
identities for data, backup, and renderer-socket volumes. Binding format 2
contains no bearer token; v1 local
bindings remain readable and are upgraded in memory. This prevents restore from
drifting to an ambient Compose project, stale server configuration, or guessed
volume.

The supervisor requires a healthy current API/database, starts/verifies the
pinned renderer, and performs a read-only
target preflight before creating maintenance, including a conservative
whole-workflow capacity forecast for the safety backup, source pin,
verification extraction, and candidate data. Each later copy/extraction step
rechecks capacity. After fencing and stopping only
the API, it launches the worker with hardened direct `docker run` against the
exact pinned image and volumes; it does not delegate recovery to ambient
Compose discovery. Each health request has its own absolute wall-clock deadline.
The launcher lock refuses symlinks or unexpected state without recursively
removing an unvalidated path. If a pre-cutover resume or rollback worker fails
after maintenance aborts, the supervisor restarts and verifies the unchanged
API; a simultaneous restart failure is reported as an aggregate failure rather
than hiding either cause.

Maintenance is fail-closed and has no automatic expiry. While active,
`/api/*`, `/mcp`, and replayable event endpoints return retryable
`TEMPORARILY_UNAVAILABLE`; readiness performs database, migration, and renderer
checks while returning maintenance `503` with the exact operation ID. Liveness
and renderer health remain available. The API is restarted under this fence,
and only a durable `reconciled` or `rolled_back` operation can authorize the
control process to remove the marker.

The one-shot worker owns the shared non-expiring lock
`/backups/.formaspec/restore-worker.lock.json`; the API refuses to open SQLite
while it exists or while cutover is incomplete. Durable operation state moves
through `prepared`, `cutover_committed`, `reconciled`, or `rolled_back`.
Committed-cutover retries repeat health verification before cleanup. If
pinned-source cleanup fails after a successful cutover, the committed journal
is retained for that retry. Exact source-pin orphan directories are preserved
while a durable `prepared` or `cutover_committed` operation is active, and the
credential-revocation postcondition is repeated after restored audit/outbox
triggers have run. Maintenance removal is always the final state mutation.

On any interruption, do not manually start another restore or remove files.
Inspect the durable state:

```bash
pnpm formaspecctl backup restore status
pnpm formaspecctl backup restore status --json
```

Status validates the pinned runtime before reading recovery state.

Resume the same operation after reviewing Compose/API/renderer logs:

```bash
pnpm formaspecctl backup restore resume --yes
```

If status says the interruption preceded the durable operation record, supply
the original target ID exactly:

```bash
pnpm formaspecctl backup restore resume \
  --backup-id backup_<40-lowercase-hex> \
  --yes
```

After a conclusive completed restore, restore the verified pre-restore safety
backup only through the explicit rollback command:

```bash
pnpm formaspecctl backup restore rollback --yes
```

If preflight created maintenance but no operation, journal, or worker-lock
evidence, clear only that empty attempt with:

```bash
pnpm formaspecctl backup restore abort --yes
```

If a valid lock remains after the pinned supervisor proves its exact worker
container is absent, clear only that proven-stale lock with:

```bash
pnpm formaspecctl backup restore clear-stale-lock --yes
```

Both commands fail closed on conflicting or uncertain evidence.

An inconclusive operation must be resumed first so the journal can finish or
prove rollback. A successful restore or rollback revokes all restored grants,
connections, and pairing nonces; reconnect Codex through a fresh authorization:

```bash
pnpm formaspecctl agent connect codex --yes
```

The bridge is stopped before managed restore and is not silently re-authorized.
Keep the safety backup and operation record until the restored application and
Codex reconnection have been independently checked.

## Common failures

### Service does not become ready

```bash
pnpm formaspecctl status
pnpm formaspecctl doctor auto
./designer logs
```

Check port ownership, the data-directory permissions, Docker daemon state, and
the first configuration error in the log. Strict configuration failures are
intentional; do not bypass loopback, HTTPS, trusted-proxy, Host, or Origin
checks merely to make a service start.

### Restore maintenance remains active

This is the safe failure mode; do not delete
`/backups/.formaspec/maintenance.json` or restore-journal files manually.

```bash
pnpm formaspecctl backup restore status
docker compose logs designer renderer
```

If status identifies an unfinished operation, use `backup restore resume --yes`
and add the original `--backup-id` only when status says no durable operation
record exists. Use `backup restore rollback --yes` only after the original
operation reaches a conclusive state. Use `backup restore abort --yes` only
when status proves that no operation, journal, or worker-lock evidence exists.
Use `backup restore clear-stale-lock --yes` only after the pinned supervisor
proves the recorded worker container is absent. Invalid or mismatched state
requires operator inspection rather than automatic cleanup.

### Chromium render fails

Run `pnpm formaspecctl doctor local --strict`. Source setup can install the
pinned Playwright Chromium. Software rendering is disabled by default and
must remain disabled for release-like validation. `/health/render` only reports
configuration; verify an actual representative PNG render.

### Codex connection fails

Confirm that the API and CLI-owned bridge are running, then inspect
`.designer/logs/formaspec-bridge.log`. Verify the Codex CLI is on a trusted
absolute `PATH` and that an unmanaged `minimal-ui` skill or `formaspec`
marketplace is not blocking the managed installation. The connector refuses to
overwrite unmanaged content.

### Version conflict

Do not replay operations against a stale base. Read the current head, create a
new preview, inspect/render/lint it, and commit with the new expected base.
FormaSpec does not auto-merge.

### SSE replay gap

Treat `events.gap` as an instruction to refetch the authorized project head,
active context, and any open preview/task state. Do not infer missing changes
from later event IDs.

## Release blockers

Production readiness remains **NO-GO** until all of the following are resolved
and evidenced:

- add real Windows named-pipe/native renderer/service-host/ACL/process-tree
  packaging and continuous egress/crash/saturation/load evidence beyond the verified local
  network-denied Docker worker;
- finish and verify strict server-mode reverse-proxy, direct-port denial,
  `HEALTHY_PLANNED_RESTORE_ONLY`/rollback, upgrade, alerting, and long-running
  Compose evidence; add a separately authorized offline disaster-recovery path;
  the planned command path exists but has not passed that release matrix;
- extend browser and visual-regression coverage beyond the passing 20-step
  local scenario and zoom/pan/DPR/RTL alignment foundations to the full
  invalidation, auto-layout, fractional-group, and cross-platform matrix;
- run the already-passing 1,000-node browser budgets in pinned release CI
  images across supported platforms and retain their reports/profiles;
- extend the recorded disposable local-Docker A/B restore exercise beyond the
  passing source-local 20-step V1/V2/product/task/hash/render scenario to the
  full asset/design-system/historical-fixture/failure-injection matrix;
  add trusted signing/provenance where required; and finish server supervision,
  alerting, retention failure recovery, and packaged operator workflows;
- finish operator-approved migration/cleanup of legacy asset BLOB quarantine
  and expand malformed-raster/upload-storm evidence; worker-backed full decode
  now covers backup creation/verification and restore preflight/cutover;
- reduce portable-import peak memory beyond the bounded per-entry inflater by
  streaming multipart bodies and avoiding simultaneous retention of all
  extracted entries; retain larger adversarial/concurrent-import and packaged
  cross-platform evidence;
- rebuild the stale schema-10 unsigned macOS candidate and promote it only after its
  five recorded blockers are resolved, then ship and test release-ready macOS
  PKG, Windows MSI, Linux DEB/RPM, autostart, upgrade, uninstall, reinstall,
  signing, and notarization paths. Linux and Windows source builders exist, but
  real artifacts/lifecycles remain unproven;
- verify Windows DPAPI in the packaged service lifecycle on clean hosts;
- complete framework-aware Workspace Bridge mappings and the broader approved
  plan/diff/validation/commit/PR flow around the implemented selected-workspace
  Codex launch; connected grants now persist path-free inventories automatically;
- complete the seven-stage Redesign Studio and the broad product-spec/planning/
  task UI;
- produce the comprehensive authorization, CSRF, Host/Origin, asset,
  renderer-egress, archive, traversal, decompression, secret-exclusion, and
  prompt-injection security evidence;
- produce artifact-specific container/native SBOMs, dependency/image/OS scans,
  reproducibility, signed provenance, and release-artifact evidence with no
  unresolved critical/high findings; the Sharp-free source-workspace gate now
  passes.

# FormaSpec operations

Last audited: 2026-07-22

FormaSpec is the product name and the only supported agent-facing identity used
by Codex and other MCP-capable clients.

## Operational status

The repository has working enterprise foundations, including numbered SQLite
migrations, content-addressed revision snapshots, revision hash chains,
organization/project authorization, scoped agent grants, durable SSE replay,
strict organization-policy enforcement, local/server configuration validation,
bounded Chromium rendering, and the first `formaspecctl`, local-bridge, and
Workspace Bridge workflows.

It is **not production-ready**. The current supported use is local development
and controlled evaluation. Docker separates API and renderer and now includes
externally supervised planned and offline one-shot restore-worker foundations
for the exact launcher-recorded local-Docker or server runtime. Managed-ID
restore remains explicitly `HEALTHY_PLANNED_RESTORE_ONLY`, while
`backup restore offline <bundle> --yes` can recover without opening the current
database. Release-qualified native installers, clean server-mode planned/
offline restore evidence, signed provenance, security/browser/performance
matrices, and complete release evidence remain unfinished. A historical
disposable local-Docker A/B restore exercise passed, but it does not qualify the
server path or close the broader recovery gate. A historical controlled actual-
socket proxy lifecycle passed 1/1 for overwrite/strip, direct-peer denial, append rejection,
and restart-bound secret rotation; it is not real Nginx/TLS/public-port proof. See
[Release blockers](#release-blockers).

Current schema-16 package tests pass 842/842 across core 59, server 467, web 91,
CLI 96, local bridge 20, Workspace Bridge 37, and installer 72. All seven
workspace typechecks/builds, launcher 225/225, and `docker compose config
--quiet` pass. Editor/Administration E2E passes 5/5, current-schema release E2E
1/1, server preview integration 2/2, Chromium and Firefox/WebKit alignment
12/12 each, visual regression 7/7, the 1,000-node browser budgets, and macOS
runtime-smoke contracts 11/11. Current local Docker restart/egress and copied-
bundle recovery checkpoints also pass. The exact schema-13 SBOM/license result
remains historical; hosted supported-OS runs, current security/SBOM/image/OS
scans, signed native lifecycle evidence, and real remote-host/TLS recovery are
still open.

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
the loopback bridge, detect Codex, and configure the managed FormaSpec 0.4.0
plugin when Codex is available. `--yes` grants that explicit setup
authorization without further prompts. Automatic tool approval is scoped only
to the trusted local `formaspec` MCP entry; global Codex approval and sandbox
settings are not changed.

The source installer currently needs Node.js 24 or newer and pnpm 11.9 even
when the selected application runtime is Docker, because `formaspecctl` and the
host-side local bridge are built from this checkout. Native packages are
designed to bundle their runtime. The retained pre-current-SSE-authorization
unsigned macOS ARM64 PKG under `artifacts/candidates/schema12-current/` passed
its frozen source/license, package-integrity, and non-installing extracted-
runtime gates; current-source verification now records expected drift. It is SHA-256
`9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`
and 185,279,180 bytes. It was not installed and remains `NO-GO`: Chromium
LGPL-notice approval, vulnerability scanning, signing/notarization,
independent reproducibility, and clean privileged lifecycle evidence are open.
A same-host repeat had identical payload/workspace trees but different outer
PKG bytes. The preserved schema-11 and schema-10 candidates are historical.
Linux DEB/RPM and Windows WiX v4 builder foundations exist in source, but no current Linux or
Windows artifact/lifecycle evidence qualifies them for release. See
[Linux packaging](./LINUX_PACKAGING.md) and
[Windows packaging](./WINDOWS_PACKAGING.md).

The launcher supports macOS, Linux, and WSL2. Native Windows shells are not
supported by the source launcher. Docker Desktop/Engine and Compose v2 must
already be installed for Docker mode; the launcher can start an installed
daemon but does not install Docker itself.

Engineering-only native builder entry points are:

```bash
pnpm package:linux:deb
pnpm package:linux:rpm
```

Run those only on the matching native Linux target with `dpkg-deb` or
`rpmbuild` available. Their `--help` output is available on non-Linux hosts
without starting a build. On native Windows, `pnpm package:windows:msi -- <required
arguments>` invokes the unvalidated WiX foundation described in
[WINDOWS_PACKAGING.md](./WINDOWS_PACKAGING.md); it requires caller-supplied
application/service-host/WiX inputs and does not prove MSI validity or lifecycle.
None of these commands produces a release-approved artifact by itself.

The Compose file passes the strict mode variables, uses an explicit
`FORMASPEC_CONTAINER_LOCAL` exception for an API container whose host-published
port remains loopback-only, mounts data/backup/socket volumes, and runs a
separate non-root, read-only, capability-free, network-disabled renderer with
resource limits. Historical disposable schema-13 project
`formaspeccischema13da9af9d064` used image
`sha256:166d74686a8ebd52c2765d0c12b362690717af8488a7a4b83f0f1e348d620b97`,
preserved design `document_e171c68c7a4c4b3b80a5493a6180e28f` at revision
`revision_85e2776ca3874f1c98097b6917bc3649` across API restart, and produced
the same 512×339 PNG SHA-256
`cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`.
The renderer failed egress closed with DNS `EAI_AGAIN`, TCP `ENETUNREACH`, and
zero external interfaces; cleanup passed. Summary:
`/private/tmp/formaspec-docker-schema13-20260721-current/summary.json`, SHA-256
`13c608ce5ddec282d8e0b8497d54f9971f4f20764d035122ea5e64dfd31f1e0f`.

The same image passed Firefox/WebKit 12/12; summary SHA-256
`c128ee3f6a7341cd75189dba612d6b01d25abd2b57fb26db1970c152f1f665bc`.
It also passed copied-bundle recovery from `formaspecdrsource3af2259e48` to
`formaspecdrtarget3af2259e48` with exact snapshot/revision/asset/render/SQLite/
foreign-key equality and complete cleanup. Bundle SHA-256 was
`b87d44e7b0584dd0a14e5b47d07cf447490a683ab512f983feb4e2a19c0a6ef3`;
the `NO-GO` summary SHA-256 was
`1dfecf9b4a4773fed25f73eaa181bc88e30fc21df8b0679c3325241af3ccd433`.

Those schema-13 runs remain historical. Current schema-16 local evidence uses
image `sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1`.
Its Docker, cross-browser, and copied-bundle summaries are retained at
`artifacts/ci/docker-schema11/summary.json`,
`artifacts/ci/cross-browser-docker/summary.json`, and
`artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json`; the legacy
`docker-schema11` path is intentional. Deterministic restart rendering,
DNS/TCP/interface egress denial, Firefox/WebKit 12/12, SQLite integrity/foreign
keys, asset/snapshot/revision hashes, render equality, and cleanup pass. These
remain local uncommitted-source `NO-GO` checkpoints. Server-mode proxy/restore,
real remote-host/TLS/off-site recovery, broader fixtures, upgrade, saturation,
and long-running security evidence remain incomplete. Do not weaken the host
binding or publish the port.

## Source development

After dependencies are installed:

```bash
pnpm dev
```

That default keeps local loopback `AUTH_MODE=none` for the simplest source
workflow. To exercise the migration-14 login/bootstrap/session boundary
locally, start development with:

```bash
APP_MODE=local \
AUTH_MODE=session \
HOST=127.0.0.1 \
PUBLIC_BASE_URL=http://127.0.0.1:4310 \
FORMASPEC_WEB_BASE_URL=http://127.0.0.1:4311 \
pnpm dev
```

Open the editor and create the sole local Organization Administrator when
prompted. Local session mode does not use a public-server bootstrap token.

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
| `pnpm formaspecctl ensure-running [--json]` | Fixed-purpose Codex/protocol preflight. It resumes only the recorded local, development, Docker, or server runtime, verifies its stable data-store identity and loopback bridge, and refuses to guess or fall back to another storage mode. |
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
| `pnpm formaspecctl backup restore --backup-id <id> --yes [--json]` | Externally supervises `HEALTHY_PLANNED_RESTORE_ONLY` for the exact launcher-recorded local-Docker or server runtime. It fences traffic, stops only the pinned API container, runs the network-disabled one-shot worker, creates a verified managed safety backup, verifies exact schema/readiness/renderer state with the configured Host, revokes restored agent credentials, restarts under maintenance, and clears maintenance only after readiness succeeds. The current API/database must be healthy for backup-ID resolution and preflight. |
| `pnpm formaspecctl backup restore offline <bundle> --yes [--json]` | Separately authorizes offline recovery from an operator-selected verified bundle. The CLI pins the verified regular file by identity/hash/size and streams it only through worker stdin; the worker fully verifies the target, captures a verified exact forensic pre-state bundle even when SQLite is corrupt, then uses the standard cutover, schema/render checks, audit/outbox reconciliation, credential revocation, and readiness gate. |
| `pnpm formaspecctl backup restore status [--json]` | Reads the path-free maintenance marker and durable restore-operation state through a one-shot control process; it does not clear or mutate recovery state. |
| `pnpm formaspecctl backup restore resume [--backup-id <id> \| --offline-bundle <bundle>] --yes [--json]` | Resumes the exact active pinned Docker/server operation. `--backup-id` is used for a planned interruption before durable preparation; `--offline-bundle` re-pins the same explicitly selected bundle when offline preparation did not complete. |
| `pnpm formaspecctl backup restore rollback --yes [--json]` | Restores the verified managed safety backup for planned recovery. For an offline recovery it restores the exact forensic pre-state bytes, keeps maintenance active and the API stopped, and deliberately returns `maintenanceCleared: false`/`serviceReady: false` because the old bytes may contain the original corruption. A newly verified offline restore may atomically take over that fence. |
| `pnpm formaspecctl backup restore abort --yes [--json]` | Cancels only pristine or prepared pre-cutover state after proving there is no journal/worker lock and re-verifying the unchanged live database. It is not a force-abort and cannot unfence corrupt offline pre-state or a completed forensic rollback. |
| `pnpm formaspecctl backup restore clear-stale-lock --yes [--json]` | Removes only a valid matching worker lock after the pinned Docker supervisor proves the exact worker container no longer exists. |
| `pnpm formaspecctl audit retention preview [--json]` | Produces a 15-minute, organization-scoped, bounded dry-run using the current audit-retention policy, exact candidate counts/ranges, canonical-byte hashes, and a plan hash. |
| `pnpm formaspecctl audit retention list [--json]` | Lists immutable retention-run evidence and SHA-256 chain hashes without exposing deleted audit contents. |
| `pnpm formaspecctl audit retention execute --preview-id <id> --plan-hash <sha256> --yes [--idempotency-key <key>] [--json]` | Revalidates and atomically commits only the reviewed old audit/published-outbox batch, then records immutable hash-chained evidence. |
| `pnpm formaspecctl agent connect codex [--pairing-nonce <nonce>] [--connection-id <id>] [--yes]` | Starts or refreshes the bridge, consumes an Administration-issued ticket in authenticated mode, installs and verifies the single managed FormaSpec 0.4.0 plugin, removes only installer-owned legacy identities, saves MCP server `formaspec` with server-scoped automatic approval, and verifies the credential-free Codex configuration without changing global approval or sandbox policy. `--connection-id` is optional but valid only with a nonce. |
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
Managed restore is intentionally limited to the exact persisted Compose project
and launcher-recorded local-Docker/server bindings; unknown Compose deployments,
custom volumes, and orchestrators still require deployment-specific procedures. Automatic
supervisor installation/alerting, application autostart, native package
install/upgrade/uninstall, approved backup signing/provenance, and a migration
execution/rollback command are not implemented. The migration-status
reader is synchronized at version 16. Migration 9 adds the preview/run ledger
and guarded exact-delete contract; migration 10 adds immutable portable-import
provenance; migration 11 adds persistent bounded render-job lifecycle records;
migration 12 adds append-only handoff execution decisions with immutable CAS
chains and independently scoped authorization. Migration 13 adds canonical
component source JSON/hash persistence and exact design-system upgrade snapshot
references without fabricating legacy values. Migration 14 adds the single-
administrator password account, browser sessions, bounded persistent login-
attempt buckets, and one-time public-server bootstrap credential without
fabricating an administrator or active session. Migration 15 adds bounded,
write-once exact preview-render options, dimensions, renderer backend, warnings,
and PNG SHA-256 without fabricating evidence for historical previews.
Migration 16 safely replaces the legacy schema-14/15 bootstrap-credential
trigger with its canonical consume-once definition while preserving credential
rows and failing closed on schema-shape drift.
None changes stored V1 revisions. The
copied version-7-to-8 migration
fixture preserves V1 revision bytes and hashes. A historical disposable local-
Docker restore exercise passed; real customer fixtures, broader data verification,
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
./designer server init --public-url https://designer.company.example --trusted-header
./designer backup
./designer version
```

`./designer codex-config` prints the older direct-MCP configuration and is not
the preferred FormaSpec integration. Use the bridge-based `formaspec` setup
described below. New `server init` output includes strict server/proxy values;
legacy secure env files are overlaid with equivalent Compose values without
rewriting the token-bearing file. A public URL now defaults to session
authentication and emits the one-time `setup#bootstrap=…` URL. Use
`--trusted-header` only for the existing SSO alternative.

## Codex and MCP connection

Installation connects Codex automatically in local `AUTH_MODE=none` when the
`codex` executable is detected, and authenticated startup can reuse an exact
still-valid stored grant. Creating or rotating a connection in an authenticated
mode requires a website-issued ticket:

1. Sign in as an Organization Administrator and open `/administration`.
2. Choose **Connect Codex** or **Reconnect**.
3. Allow the `formaspec://connect-agent` handler to run, or copy the exact
   fallback command shown by the website.

The fallback has this form:

```bash
./designer --yes agent connect codex \
  --pairing-nonce <pairing-nonce> \
  --connection-id <connection-id>
```

The resulting setup is:

- MCP server ID: `formaspec`;
- local bridge URL: `http://127.0.0.1:4312/mcp`;
- upstream FormaSpec MCP URL: `http://127.0.0.1:4310/mcp` by default;
- primary Codex mention: `[@FormaSpec](plugin://formaspec@formaspec)`;
- installed managed identity: FormaSpec version 0.4.0;
- recommended natural-language triggers: “Use FormaSpec,” “Design this with
  FormaSpec,” and “Refine this selection with FormaSpec.”

The website does not create agent tasks. Codex or the CLI creates the task
through MCP after exact Product/Design selection confirmation, then claims it,
previews the requested change, inspects the PNG, runs linting, and transitions
to `awaiting_approval` with the exact `previewId`. It does not commit or
complete the task. The human **Commit** or **Discard** action in FormaSpec is
the approval boundary.

The Codex MCP configuration contains no bearer token. Administration creates
the scoped, expiring connection and one-time nonce. The loopback bridge submits
only that nonce to exact `POST /api/agent-connections/pair`, verifies the
optional expected connection ID and returned authorization context, and keeps
the upstream grant in the operating-system credential store:

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

Only the one-time `/api/agent-connections/pair` route is accessible to the
headless bridge without browser identity. Connection creation, reconnect, and
revoke remain Organization Administrator browser operations with the active
session/trusted-header CSRF boundary. In authenticated mode, the CLI without a
ticket may reuse an exact still-valid stored grant but cannot self-create or
rotate a connection. Local `AUTH_MODE=none` retains the legacy evaluation flow.

Automatic configuration currently targets Codex only. Other MCP clients can
use print-only JSON/TOML and verification instructions without any unknown file
mutation:

```bash
./designer agent config generic --format json
```

An authorized bridge connection must exist. Generic client-specific pairing
identity/scopes are not yet parameterized.

## Organization policy operations

The Administration workspace exposes a guided 12-section policy form plus an
Expert JSON view. Updates require the current configuration hash; concurrent
or stale writes fail rather than overwrite. Agents can read the same policy
through MCP
`organization_policy_read` or `formaspec://organizations/current/policy`.
Organization Administrators can download a secret-free YAML representation from
`GET /api/organization/configuration`.

Current enforcement includes:

- legacy environment MCP-token enablement, adapters, scopes, expiry,
  connection limits, and project-restriction policy;
- exact trusted-header role mappings for `identity`, `external_id`, and
  `trusted_user` values, with duplicate effective identities rejected across
  those aliases before policy/audit/outbox mutation;
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
64 MiB per entry, and 20,000 entries. The multipart body is streamed to a
private mode-`0700` directory and mode-`0600` archive file while SHA-256 and
size are computed. ZIP directory inspection uses bounded reads; entries inflate
one at a time in 16 KiB chunks into private files and remain represented by
pinned size/hash metadata. Unsafe/duplicate paths, unsupported
compression/features/entry types, symlinks/directories, mismatched local and
central headers, invalid descriptors/CRCs, incomplete checksums, malformed JSON,
strict-schema mismatches, false sizes, trailing compressed data, and over-limit
bundles are rejected before mutation. The request body and complete extracted
set are no longer held in memory simultaneously. Individual bounded JSON or
raster entries are read when parsed or normalized. Larger adversarial/
concurrent-import evidence and packaged cross-platform proof remain release
requirements.

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

`APP_MODE=local` is the default. `HOST`, `PUBLIC_BASE_URL`, and
`FORMASPEC_WEB_BASE_URL` must resolve to loopback. Requests from non-loopback
addresses are rejected, and browser
identity/proxy headers are deliberately ignored. `AUTH_MODE=none` preserves
the simplest no-login workflow. `AUTH_MODE=session` adds the migration-14
browser bootstrap/login/CSRF boundary while remaining loopback-only. Direct
local MCP may operate as the local actor; the managed Codex flow still uses a
scoped grant through the bridge.

Never publish a local-mode port to a LAN, public interface, ingress controller,
or untrusted container network.

### Server mode

`APP_MODE=server` refuses startup unless all of these conditions are met:

- `PUBLIC_BASE_URL` is HTTPS;
- `FORMASPEC_WEB_BASE_URL` is the same credential-free HTTPS origin;
- `AUTH_MODE=session` or `AUTH_MODE=trusted-header`;
- `FORMASPEC_TRUSTED_PROXIES` is non-empty;
- allowed hosts and exact browser origins are configured;
- `FORMASPEC_PROXY_SECRET` is configured separately from every browser/agent
  credential;
- a fresh session deployment has the installer-generated
  `FORMASPEC_BOOTSTRAP_TOKEN_HASH`, or trusted-header mode has its configured
  identity header and MCP compatibility bearer token.

The application enforces the Host allowlist, exact CORS origins, trusted-proxy
interpretation, mode-appropriate CSRF on browser API writes, CSP, HSTS, frame
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
| `FORMASPEC_WEB_BASE_URL` | `PUBLIC_BASE_URL` | Browser origin used for task/review links. Development uses the Vite origin on `4311`; server mode requires the same HTTPS origin as `PUBLIC_BASE_URL`. Credentials, queries, fragments, and path prefixes are rejected. |
| `AUTH_MODE` | `none` | Local supports `none` or `session`; server requires `session` or `trusted-header`. Fresh public initialization defaults to `session`. |
| `DESIGNER_TOKEN` | unset | Minimum 16 characters and required for `token`/`trusted-header`. Session mode uses scoped Agent Connections for MCP and should normally leave this unset. Never commit it. |
| `FORMASPEC_PROXY_SECRET` | unset | Required only in server trusted-proxy mode; 32–256 safe characters, separate from `DESIGNER_TOKEN`, injected as `x-formaspec-proxy-secret`, and never sent by browsers or agents. |
| `FORMASPEC_BOOTSTRAP_TOKEN_HASH` | unset | Server-session-only lowercase SHA-256 generated by `server init`; a fresh public database refuses bootstrap without it. Never substitute the plaintext token. |
| `TRUSTED_USER_HEADER` | `x-designer-user` | Used only by trusted-header mode; must be stripped from client input and set only by the trusted proxy. |
| `FORMASPEC_ALLOWED_HOSTS` | public URL host | Comma-separated exact `Host` values. |
| `FORMASPEC_TRUSTED_PROXIES` | unset | Required in server mode; use only verified proxy addresses/ranges. Raw-peer trust is insufficient without the internal proxy secret. |
| `DESIGNER_CORS_ORIGINS` | local origins | Comma-separated exact browser origins. |
| `FORMASPEC_CSRF_HEADER` | `x-formaspec-csrf` | Session writes require the exact per-session value; trusted-header writes require `1`. The web app sends the correct mode-specific value. |
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
| `FORMASPEC_RUNTIME_DIR` | source: `./.designer`; packaged: platform wrapper | Absolute CLI/bridge runtime-state root. Relative and empty overrides fail closed. |
| `FORMASPEC_DATA_DIR` | source: `./data`; packaged: platform wrapper | Absolute data root used by packaged migration diagnostics. |
| `FORMASPEC_BACKUP_DIR` | source: `./.designer/backups`; packaged: platform wrapper | Absolute operator backup root reserved for supervised workflows. |
| `FORMASPEC_LOG_DIR` | source: `./.designer/logs`; packaged: platform wrapper | Absolute allowlisted log root used by bridge and support-bundle diagnostics. |
| `FORMASPEC_SUPPORT_DIR` | source: `./.designer/support-bundles`; packaged: platform wrapper | Absolute default output root for explicitly authorized support bundles. |

The API and renderer worker must receive the same asset, pixel, and IPC limits.
Their health response includes the renderer version, raster-normalizer version,
IPC protocol, and active normalization caps. A mixed build or mismatched limit
fails explicitly instead of silently changing normalization behavior.

## Data and runtime locations

| Mode | Application data | Runtime state and logs |
| --- | --- | --- |
| Source/dev | `./data`, including `designer.sqlite`, WAL files, and application assets | `./.designer/run`, `./.designer/logs`, and `./.designer/env` |
| Native macOS package | `~/Library/Application Support/FormaSpec/data` and `.../backups` | `~/Library/Application Support/FormaSpec/runtime`, `.../logs`, and `.../support-bundles` |
| Native Linux package | `/var/lib/formaspec/data` and `/var/lib/formaspec/backups` | Service runtime `/run/formaspec`; per-user CLI/bridge state under `$XDG_STATE_HOME/formaspec` or `~/.local/state/formaspec`; service logs in journald |
| Launcher Docker | Persisted project-scoped Compose volumes such as `<compose-project>_designer-data` at `/data` and `<compose-project>_designer-backups` at `/backups` | Host-side `./.designer`; container logs through Compose |
| Direct Compose | Project-scoped `designer-data` and `designer-backups` volumes | Compose-managed state; no host bridge unless separately started |

SQLite uses WAL and foreign keys. Canonical revision snapshots are
content-addressed and Brotli-compressed in SQLite, and revisions form a hash
chain. Normalized raster bytes are stored under generated
`assets/sha256/<prefix>/<digest>.<ext>` paths with size/digest verification;
legacy SQLite BLOBs remain as a verified quarantine/compatibility fallback.
Treat the whole data directory as one recovery unit.

The packaged CLI validates the native path contract before reading runtime
records, migration state, logs, or support-bundle output. It never falls back
to `.designer` or `data` inside the root-owned installed payload. Arbitrary
`backup restore <bundle>` deliberately fails before bundle verification for an
environment-managed native runtime; native restore remains blocked until the
installer has a supervised stop, verified safety backup, atomic cutover,
rollback, health verification, and restart workflow.

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

Do not collect or share source `.designer/env`, native runtime/config roots,
databases, backups, assets, browser storage, environment dumps, or authorization
headers. Although managed bridge grants live in the OS credential store, local
runtime state still contains private paths, URLs, logs, and possible legacy
server secrets.

## Diagnostics and logs

Start with:

```bash
pnpm formaspecctl doctor auto
pnpm formaspecctl status
pnpm formaspecctl ensure-running --json
```

`ensure-running` is the safest diagnostic for a review link or Codex invocation.
Its JSON result identifies the recorded mode, API origin, browser origin,
data-store ID, bridge state, and one explicit blocker. A recorded Docker/server
runtime never falls back to native storage when Docker is unavailable.

Require an installed browser for source rendering checks:

```bash
pnpm formaspecctl doctor local --strict
```

Application logs are still exposed through the compatibility wrapper:

```bash
./designer logs
./designer logs --follow
```

Development logs stay attached to the terminal running `pnpm dev`. The source
local-bridge log is `.designer/logs/formaspec-bridge.log`; packaged wrappers
bind it to `FORMASPEC_LOG_DIR`.

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

For migrations 9 through 14, FormaSpec also validates the required tables,
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

Migration 14 adds `password_accounts`, `browser_sessions`, `login_attempts`,
and `bootstrap_credentials`. It does not invent a human account. The browser
bootstrap transaction creates the sole enabled Organization Administrator,
uses versioned scrypt for the password, consumes the public-server bootstrap
credential atomically, and creates a token-hash-only session. Account identity
and bootstrap consumption are irreversible database invariants; session
logout, rotation, expiry, principal disablement, and restore reconciliation use
revocation rather than rewriting identity history.

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
  default when no stored override exists. Each scheduled attempt records
  durable start/success/failure audit and outbox evidence. `/health/ready` and
  `formaspecctl backup schedule show` surface bounded overdue, stalled, failed-
  run, and retention-backlog diagnostics without leaking error or path data.
  Failed or stalled attempts remain critical even when a valid backup already
  exists for the current window.
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
Installed external schedule invocation, external alert delivery, and clean
planned-recovery evidence remain operator/release work even though the
supervised command path and diagnostics are implemented.

The managed-ID Docker/server path is `HEALTHY_PLANNED_RESTORE_ONLY`. It resolves
the opaque backup ID and performs target preflight through the healthy current
API/database before entering maintenance. A stopped or corrupt API/database
cannot use this path even when a valid bundle exists. Use the separately
authorized offline bundle workflow below for that condition.

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
removing an unvalidated path. If a planned pre-cutover resume or rollback worker
fails after maintenance aborts, the supervisor restarts and verifies the
unchanged API; a simultaneous restart failure is reported as an aggregate
failure rather than hiding either cause. Offline recovery does not auto-abort or
restart and remains fenced for explicit resume.

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
connections, pairing nonces, and browser sessions. Sign in again, open
Administration, choose **Connect Codex**, and use its new one-time handler or
fallback command. In authenticated mode, a ticketless CLI command cannot create
the replacement connection.

The bridge is stopped before managed restore and is not silently re-authorized.
Keep the safety backup and operation record until the restored application and
Codex reconnection have been independently checked.

### Offline Docker/server disaster recovery foundation

When the pinned API is stopped or its SQLite database cannot be opened, select
an off-host verified FormaSpec bundle explicitly and authorize the destructive
recovery boundary:

```bash
pnpm formaspecctl backup restore offline \
  /safe/path/formaspec-backup-2026-07-20.tar \
  --yes
```

The CLI first runs the standalone bundle verifier and rejects a database schema
newer than the CLI supports. It then reopens the exact regular file with
`O_NOFOLLOW` where supported, verifies device/inode/size identity, and pipes
only that descriptor through stdin to the isolated `offline-prepare` worker.
No host path is passed into the container. Before reading stdin, the worker
checks backup-volume capacity for the authorized source plus reserve space. It
enforces the authorized size/SHA-256 while receiving the stream, performs a
whole-workflow capacity forecast after target inspection, and retains a mode-
`0400` target in the backup volume. Complete bundle/SQLite/document/asset/raster
verification precedes the forensic capture, whose own bounded pre-copy checks
reserve capacity before reading the current tree and again before writing its
archive. That exact checksummed pre-state is valid even when the old SQLite file
is corrupt because it preserves bytes rather than claiming an application-
consistent backup. All spawned supervisor/worker stdout and stderr share one
combined 4 MiB budget by default; over-limit aggregate output terminates the
child and fails the operation. Focused tests prove the 5-second SIGKILL fallback
when an over-budget child ignores SIGTERM.

After preparation, the ordinary restore engine performs the journaled cutover,
current-schema integrity/foreign-key and deterministic-render checks,
audit/outbox reconciliation, and atomic revocation of all restored grants,
connections, pairing nonces, and browser sessions. The API starts under
maintenance; normal readiness is required before maintenance clears.

Any offline failure after the fence is acquired remains fenced by default. The
CLI does not auto-abort, restart the API, or expose corrupt/unverified data; it
reports the owning operation and requires `resume --offline-bundle` after the
capacity, bundle, renderer, or runtime failure is corrected. During atomic
takeover of a forensic-rollback fence, the predecessor operation remains the
durable owner until replacement preparation succeeds. If preparation fails,
the predecessor fence is restored unchanged. On resume, the current maintenance
owner is passed to `offlinePrepare` and owns the replacement worker sequence;
the retained predecessor operation ID is never reused for that replacement.

If interruption occurred before durable preparation, repeat the exact source
selection during resume:

```bash
pnpm formaspecctl backup restore resume \
  --offline-bundle /safe/path/formaspec-backup-2026-07-20.tar \
  --yes
```

Once preparation exists, status identifies the retained target and ordinary
`backup restore resume --yes` continues it. Never substitute a different
bundle. `backup restore rollback --yes` for an offline operation restores the
verified forensic pre-state bytes. Because those bytes may include the
corruption that triggered recovery, successful forensic rollback deliberately
keeps maintenance active, leaves the API stopped, and reports
`maintenanceCleared: false` plus `serviceReady: false`. Do not clear that fence
or manually start the API: restore control rejects direct clear for this state.
Only a newly selected and fully verified offline restore may atomically replace
the terminal forensic-rollback operation while retaining the fail-closed
maintenance boundary.

Focused worker/CLI tests cover source pinning, stdin-only transfer, corrupt-
database forensic capture, full restored-target verification, revocation,
resume, and forensic rollback. A disposable unique-Compose smoke also exercised
the production worker/control path with a real schema-11 design and PNG,
replaced the live database with corrupt marker bytes, restored the exact design/
render, revoked one grant/connection/nonce, restored the exact corrupt bytes by
forensic rollback, observed durable `rolled_back`/`recovery=offline` state, and
fully cleaned up without touching the user's live project. It manually cleared
the fence only for disposable cleanup; production semantics leave maintenance
active and the API stopped. A subsequent real unique-project `formaspecctl`
smoke validated the persisted Compose project across binding verification,
offline preparation, worker execution, and cleanup. The historical schema-13
image also passed same-machine copied-bundle restore from
`formaspecdrsource3af2259e48`
into `formaspecdrtarget3af2259e48` with exact state/render/asset/SQLite/FK
comparison and complete cleanup. That run predates the `drizzle-orm` 0.45.2
lock update and must be repeated after a fresh frozen install. Server-mode
proxy, packaged runtime, real remote-host/network/TLS/off-site recovery, and
supervised lifecycle evidence remains open, so this is
not yet a release-qualified disaster-recovery service.

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
and add the original `--backup-id` for planned restore or `--offline-bundle`
for offline recovery only when status says no durable preparation record
exists. Use `backup restore rollback --yes` only after the original
operation reaches a conclusive state. Use `backup restore abort --yes` only
for pristine or prepared pre-cutover state with no journal/worker lock and an
unchanged database that still passes integrity, foreign-key, and current-schema
verification. It intentionally cannot clear corrupt offline data or a terminal
forensic rollback fence; corrupt/non-SQLite open or query failures return the
structured `VALIDATION_FAILED` domain error.
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
absolute `PATH` and that an unmanaged `formaspec` skill or marketplace is not
blocking the managed installation. The connector refuses to overwrite
unmanaged content.

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

- retain the current schema-16 package suite 842/842, launcher 225/225,
  typecheck/build, Compose configuration, browser/preview/alignment/visual/
  performance gates, Docker runtime/egress, and copied-bundle recovery in
  hosted supported-OS CI, then generate current SBOM/security/image/OS evidence;
- add real Windows named-pipe/native renderer/service-host/ACL/process-tree
  packaging and retained hosted egress/crash/saturation/load evidence beyond
  the historical local schema-13 DNS/TCP/interface canary;
- finish and verify real Nginx/TLS server-mode reverse-proxy, public direct-port
  isolation, `HEALTHY_PLANNED_RESTORE_ONLY`/rollback, offline recovery,
  upgrade, alerting, and long-running Compose evidence; controlled actual-
  socket proxy behavior and both restore command paths exist but have not
  passed those deployment release matrices;
- retain the current schema-16 editor/Administration 5/5, release E2E 1/1,
  preview integration 2/2, Chromium and Firefox/WebKit alignment 12/12 each,
  visual 7/7, 20-step release scenario, and 1,000-node budget matrices on
  pinned hosted/supported-OS release runners;
- extend the recorded disposable local-Docker A/B restore exercise beyond the
  passing source-local 20-step V1/V2/product/task/hash/render scenario and
  deterministic schema 1/schema 7–12 fixtures to the full asset/design-system/
  anonymized-customer/failure-injection matrix;
  add trusted signing/provenance where required; and finish installed external
  scheduling, alert delivery, retention failure recovery, and packaged operator
  workflows;
- finish operator-approved migration/cleanup of legacy asset BLOB quarantine
  and expand malformed-raster/upload-storm evidence; worker-backed full decode
  now covers backup creation/verification and restore preflight/cutover;
- retain larger adversarial/concurrent portable-import evidence and packaged
  cross-platform proof for the implemented disk-staged multipart/entry
  streaming path; individual JSON/raster entries remain bounded by the 64 MiB
  per-entry limit when parsed or normalized;
- preserve the historical schema-11 PKG checkpoint; keep the retained schema-12
  package `NO-GO` and build a new frozen candidate only after Chromium notice
  approval, vulnerability
  scanning, signing/notarization, independent reproducibility, and privileged
  clean lifecycle evidence are complete; then ship and test a release-ready macOS
  PKG, Windows MSI, Linux DEB/RPM, autostart, upgrade, uninstall, reinstall,
  signing, and notarization paths. Linux and Windows source builders exist, but
  real artifacts/lifecycles remain unproven;
- verify Windows DPAPI in the packaged service lifecycle on clean hosts;
- complete automatic Workspace Bridge mapping suggestions, incremental rescans,
  and broader tamper/role/browser coverage around the implemented seven-
  decision handoff gate and selected-workspace Codex launch; connected grants
  now persist path-free inventories automatically;
- complete the seven-stage Redesign Studio and the broad product-spec/planning/
  task UI;
- produce the comprehensive authorization, CSRF, Host/Origin, asset,
  renderer-egress, archive, traversal, decompression, secret-exclusion, and
  prompt-injection security evidence beyond the current package suite;
- produce artifact-specific container/native SBOMs, dependency/image/OS scans,
  reproducibility, signed provenance, and release-artifact evidence with no
  unresolved critical/high findings. Repository-native source, browser,
  historical schema-13 Docker-smoke, and unsigned Linux packaging workflows
  exist.
  Five repository workflows are present. Local evidence helpers pass workflow
  contracts 8/8, cross-browser runner
  tests 2/2, off-host simulation tests 7/7, release-evidence tests 8/8, and
  macOS package-evidence tests 12/12 plus extracted-runtime-smoke contract tests 11/11,
  but no GitHub-hosted run or real Ubuntu package artifact has been retained.
  The historical schema-13 source evidence reported 342 components and zero
  license violations. Audit reports zero high/critical findings for the 0.45.2
  lock, but current schema-16 artifact-specific SBOM/image/OS and installed
  lifecycle verification are still required.

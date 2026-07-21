# FormaSpec deployment

Last audited: 2026-07-21

## Deployment decision

FormaSpec is **not ready for production or public deployment**. The repository
can be used for local development and controlled, access-restricted evaluation,
and the hardened local Docker API/renderer split plus externally supervised
Docker/server planned and explicitly authorized offline restore foundations
exist, but release-qualified native packages, clean server planned/offline
restore and reverse-proxy lifecycle evidence, remote/off-site disaster
recovery, installer matrix, signed backup
provenance, and complete release evidence do not exist yet. One isolated local-Docker A/B restore and
safety-restore exercise has passed; it does not qualify the server deployment
path.

Current local schema-13 application, browser, Docker/egress, Firefox/WebKit,
recovery, and temporary SBOM/license evidence passed before a lock-only
dependency update. The lockfile now selects `drizzle-orm` 0.45.2 to eliminate
GHSA-gpj5-g38j-94v9, but installed modules and runtime evidence still used
0.44.7. A fresh frozen install and complete rerun is required before deployment
qualification.

Do not expose the current Compose port to a LAN or the internet. Do not declare
an enterprise rollout complete from a successful source or Compose startup.
Track the authoritative gaps in
[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) and
[RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md).

## Installation entry points

From a trusted checkout on the target machine, the current installer commands
are:

```bash
./designer --yes install docker
```

```bash
./designer --yes install local
```

The Docker command is the intended evaluation entry point and the local command
is the current reliable source fallback. Both still require Node.js 24 or newer
and pnpm 11.9 to build the source CLI and host-side bridge. Docker mode also
requires Docker Engine/Desktop and Compose v2.

For development rather than deployment:

```bash
pnpm dev
```

To connect Codex after a managed start:

```bash
./designer --yes agent connect codex
```

The installer normally performs the Codex step automatically when Codex is
detected. See [OPERATIONS.md](./OPERATIONS.md) for the full command surface.

## Current Docker topology

The repository builds one `formaspec/server:local` image from the pinned
Playwright base image and runs two long-lived Compose services:

- `designer`: browser assets, Fastify `/api/*`, MCP `/mcp`, replayable SSE,
  SQLite, and bounded render orchestration;
- `renderer`: the non-root Playwright worker reached only through a versioned
  Unix socket shared with the API.

The same image also defines `restore-worker` under the `operations` profile. It
is a one-shot, externally invoked process rather than a third long-running
service. It runs as `pwuser` with no network, a read-only root filesystem,
dropped capabilities, no-new-privileges, bounded resources, and only the
`/data`, `/backups`, renderer-socket, and tmpfs mounts needed for recovery.

The renderer has `network_mode: none`, a read-only root filesystem, all
capabilities dropped, no-new-privileges, PID/memory/CPU limits, tmpfs scratch,
a new deterministic browser context per job, bounded queue/concurrency/IPC,
and no production software fallback.

Migration 11 persists bounded API-owned render and raster-normalization job
metadata across process restarts. Jobs use owner leases and heartbeats and
recover only expired owners. Rows contain hashes, versions, dimensions, bounded
warnings, and safe errors—not documents, assets, PNG bytes, paths, or filenames.
The renderer remains database-free, and exact 30-day terminal retention requires
scoped delete permits.

Database schema 13 adds canonical component source JSON/SHA-256 persistence and
exact design-system upgrade base/result snapshot references. The current
command engine is 2, renderer 3, renderer IPC protocol 2, and font bundle 1.

Compose publishes container port 4310 to `127.0.0.1` by default, mounts named
volumes at `/data`, `/backups`, and `/run/formaspec`, allocates renderer shared
memory, and uses `restart: unless-stopped`. It passes the strict-mode,
Host/Origin, trusted-proxy, CSRF, and container-local variables. The local MCP
bridge is not in the image; the source CLI starts it as a separate host process on
`127.0.0.1:4312`.

The current local schema-13 checkpoint used Compose project
`formaspeccischema13da9af9d064` and image
`sha256:166d74686a8ebd52c2765d0c12b362690717af8488a7a4b83f0f1e348d620b97`.
Design `document_e171c68c7a4c4b3b80a5493a6180e28f` at revision
`revision_85e2776ca3874f1c98097b6917bc3649` rendered the same 512×339 PNG
SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`
before and after API restart. The egress canary returned DNS `EAI_AGAIN`, TCP
`ENETUNREACH`, and zero external interfaces; cleanup passed. Summary SHA-256 is
`13c608ce5ddec282d8e0b8497d54f9971f4f20764d035122ea5e64dfd31f1e0f`.

The same image passed Firefox/WebKit 12/12 (summary SHA-256
`c128ee3f6a7341cd75189dba612d6b01d25abd2b57fb26db1970c152f1f665bc`)
and copied-bundle recovery from `formaspecdrsource3af2259e48` to
`formaspecdrtarget3af2259e48`. Bundle SHA-256 was
`b87d44e7b0584dd0a14e5b47d07cf447490a683ab512f983feb4e2a19c0a6ef3`;
snapshot/revision/asset/render/SQLite/FK comparisons and cleanup passed; the
`NO-GO` summary SHA-256 is
`1dfecf9b4a4773fed25f73eaa181bc88e30fc21df8b0679c3325241af3ccd433`.

These local results used linked `drizzle-orm` 0.44.7 and must be repeated after
a fresh frozen install of the now-locked 0.45.2. They are not real remote-host/
TLS/off-site or hosted release evidence. Prior `final437` schema-12 summaries
remain historical regression evidence only. The retained unsigned macOS checkpoint
under `artifacts/candidates/schema12-current/` retains passing frozen package-
integrity and non-installing extracted-runtime evidence but was not installed;
current-source verification records expected drift and same-host outer
PKG bytes are nondeterministic and release remains `NO-GO`. The preserved
`schema11-current` checkpoint is historical only. The installed default volume
previously migrated from
schema 7 to schema 8 while preserving its project, 31 revisions, representative
asset, and worker render. Current gaps include:

- no release-qualified Windows named-pipe/native worker/service-host packaging;
- the local schema-13 Docker smoke passes DNS/direct-TCP/non-loopback
  renderer-egress canaries, but no retained hosted/native canary, crash,
  saturation, or long-running load proof exists;
- no installed schedule supervisor or external alert delivery; online create/
  list/verify/download and supervisor-callable schedule/prune use the mounted
  backup volume, while ready health and CLI expose bounded schedule diagnostics;
- a tested externally supervised restore foundation supports the exact
  launcher-recorded local-Docker/server runtime, but the disposable A/B
  exercise covers only local Docker and no server deployment automation or
  alerting has been qualified;
- managed-ID Docker/server restore is `HEALTHY_PLANNED_RESTORE_ONLY` and
  requires a healthy current API/database for backup-ID resolution and
  preflight; the separate explicit offline-bundle path exists, but neither path
  has clean server-mode or real remote/off-site lifecycle evidence;
- no release evidence proving the strict server-mode reverse-proxy path,
  upgrade, restore, or multi-user long-duration behavior.

Local Compose uses `APP_MODE=local`, `HOST=0.0.0.0`, and
`FORMASPEC_CONTAINER_LOCAL=true` so the API can listen inside the container
while Docker publishes it only on host loopback. This exception is rejected in
server mode. Focused local request/security and restart-persistence evidence
exists, but this is not a release-qualified server configuration. Do not expose
the host port or disable trust-boundary checks.

## Controlled loopback evaluation

The safest current remote evaluation pattern is to run the local source service
on the server's loopback interface and reach it through SSH. It is appropriate
only for a small controlled test, not a multi-user production deployment.

On the server, install/start local mode. Set the launcher's no-open environment
flag on a headless host:

```bash
DESIGNER_NO_OPEN=1 ./designer --yes install local
```

From the workstation:

```bash
ssh -L 4310:127.0.0.1:4310 user@your-server
```

Then open [http://127.0.0.1:4310](http://127.0.0.1:4310).

The SSH tunnel is the security boundary for this evaluation. Keep
`APP_MODE=local`, keep the service bound to loopback, and do not publish port
4310 through a firewall, load balancer, ingress, or container port mapping.

Automatic Codex pairing is currently designed for a bridge and API on the same
workstation. The bridge deliberately accepts only a loopback upstream MCP URL.
A remote-server/client bridge authorization flow is not complete. For an SSH
evaluation, either run Codex on the same server as the managed bridge or use a
carefully reviewed standard MCP configuration against the local tunnel; do not
copy upstream grants into TOML.

## Strict HTTPS server contract

The application has a fail-closed `APP_MODE=server` configuration. The server
initializer and Compose overrides now emit the strict public URL, proxy,
Host/Origin, identity, CSRF, and container-mode contract without rewriting
legacy secret files. A controlled actual-socket loopback harness now verifies
header replacement, raw-peer/direct-port rejection, and restart-bound hop-secret
rotation. This is not a production deployment endorsement because real
Nginx/TLS, host-firewall, identity-provider, and recovery matrices remain
incomplete.

Required security values include:

```dotenv
APP_MODE=server
HOST=127.0.0.1
PORT=4310
DATA_DIR=/srv/formaspec/data
BACKUP_DIR=/srv/formaspec/backups
PUBLIC_BASE_URL=https://designer.company.example
AUTH_MODE=trusted-header
DESIGNER_TOKEN=replace-with-a-long-random-compatibility-secret
FORMASPEC_PROXY_SECRET=replace-with-a-separate-32-plus-character-random-hop-secret
TRUSTED_USER_HEADER=x-company-identity
FORMASPEC_ALLOWED_HOSTS=designer.company.example
FORMASPEC_TRUSTED_PROXIES=127.0.0.1
DESIGNER_CORS_ORIGINS=https://designer.company.example
FORMASPEC_CSRF_HEADER=x-formaspec-csrf
FORMASPEC_ALLOW_SOFTWARE_RENDERER=false
FORMASPEC_ALLOW_SYSTEM_CHROME=false
FORMASPEC_CONTAINER_LOCAL=false
```

Adjust `FORMASPEC_TRUSTED_PROXIES` to the exact addresses or ranges from which
the application actually receives proxy traffic. Do not use a broad private
network or `0.0.0.0/0`. If a containerized reverse proxy talks to a
containerized API, `HOST` may need to listen on the container interface, but
the host-published API port must remain inaccessible to clients and the strict
server requirements must still be met.

`APP_MODE=server` refuses startup unless:

- the public base URL is HTTPS;
- browser identity uses `AUTH_MODE=trusted-header`;
- the compatibility MCP token exists;
- a separate bounded internal proxy credential exists and does not reuse the MCP token;
- at least one trusted proxy is configured.

At request time it also enforces the raw socket peer and the constant-time
`x-formaspec-proxy-secret` hop credential before accepting any non-health
request, plus the Host allowlist, exact CORS origin, trusted identity header,
and—for `POST`, `PUT`, `PATCH`, and `DELETE` under `/api/`—an
exact trusted Origin plus `x-formaspec-csrf: 1`. Security responses include
CSP, HSTS, `X-Frame-Options: DENY`, no-sniff, no-referrer, and a restrictive
permissions policy.

The checked-in Compose file can pass this contract, but its defaults select
local container mode. Use `./designer server init` to generate a reviewed
server configuration; do not treat generated values as proof that the reverse
proxy strips identity headers or blocks direct-port access.

## Reverse proxy requirements

An HTTPS reverse proxy for a controlled server-mode test must:

- terminate TLS using a valid company-controlled certificate;
- authenticate the user before proxying browser/UI/API/SSE traffic;
- remove any client-supplied trusted identity header, then set it from the
  verified identity;
- remove any client-supplied `x-formaspec-proxy-secret`, then overwrite it with
  the separate server-generated hop secret on every proxied browser, API, SSE,
  asset, and MCP request;
- preserve the original allowed `Host` and HTTPS scheme;
- pass browser `Origin` unchanged;
- pass `Authorization` for MCP without logging it;
- never inject the CSRF intent header on behalf of arbitrary clients—the web
  application sends it;
- disable buffering and caching for both `/events` and `/api/events`;
- prevent all direct client access to the upstream application port;
- set forwarding headers only from a source included in
  `FORMASPEC_TRUSTED_PROXIES`.

Illustrative Nginx configuration after an authentication layer has established
`$remote_user`. Retrieve the generated hop credential only during operator
configuration with `./designer proxy-secret`; do not put it in source control,
shell history, proxy access logs, or client-visible configuration. Replace the
placeholder below through the proxy's secret-delivery mechanism:

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Company-Identity $remote_user;
    proxy_set_header X-FormaSpec-Proxy-Secret "REPLACE_FROM_SECURE_SECRET_STORE";
    proxy_set_header Authorization $http_authorization;
}

location ~ ^/(events|api/events)$ {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Company-Identity $remote_user;
    proxy_set_header X-FormaSpec-Proxy-Secret "REPLACE_FROM_SECURE_SECRET_STORE";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

Nginx `proxy_set_header` overwrites the inbound header, while an empty value
removes it. `$remote_addr` intentionally replaces, rather than appends to, any
caller-supplied forwarding chain. Equivalent proxies must provide the same
replace-or-remove behavior. Direct requests from an allowlisted raw peer without
the hop credential are accepted only for the exact minimal health probe routes
(`/health`, `/ready`, `/health/live`, `/health/ready`, and `/health/render`).
Raw-peer allowlisting by itself is not browser or API authentication.

### Controlled proxy lifecycle evidence

`apps/server/src/reverse-proxy-lifecycle.test.ts` uses actual TCP listeners and
separate loopback address families instead of Fastify request injection:

- the reverse proxy reaches the backend from allowlisted IPv6 loopback, while a
  direct IPv4-loopback client is rejected even when it presents the correct hop
  secret and a forged trusted identity;
- caller-supplied trusted identity, hop-secret, Host, `Forwarded`,
  `X-Forwarded-*`, and `X-Real-IP` values are removed and replaced before the
  request reaches FormaSpec;
- only the proxy-established canonical identity is bootstrapped; forged
  identities never enter the principal table;
- append-style identity forwarding is rejected as ambiguous, and append-style
  hop-secret forwarding fails the constant-time credential comparison;
- exact health routes remain credential-free only through an allowlisted raw
  peer; the same direct untrusted peer is denied;
- changing the proxy to a new hop secret fails against the still-running old
  backend, succeeds only after a backend restart with the new secret, and makes
  the old secret fail after restart.

The hop secret is a startup configuration snapshot; there is no dual-secret
grace window. Rotate it during a drained maintenance window: prepare the new
secret in both protected stores, stop accepting user traffic, restart the API
with the new value, reload the proxy with the same value, verify proxied health
and an authenticated request, then destroy the old value. Updating either side
alone intentionally causes non-health requests to fail closed.

This harness proves application behavior across real local sockets. It does not
prove a particular Nginx build, TLS certificate lifecycle, external identity
provider, container/host firewall, routing policy, or public backend-port
inaccessibility. Those remain deployment release gates.

The example is incomplete without the company's authentication configuration,
network policy, certificate management, secret delivery, and trusted-proxy
design. Ensure the proxy overwrites the identity header rather than appending
to a client-provided value.

## MCP and agent deployment behavior

The automatic Codex setup registers MCP server ID `formaspec` at the
credential-free loopback URL `http://127.0.0.1:4312/mcp`, installs the managed
Minimal UI skill/plugin, and provides:

```text
[@Minimal UI](plugin://minimal-ui@formaspec)
```

The bridge creates a scoped, expiring upstream grant and stores it in macOS
Keychain, Linux Secret Service, or a Windows current-user DPAPI ciphertext
file. Windows implementation tests pass through an injected PowerShell runner;
real packaged service/ACL/lifecycle evidence is still required. The Codex
configuration itself contains no bearer token.

This automatic flow is local-machine only today. It does not configure a
remote HTTPS bridge, OAuth client, or arbitrary MCP client. For unsupported
clients, generate and review that client's standard Streamable HTTP setup; do
not modify unknown configuration files and do not embed bearer secrets in
checked-in configuration.

The compatibility `DESIGNER_TOKEN` accepted by direct server MCP is not the
preferred managed-agent grant. If it is used for a controlled compatibility
test, deliver it through the client's supported secret/environment mechanism,
never inline in TOML, source control, logs, screenshots, or support bundles.

## Health checks

Use the versioned health endpoints:

```bash
curl --fail --silent --show-error http://127.0.0.1:4310/health/live
curl --fail --silent --show-error http://127.0.0.1:4310/health/ready
curl --fail --silent --show-error http://127.0.0.1:4310/health/render
```

For an HTTPS proxy evaluation, run the equivalent checks through the public
origin where policy allows. `/health/live` is process liveness.
`/health/ready` reports database/migration readiness plus bounded aggregate
backup overdue/stalled/failed-run/retention-backlog diagnostics. Failed or
stalled attempts remain critical even when the current window has a valid backup.
`/health/render` reports renderer configuration but does not perform a real
Chromium job. A deployment gate must additionally render a representative frame
and verify the PNG.

The image health check uses the compiled, credential-free FormaSpec probe for
`/health/ready`. It always connects to the container over
`127.0.0.1:${PORT}`. In local mode it sends an allowed loopback `Host`; in
server mode it derives the exact `Host` from `PUBLIC_BASE_URL`. This preserves
strict Host validation when the public origin is, for example,
`https://designer.company.example`, without weakening the allowlist or sending
identity, bearer-token, cookie, Origin, or CSRF headers.

For a direct server-mode diagnostic from inside the API container, use the
same helper instead of a plain loopback curl whose `Host` would be rejected:

```bash
node apps/server/dist/container-healthcheck.js
```

Compatibility endpoints `/health` and `/ready` remain for older launcher
behavior and should not be mistaken for the final enterprise probe contract.

## Persistent storage and backups

The application data root must be durable and backed up as one recovery unit:

- `designer.sqlite` plus its WAL state;
- content-addressed revision snapshots stored in SQLite;
- uploaded assets, including current legacy BLOB-backed assets;
- normalized content-addressed asset files and organization configuration.

The current Compose file mounts separate named volumes at `/data` and
`/backups`. That makes files persistent across ordinary container replacement,
but it is not a backup policy: production-capable delivery still needs tested
ownership, capacity, encryption, external copy/export, scheduling, retention,
restore, and rollback procedures.

The repository contains tested backup creation/verification/restore library
primitives. Bundle verification includes exact archive/checksum/asset coverage,
normalized image and legacy BLOB integrity, canonical strict V1/V2 snapshots,
revision hash chains, and exact project heads. The running application and
Administration UI expose create/list/re-verify/download. Supervisor-callable
schedule execution, durable attempt start/success/failure audit/outbox evidence,
bounded health/CLI diagnostics, and preview-first retention pruning are
implemented. The CLI
supports both explicitly authorized source-local restore and an externally
supervised launcher-pinned Docker/server restore by opaque managed backup ID:

```bash
pnpm formaspecctl backup create
pnpm formaspecctl backup list
pnpm formaspecctl backup schedule run
pnpm formaspecctl backup prune preview
pnpm formaspecctl backup verify /safe/path/formaspec-backup.tar
pnpm formaspecctl backup restore /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl backup restore --backup-id backup_<40-lowercase-hex> --yes
pnpm formaspecctl backup restore status
pnpm formaspecctl backup restore resume --yes
pnpm formaspecctl backup restore rollback --yes
pnpm formaspecctl backup restore abort --yes
pnpm formaspecctl backup restore clear-stale-lock --yes
```

`./designer backup` is a legacy downtime copy, not the verified bundle format.
The path-based source-local command deliberately refuses Docker/server data.
The ID-based command accepts only the launcher's recorded local-Docker or
server runtime; it refuses direct/unknown Compose projects, custom project
names, arbitrary paths, and guessed volumes.
Install/start/restart record a mode-`0600` exact runtime
binding at `.designer/run/docker-runtime-binding.json`; restore revalidates its
Docker context/daemon, image digest, container and Compose identities/project
path, named volumes, renderer isolation, loopback-published port, runtime mode,
secret-redacted environment identity SHA-256, and exact health `Host`. Every
capture and verification live-inspects data, backup, and renderer-socket volumes
and requires local driver/scope, no options, bounded absolute mountpoints, and
distinct backing identities; plugin, NFS, bind-backed, and aliased volumes fail
closed. The binding never stores
the bearer value, and the one-shot worker receives no application bearer
credential.

This capability is `HEALTHY_PLANNED_RESTORE_ONLY`. It cannot resolve a backup
ID or complete preflight when the current API/database is stopped or corrupt,
even if a valid bundle exists. Offline disaster recovery requires a separate
authorization and operator workflow.

The Docker/server supervisor requires a healthy current API/database, holds the
launcher lock, stops the bridge, performs a read-only target preflight before
maintenance, writes a fixed path-free marker
under `/backups/.formaspec`, stops only the API, and uses hardened direct
`docker run` to launch the network-disabled one-shot worker with the exact
pinned image and volumes. The worker verifies the target, creates a verified
managed manual safety backup, persists resumable
operation state outside `/data`, closes SQLite, performs the journaled cutover,
checks current-schema SQLite integrity/foreign keys, runs a deterministic
Playwright render smoke, reconciles audit/outbox records, and revokes restored
agent grants, connections, and pairing nonces atomically. The API restarts
while still fenced, and maintenance clears only after a durable terminal result
and health verification. Codex therefore requires a fresh
`formaspecctl agent connect codex --yes` authorization after success.

Health probes have independent absolute deadlines. Symlinked or unexpected
launcher lock state fails closed without recursively removing an unvalidated
path. If a pre-cutover resume or rollback worker fails after maintenance abort,
the supervisor restarts and verifies the unchanged API; concurrent worker and
restart failures are preserved together.

The worker and API share the non-expiring
`/backups/.formaspec/restore-worker.lock.json` fence. The API refuses to open
SQLite while that lock exists or cutover is incomplete. Restore state is
crash-resumable across `prepared`, `cutover_committed`, `reconciled`, and
`rolled_back`; retries after committed cutover repeat health verification before
cleanup. A pinned-source cleanup failure retains the committed journal so the
next retry rechecks health before cleanup. Maintenance removal is the final
state mutation.

Maintenance blocks `/api/*`, `/mcp`, and event streams with retryable
`TEMPORARILY_UNAVAILABLE`; readiness still checks the database, migrations, and
renderer while returning maintenance `503` with the exact operation ID.
Liveness and renderer health remain available. Malformed state fails closed and
never expires automatically. On uncertainty, inspect `backup restore status`,
which also validates the pinned runtime, then use the exact `resume` command
(adding the original `--backup-id` only if the
durable record was never created) or the explicit eligible `rollback` flow. Do
not delete control state or restore journals manually. `abort --yes` is allowed
only when no operation, journal, or worker-lock evidence exists.
`clear-stale-lock --yes` is allowed only after the pinned supervisor proves the
exact worker container is absent.

Before any upgrade or migration, follow
[BACKUP_AND_RESTORE.md](./BACKUP_AND_RESTORE.md), restore onto disposable
storage, verify projects/history/assets and a real render, and retain a rollback
copy. On 2026-07-20, an isolated Compose project on port `4397` restored
`backup_0dda1a60c54c5805557426a428739e505e089425` through
`restore_e2ea0123456789abcdef0123456789`, then restored safety backup
`backup_7697fb29100b0bc8adc22707114c50947ed3a668` through
`restore_e2eb0123456789abcdef0123456789`. The first restore left only design A;
the safety restore returned A and B; original IDs/revisions were preserved; one
grant, connection, and nonce were revoked; the connection remained revoked; and
the disposable containers, volumes, and network were deleted.

That is local-Docker evidence, not server-mode evidence. Native package-builder
foundations exist, but installed service integration is unverified. Restore now opens a source with
`O_NOFOLLOW`; the Docker worker copies and hashes it into private mode-`0700`
staging on `/backups`, makes the pinned file mode `0400`, verifies the expected
managed size/SHA-256, and uses only those pinned bytes through journal matching,
verification, and extraction. Source-local restore passes the exact verified
tar-stream SHA-256/size into the same engine. The valid-bundle pathname-swap
regression test passes. Bundles are checksummed but not signed, so verification
proves consistency rather than provenance.

## Updates and rollback

There is no production-grade unattended upgrade or rollback flow. Current
server startup applies pending numbered database migrations automatically and
refuses an unknown/newer migration ledger. The CLI migration command is
read-only and source-database-only.

The Docker/server restore supervisor is a recovery foundation, not an
unattended deployment rollback mechanism. In the supported server boundary the
host CLI owns maintenance and the exact pinned container lifecycle; the running
Fastify process never replaces its own open database. Custom Compose projects,
Kubernetes/Swarm, off-host volumes, automatic alerting, and unattended recovery
still require a deployment-specific orchestrator.

For a controlled source upgrade:

1. stop writes and create a recoverable full-data backup;
2. test the new build and migrations against a disposable restored copy;
3. stop the service;
4. update the checkout through the organization's normal reviewed process;
5. install from the lockfile and run the full tests, typecheck, production
   build, launcher tests, and Compose configuration check;
6. start on loopback and verify migrations, history, assets, SSE replay, Codex
   connection, and a real Chromium render;
7. restore access only after all checks pass.

Do not contract legacy columns, delete quarantined assets, or run the V1-to-V2
project-head migration until a verified pre-migration backup, deterministic
migration fixtures, operator-approved cleanup, and rollback evidence exist.

## Release blockers

Production deployment remains **NO-GO** until evidence exists for all of these:

- fresh frozen installation of locked `drizzle-orm` 0.45.2 followed by the
  complete application/browser/Docker/recovery/SBOM verification set; current
  passing runtime evidence used linked 0.44.7;
- Windows native service-host/named-pipe renderer IPC, ACL/process-tree
  packaging plus retained hosted/native egress, crash, saturation, and load
  evidence beyond the passing local schema-13 Docker worker;
- strict server-mode proxy/direct-port, managed-ID/offline restore and rollback,
  upgrade, installed scheduling, external alert delivery, and long-running
  Compose evidence; both restore command paths exist but lack clean server and
  remote/off-site lifecycle qualification;
- broader local-Docker V1/V2, asset/hash/render and anonymized real-customer
  recovery evidence beyond the deterministic historical fixtures and isolated
  A/B exercise, signed provenance, durable `/data`
  and `/backups` operational proof, and complete scheduling/retention/pruning
  failure recovery;
- release evidence for the implemented server-mode supervisor covering
  maintenance, safety backup, deterministic render smoke, audit/outbox
  reconciliation, rollback, revocation, crash recovery, and alerting;
- retained supported-OS/hosted evidence for the passing local schema-13
  editor/admin/component-insertion 4/4, selection 12/12, handoff 1/1, visual
  7/7, inspect 1/1, 20-step E2E 1/1, and 1,000-node budget 1/1;
- full organization/role/scope/revocation/CSRF/Host/Origin/archive/asset/
  traversal/decompression/renderer-egress/secret-exclusion security suites;
- release-qualified macOS PKG, Windows MSI, Linux DEB/RPM, service supervision,
  autostart, protocol registration, clean install/upgrade/uninstall/reinstall,
  signing, and notarization workflows; the retained unsigned macOS checkpoint
  passed frozen non-installing extraction/runtime checks only and is not current-source;
- real packaged Windows DPAPI service/ACL/lifecycle verification;
- automatic Workspace Bridge mapping suggestions, incremental rescans, portable
  mapping round trips, and the broader approved plan/diff/validation/commit/
  push/PR workflow around the implemented selected-workspace Codex launch;
  connected grants already persist bounded path-free inventories and explicit
  exact-revision mappings through the authorized local MCP bridge;
- complete Redesign Studio and product-manager workflow UI beyond the passing
  20-step PM-to-backup-restore integration scenario;
- artifact-specific container/native SBOMs, dependency/image/OS scanning,
  reproducibility, unsigned/signed artifact instructions, and zero unresolved
  critical/high security findings. Temporary schema-13 source evidence reported
  342 components and zero license violations before the lock update. The
  0.45.2 lock audits with zero high/critical findings, but a fresh install,
  regenerated SBOM, and full verification remain mandatory and never replace
  target-artifact evidence.

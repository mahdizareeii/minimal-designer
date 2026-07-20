# FormaSpec deployment

Last audited: 2026-07-20

## Deployment decision

FormaSpec is **not ready for production or public deployment**. The repository
can be used for local development and controlled, access-restricted evaluation,
and the hardened local Docker API/renderer split plus externally supervised
Docker/server restore command foundation exist, but native packages, clean
server restore/reverse-proxy evidence, installer matrix, signed backup
provenance, and complete release evidence do not exist yet. One isolated local-Docker A/B restore and
safety-restore exercise has passed; it does not qualify the server deployment
path.

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

Compose publishes container port 4310 to `127.0.0.1` by default, mounts named
volumes at `/data`, `/backups`, and `/run/formaspec`, allocates renderer shared
memory, and uses `restart: unless-stopped`. It passes the strict-mode,
Host/Origin, trusted-proxy, CSRF, and container-local variables. The local MCP
bridge is not in the image; the source CLI starts it as a separate host process on
`127.0.0.1:4312`.

The local topology was verified with a fresh isolated Compose project: both
services reached health, a real worker render succeeded, and a created project
survived API restart. The installed default volume subsequently migrated from
schema 7 to schema 8 while preserving its project, 31 revisions, representative
asset, and worker render. Current gaps include:

- no Windows named-pipe/native worker packaging or persisted render jobs;
- no continuous canary-egress, crash, saturation, or long-running load proof;
- no installed schedule supervisor; online create/list/verify/download and
  supervisor-callable schedule/prune use the mounted backup volume;
- a tested externally supervised restore foundation supports the exact
  launcher-recorded local-Docker/server runtime, but the disposable A/B
  exercise covers only local Docker and no server deployment automation or
  alerting has been qualified;
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
legacy secret files. This is not a production deployment endorsement because
the real proxy/direct-port and recovery matrices remain incomplete.

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
- at least one trusted proxy is configured.

At request time it also enforces the Host allowlist, exact CORS origin, trusted
identity header, and—for `POST`, `PUT`, `PATCH`, and `DELETE` under `/api/`—an
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
`$remote_user`:

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Company-Identity $remote_user;
    proxy_set_header Authorization $http_authorization;
}

location ~ ^/(events|api/events)$ {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Company-Identity $remote_user;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

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
`/health/ready` reports database/migration readiness. `/health/render` reports
renderer configuration but does not perform a real Chromium job. A deployment
gate must additionally render a representative frame and verify the PNG.

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
schedule execution and preview-first retention pruning are implemented. The CLI
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
names, arbitrary paths, bind-mounted data, and guessed volumes.
Install/start/restart record a mode-`0600` exact runtime
binding at `.designer/run/docker-runtime-binding.json`; restore revalidates its
Docker context/daemon, image digest, container and Compose identities/project
path, named volumes, renderer isolation, loopback-published port, runtime mode,
secret-redacted environment identity SHA-256, and exact health `Host`. The binding never stores
the bearer value, and the one-shot worker receives no application bearer
credential.

The Docker/server supervisor holds the launcher lock, stops the bridge, performs
a read-only target preflight before maintenance, writes a fixed path-free marker
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

That is local-Docker evidence, not server-mode evidence. Native
installer/service integration is absent. Restore now opens a source with
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

- Windows/native renderer IPC packaging plus continuous egress, crash,
  saturation, and load evidence beyond the verified local Docker worker;
- strict server-mode proxy/direct-port, supervised restore/rollback, upgrade,
  alerting, and long-running Compose evidence;
- broader local-Docker V1/V2, asset/hash/render and historical-fixture recovery
  evidence beyond the isolated A/B exercise, signed provenance, durable `/data`
  and `/backups` operational proof, and complete scheduling/retention/pruning
  failure recovery;
- release evidence for the implemented server-mode supervisor covering
  maintenance, safety backup, deterministic render smoke, audit/outbox
  reconciliation, rollback, revocation, crash recovery, and alerting;
- browser E2E and visual-regression suites beyond the passing integrated local
  scenario, proving the complete cross-platform selection/canvas matrix;
- pinned cross-platform CI retention for the already-passing 1,000-node
  performance budgets;
- full organization/role/scope/revocation/CSRF/Host/Origin/archive/asset/
  traversal/decompression/renderer-egress/secret-exclusion security suites;
- self-contained macOS PKG, Windows MSI, Linux DEB/RPM, service supervision,
  autostart, protocol registration, clean install/upgrade/uninstall/reinstall,
  signing, and notarization workflows;
- real packaged Windows DPAPI service/ACL/lifecycle verification;
- framework-aware Workspace Bridge mapping upload, selected-workspace Codex
  launch, diff review, and approval-gated implementation handoff; connected
  grants already persist bounded path-free inventories automatically;
- complete Redesign Studio and product-manager workflow UI beyond the passing
  20-step PM-to-backup-restore integration scenario;
- artifact-specific container/native SBOMs, dependency/image/OS scanning,
  reproducibility, unsigned/signed artifact instructions, and zero unresolved
  critical/high security findings. The Sharp-free source-workspace gate now
  passes but does not replace target-artifact evidence.

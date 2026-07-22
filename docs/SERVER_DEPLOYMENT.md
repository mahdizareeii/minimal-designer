# Server deployment

Last audited: 2026-07-22

The detailed deployment guide is [deployment.md](./deployment.md). This file
records the required public contract.

Server mode is fail-closed and requires:

```dotenv
APP_MODE=server
HOST=0.0.0.0
PUBLIC_BASE_URL=https://design.example.com
AUTH_MODE=session
FORMASPEC_BOOTSTRAP_TOKEN_HASH=<installer-generated-lowercase-sha256>
FORMASPEC_ALLOWED_HOSTS=design.example.com
FORMASPEC_TRUSTED_PROXIES=127.0.0.1,::1,172.16.0.0/12
DESIGNER_CORS_ORIGINS=https://design.example.com
FORMASPEC_PROXY_SECRET=replace-with-a-separate-32-plus-character-random-hop-secret
FORMASPEC_CONTAINER_LOCAL=false
```

The reverse proxy must terminate HTTPS, remove caller-supplied identity,
forwarding, and `x-formaspec-proxy-secret` headers; overwrite the hop-secret
header from secure proxy storage; preserve the public Host and Origin; and
prevent direct public access to the application port. Session mode does not
trust or require a proxy-injected user identity. Browser writes require the
exact public Origin and the per-session `x-formaspec-csrf` value returned by
FormaSpec. Retrieve the generated hop secret only for operator configuration
with `./designer proxy-secret`; never place it in source control, shell
history, client-visible configuration, or access logs.

Generate a fresh source-mode server configuration with:

```bash
./designer server init --public-url https://design.example.com
```

Session authentication is the default. The initializer generates a one-time
bootstrap token, writes its plaintext only to the mode-`0600`
`.designer/env/bootstrap-token` operator file, stores only its SHA-256 in the
mode-`0600` `server.env`, and prints a fragment URL of this form:

```text
https://design.example.com/setup#bootstrap=<one-time-token>
```

The web gate reads the token from the fragment, immediately removes the
fragment from browser history, and submits the token only with the first-
administrator bootstrap request. Consumption is atomic and creates exactly one
enabled human Organization Administrator. Treat the setup URL and plaintext
operator file as credentials even though neither is a reusable browser session
or MCP bearer token.

For an existing SSO reverse proxy, retain trusted-header mode explicitly:

```bash
./designer server init \
  --public-url https://design.example.com \
  --trusted-header \
  --identity-header x-designer-user
```

In that mode the proxy must strip every caller copy of the identity header and
inject exactly one canonical mapped identity. Browser writes use the legacy
`x-formaspec-csrf: 1` intent value, and MCP uses the generated compatibility
bearer token. Trusted-header mode is an alternative to password sessions, not
an additional identity source within session mode.

Starting through the current `formaspecctl`/`designer` wrapper records a
mode-`0600`, secret-free runtime binding for the exact persisted Compose
project. After the administrator bootstrap or trusted-identity mapping is
complete, an Organization Administrator can select an exact managed backup ID
from the Administration UI and run the external maintenance workflow on the
server host:

```bash
./designer --yes backup restore --backup-id backup_<40-lowercase-hex>
./designer backup restore status
./designer --yes backup restore resume
./designer --yes backup restore rollback
```

If the pinned API is stopped or its database cannot be opened, use the
separately authorized offline path with an operator-selected bundle that has
already been copied to protected host storage:

```bash
formaspecctl backup restore offline /safe/path/formaspec-backup.tar --yes
formaspecctl backup restore status
formaspecctl backup restore resume \
  --offline-bundle /safe/path/formaspec-backup.tar \
  --yes
```

The supervisor revalidates the secure server environment hash, public Host,
loopback port, Docker context/daemon, image, container labels, and named volumes
before each action. Live volume inspection requires the local driver and scope,
no driver options, bounded absolute mountpoints, and distinct backing identities
for data, backups, and the renderer socket; plugin, NFS, bind-backed, and
aliased volumes fail closed. It never serializes or passes `DESIGNER_TOKEN` to
the network-disabled restore worker. Unknown/custom Compose projects,
Kubernetes/Swarm, and off-host volumes are outside this supported boundary.

The managed-ID command is `HEALTHY_PLANNED_RESTORE_ONLY`: it requires the
current API/database while resolving the backup ID and completing preflight.
The offline command does not query that database. It verifies and descriptor-
pins the selected regular file on the host, checks receive capacity before
worker stdin, transfers only the authorized SHA-256/size-matched bytes, performs
a whole-workflow capacity forecast, fully verifies the target through the
isolated renderer, and applies forensic pre-copy capacity gates before
capturing a verified exact snapshot of the existing data bytes. Spawned child
stdout/stderr shares one combined 4 MiB budget by default; a 5-second SIGKILL
fallback handles an over-budget child that ignores SIGTERM. It then uses the standard restore engine,
including schema/render verification, audit/outbox reconciliation, restored-
credential revocation, maintenance-fenced restart, and final readiness.

After the offline fence is acquired, any preparation or restore failure remains
in maintenance for explicit resume; the supervisor never auto-aborts or
restarts the API. During forensic-fence takeover, the predecessor remains
durable until replacement preparation is committed, so a failed replacement
restores the original fence. Resumed takeover runs `offlinePrepare` and the
replacement worker under the current maintenance owner, not the predecessor ID.
Abort re-verifies pristine/prepared live SQLite and
returns `VALIDATION_FAILED` for corrupt/non-SQLite state rather than exposing it.

Offline forensic rollback restores the exact old bytes but does not claim they
are healthy: it keeps maintenance active, leaves the API stopped, and reports
`maintenanceCleared: false` plus `serviceReady: false`. Restore control rejects
direct clearing of that state; only a newly selected, fully verified offline
restore may atomically take over the fence. A disposable unique-Compose worker/
control smoke passed real schema-11 design/PNG recovery from corrupt live bytes,
credential revocation, exact forensic byte rollback, durable offline rollback
state, and cleanup. A later real unique-project `formaspecctl` smoke validated
the persisted Compose identity through the end-to-end CLI. The historical
schema-12 image, built from source identity
`local-uncommitted-final437-eventauth-sqlbounded-cli`, is
`sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f` and
also passed a same-machine copied-bundle restore into an independently
  mounted clean target with exact state/render equality. Current schema-15 source
  passes the seven-package suite 840/840, launcher 225/225, all workspace
  typechecks/builds, installer 71/71 plus typecheck/build, Compose configuration,
  targeted session/browser/preview integration, and macOS runtime-smoke contracts
  11/11. No real schema-15 server-mode
proxy, remote-host/network/TLS/off-site restore, or privileged packaged
lifecycle has run, so this remains an implemented foundation rather than a
release-qualified service.

Do not expose current source builds as enterprise production services. The
required clean server planned/offline restore/rollback exercises, signed
packages, alerting, and release evidence remain incomplete. A controlled
actual-socket loopback checkpoint passes 1/1 and proves proxy
replace/remove behavior, application-level direct-peer denial, and fail-closed
restart-bound hop-secret rotation. It does not prove real Nginx/TLS,
identity-provider, firewall/routing, or public backend-port isolation; those
deployment gates remain open. See the controlled proxy lifecycle evidence in
[deployment.md](./deployment.md#controlled-proxy-lifecycle-evidence).

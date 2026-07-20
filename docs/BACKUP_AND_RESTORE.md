# Backup and restore

Last audited: 2026-07-20

## Current status

FormaSpec currently exposes three related backup/restore surfaces. They are not
interchangeable:

| Mechanism | Implemented now | Important limitation |
| --- | --- | --- |
| Verified FormaSpec bundle engine | The server can create, verify, list, and download `formaspec-backup-*.tar` bundles. Verification checks semantic asset ownership/references, snapshots, typed operations, revision chains, and project heads across strict V1/V2 documents. Verification and download use private descriptor-pinned bytes. Restore forecasts whole-workflow capacity before maintenance, rechecks each copy/extraction step, opens sources with `O_NOFOLLOW`, and uses only expected size/SHA-256 pinned bytes afterward. | Bundles remain unsigned, so integrity and consistency checks do not establish creator provenance. Node does not expose a portable atomic no-replace directory rename, so the cutover destination race remains documented for hostile local filesystems. |
| `formaspecctl` | `backup create`, `backup list`, schedule show/enable/disable/run, preview-first retention pruning, `backup verify <bundle>`, source-local bundle restore, and externally supervised Docker/server restore/status/resume/rollback/abort/stale-lock recovery by opaque backup ID are implemented. | Managed restore accepts only the exact launcher-recorded Compose project, loopback binding, image, containers, named volumes, secure runtime environment, and Docker context. It is not a generic Compose/Kubernetes/remote-volume recovery tool, and bundles remain unsigned. |
| Compatibility launcher | `./designer backup [DESTINATION]` makes a full stopped-service copy of `DATA_DIR`. | This is a downtime copy with a small text manifest, not a verified FormaSpec bundle. |

Managed schedules use one daily UTC time and organization-policy retention
(default 7 daily/4 weekly/12 monthly). Policy can disable backup creation and
schedule enablement/run, provides the default UTC schedule, and supplies the
retention counts used by pruning. Repeated schedule execution is idempotent
within the same due window. Manual backups are permanently outside automatic
retention plans. Changing the policy default does not rewrite an already stored
schedule row; operators should review and explicitly update the schedule after
policy changes.
FormaSpec does not yet run an internal background scheduler; an authenticated
operator or service supervisor must call the schedule-run operation. The
managed Docker/server restore foundation is deliberately controlled by
`formaspecctl` outside
the running Fastify process. Backup and restore remain a production-readiness
blocker until clean server-mode recovery evidence, signed provenance, native
packaging, and complete release evidence are delivered.

The installed Docker volume has two valid checkpoint bundles:

- `backup_6805e013a2043250481491efabaf667b92662e98` — schema 7,
  4,536,320 bytes, SHA-256
  `fdaa166bf96365b326e628277f51e9d5d2348df4e78bc3733504bbb105bb0918`.
- `backup_f72fc0da90a20e6bad66b7cc46e79b7dd14ae84a` — schema 8,
  4,536,320 bytes, SHA-256
  `c26eeaeb2353c12820b6e89ebb134bea4cab1e511abe12bdf349dc0c200dc94b`.

They verify the pre/post-upgrade backup path. They were not the bundles used in
the disposable restore exercise below and neither has passed a server-mode
restore, so they remain checkpoint evidence rather than production recovery
evidence.

## Recorded disposable local-Docker restore evidence

On 2026-07-20, a completely isolated Compose project bound to host port `4397`
completed the following externally supervised exercise:

1. Created design A and one active agent connection.
2. Created and verified backup A,
   `backup_0dda1a60c54c5805557426a428739e505e089425`.
3. Added design B after that recovery point.
4. Restored backup A in operation
   `restore_e2ea0123456789abcdef0123456789` and verified that only design A
   remained with its original design and revision IDs.
5. Verified that one restored grant, one connection, and one pairing nonce were
   revoked.
6. Restored the automatically created safety backup,
   `backup_7697fb29100b0bc8adc22707114c50947ed3a668`, in operation
   `restore_e2eb0123456789abcdef0123456789`.
7. Verified that designs A and B returned with their original IDs and revisions
   and that the agent connection remained revoked.
8. Deleted the disposable containers, volumes, and network.

This is concrete local-Docker restore/rollback evidence. A separate isolated
20-step browser/MCP/source-local scenario now proves V1→V2 product/task/hash/
render recovery, but neither scenario is evidence for `APP_MODE=server`, native
packages, off-host recovery, signed backup provenance, historical customer
fixtures, or the complete asset/design-system/failure-injection matrix. The
enterprise release decision therefore remains **NO-GO**.

## Verified FormaSpec bundles

The server backup engine currently:

- uses SQLite's online backup operation to capture a consistent database;
- includes normalized assets and a secret-free organization configuration while
  excluding bridge/MCP credentials. New format-2 bundles generate this
  configuration from the staged SQLite policy ledger instead of copying an
  arbitrary `/data/organization.formaspec.yaml` file;
- records database, document, command-engine, renderer, font-bundle, and
  application versions in `backup-manifest.json`;
- records file sizes and SHA-256 hashes in the manifest and
  `checksums.sha256`;
- creates a deterministic `formaspec-backup-*.tar` archive;
- rejects non-regular entries, path traversal, more than 20,000 entries, or
  more than 16 GiB of expanded data;
- verifies every declared payload hash, SQLite integrity, foreign keys, and the
  exact recognized migration-ledger prefix before reporting success;
- requires exact `asset-manifest.json` coverage of `assets/**`, checks each
  content-addressed asset path/hash, validates raster container/chunk integrity,
  MIME, recorded dimensions, and a legacy quarantine BLOB when no normalized
  file exists. Backup creation and verification require the isolated Chromium
  raster verifier for full pixel decode, as do restore preflight, safety-backup
  verification, and final cutover;
- decompresses and validates every content-addressed snapshot against the
  strict V1 or V2 document schema and its canonical SHA-256 bytes; and
- validates bounded typed revision operations, snapshot/operation/revision hash
  chains, contiguous parent/version history, and exact project-head tuples.

Format-2 verification parses the generated organization configuration with the
strict schema and requires exact equality with the staged database policy
ledger. Historical format-1 bundles remain accepted for compatibility, without
retroactively claiming the format-2 policy-binding guarantee.

Organization Administrators can currently use authenticated server endpoints to
list, create, re-verify, and download these bundles:

- `GET /api/backups`
- `POST /api/backups`
- `GET /api/backups/schedule`
- `PUT /api/backups/schedule`
- `POST /api/backups/schedule/run`
- `POST /api/backups/prune/previews`
- `POST /api/backups/prune/previews/:previewId/commit`
- `POST /api/backups/:backupId/verify`
- `GET /api/backups/:backupId/download`

The browser Administration workspace at `/administration` exposes the same
create/list/re-verify/download flow without revealing server filesystem paths.

These endpoints are an implementation foundation, not a complete operations
surface. Schedule execution is intentionally supervisor-driven. A prune preview
persists its exact backup IDs, plan hash, and approximately 15-minute expiry;
commit re-computes the policy and revalidates every record, regular-file path,
size, inode, and SHA-256 before deletion. There is no restore endpoint, server
process self-restore, built-in timer/cron supervisor, or supported off-host
destination workflow. Restore is instead supervised by the host CLI and a
network-disabled one-shot `restore-worker` container for an exact
launcher-pinned local-Docker or server runtime.

The tested server restore primitive requires a closed database, verifies the
bundle, stages candidate and rollback trees inside the destination filesystem,
and journals top-level moves without renaming the `/data` mount root. It retains
rollback material when cutover or rollback is uncertain and resumes an
incomplete rollback on the next invocation.

For a launcher-recorded Docker or server runtime, `formaspecctl` now fences the
application with maintenance state outside `/data`, stops only the API, and runs
the restore engine in a network-disabled one-shot worker. That worker creates a
verified manual safety backup, closes SQLite before cutover, validates the
current migration ledger, runs SQLite integrity/foreign-key checks, performs a
deterministic Playwright render smoke through the existing renderer socket,
reconciles audit/outbox state, and revokes restored grants, connections, and
pairing nonces. The API is restarted under maintenance and normal readiness is
required before maintenance can clear.

The isolated A/B exercise above is recorded recovery evidence only for its
launcher-local topology. The same supervisor now supports the strict
launcher-recorded server topology, but a clean server-mode proxy/restore run,
failure-injection matrix, signing, encryption, native installer integration,
and broader recovery fixtures are unfinished. Restore closes the pathname replacement
window by copying from an `O_NOFOLLOW` handle into private read-only staging,
checking the expected managed size/SHA-256, and using only those pinned bytes
for journal matching, verification, and extraction. The current hashes prove
consistency of the bytes that were checked; without a trusted signature they do
not prove who created the bundle.

## Create, list, verify, and restore from the CLI

With the local loopback service running:

```bash
pnpm formaspecctl backup create
pnpm formaspecctl backup list
pnpm formaspecctl backup schedule show
pnpm formaspecctl backup schedule enable --at 02:00
pnpm formaspecctl backup schedule run
```

`backup create` calls the authenticated local FormaSpec boundary, which creates
the online SQLite snapshot, verifies it immediately, records the opaque backup
ID, and prints its SHA-256. It does not return a server path; download the
verified artifact from Administration or the authenticated backup endpoint.

Use the CLI only with a `formaspec-backup-*.tar` bundle created by the verified
server engine:

```bash
pnpm formaspecctl backup verify /safe/path/formaspec-backup-2026-07-19.tar
```

For machine-readable output:

```bash
pnpm formaspecctl backup verify /safe/path/formaspec-backup-2026-07-19.tar --json
```

The verify command validates archive bounds and paths, exact manifest/checksum
coverage, SQLite integrity, foreign keys, the migration ledger, asset-file/BLOB
integrity, canonical snapshots, typed revision operations and hash chains, and
project-head consistency. It does not modify the active FormaSpec data
directory or run Chromium.

### Retention preview and prune

The managed policy retains the newest policy-configured daily, weekly, and
monthly verified scheduled backups (default 7/4/12). Manual backups are reported
as exempt and are never included in a prune candidate list.

First create and review a dry-run preview:

```bash
pnpm formaspecctl backup prune preview
```

The command prints the exact candidate IDs, byte count, plan hash, expiry, and a
ready-to-copy commit command. Commit only that reviewed plan:

```bash
pnpm formaspecctl backup prune execute \
  --preview-id backup_prune_preview_<id> \
  --plan-hash <sha256> \
  --yes
```

Any scheduled-backup change, expired preview, file replacement, size change,
hash mismatch, unsafe path, or missing record rejects the commit without
pruning database records. Deletion is serialized with backup creation by an
expiring operational lock and is audit recorded. A supervisor should call
`backup schedule run` at least once per day after the configured UTC time; a
repeated call in the same due window returns the existing backup.

### Source-local restore foundation

Restore is deliberately destructive and therefore requires the literal
`--yes` authorization:

```bash
pnpm formaspecctl backup restore /safe/path/formaspec-backup-2026-07-19.tar --yes
```

The source-local workflow:

1. refuses a recorded `docker` or `server` runtime without changing it;
2. verifies the complete incoming bundle and rejects database versions newer
   than this CLI supports;
3. stops the local bridge and any launcher-recorded `local` or `dev` service;
4. creates a stopped-service safety copy under
   `.designer/backups/pre-restore-*` when `./data` already exists;
5. invokes the tested atomic restore/swap helper with rollback on post-swap
   migration-ledger health-check failure; and
6. leaves FormaSpec stopped for inspection and an explicit
   `formaspecctl start local`.

The safety copy is the compatibility directory format, not another verified
FormaSpec tar bundle. If it cannot be created, restore is cancelled before the
active data directory is replaced. A built server restore engine is required;
source operators can prepare it with:

```bash
pnpm --filter @designer/server build
```

The source-local verifier hashes the exact tar stream it validates and passes
that SHA-256 and byte size to the restore engine. The engine then pins and
rechecks the same identity before extraction, so verification and restore
cannot silently use different source bytes.

Machine-readable restore output is available with `--json`. The isolated
20-step harness explicitly stops the database, invokes this restore engine,
restarts FormaSpec, and verifies exact hashes/state plus a PNG smoke. The CLI
path itself still does not provide maintenance mode, automatic restart,
audit-complete external supervision, or server deployment orchestration; those
remain release blockers for this restore path.

### Externally supervised Docker/server restore foundation

Use only an exact opaque ID returned by the Administration backup list (or by
`backup list` in local Docker mode); arbitrary host or container paths are
rejected:

```bash
pnpm formaspecctl backup list
pnpm formaspecctl backup restore --backup-id backup_<40-lowercase-hex> --yes
```

The command is accepted only when launcher state records `docker` or `server`
mode and a mode-`0600` binding exists at
`.designer/run/docker-runtime-binding.json`. The binding pins the Docker
context and daemon identity, image digest, container identities and Compose
labels/project path, named data/backup/socket volumes, renderer isolation, and
loopback-published API port. Binding format 2 also pins a SHA-256 of the
secret-redacted environment identity plus the non-secret runtime/access mode
and health `Host`;
the bearer value is never serialized or forwarded to the one-shot worker.
Format-1 local bindings are read compatibly and upgraded in memory. Restore
revalidates that exact runtime instead of trusting the ambient Docker context
or current Compose discovery. It holds the
launcher application lock, stops the local bridge, and performs these
externally supervised steps:

1. start/verify the pinned renderer and complete a read-only target preflight
   before maintenance is entered, including a conservative forecast for the
   simultaneous safety-backup, source pin, verification, and candidate-data
   capacity peak;
2. create the fixed, path-free maintenance marker at
   `/backups/.formaspec/maintenance.json` through a one-shot control process;
3. stop only the `designer` API service;
4. use hardened direct `docker run`, not ambient Compose execution, to launch
   the non-root, read-only-root, capability-free, network-disabled
   `restore-worker` with exactly the pinned image, `/data`, `/backups`, and
   renderer-socket volumes;
5. pin the target bytes in a private mode-`0700` directory on `/backups`, make
   the copied bundle mode `0400`, and verify its database record, filename,
   size, SHA-256, bundle structure, and semantic data relationships;
6. create and verify a manual managed safety backup, record durable operation
   state outside `/data`, close SQLite, and execute the journaled cutover;
7. verify current-schema SQLite integrity/foreign keys, the target
   organization, and a representative deterministic Playwright render;
8. reconcile the target and safety records, preserve monotonic audit/outbox ID
   floors, append the restore audit/outbox event, atomically revoke every
   restored active agent grant, connection, and pairing nonce, and repeat the
   revocation postcondition after audit/outbox triggers have run; and
9. restart the API while maintenance is still active, verify liveness,
   renderer health, maintenance-fenced readiness, clear maintenance only after
   a durable terminal result, then verify exact-schema normal readiness and the
   isolated Playwright renderer again.

The worker and control process share the non-expiring lock
`/backups/.formaspec/restore-worker.lock.json`. Fastify refuses to open SQLite
while that lock exists or a cutover is incomplete. The path-free durable
operation record advances through exactly these crash-resumable states:

- `prepared`: the target and verified safety backup are fixed before cutover;
- `cutover_committed`: the journaled `/data` cutover completed and health must
  be rechecked before cleanup;
- `reconciled`: database, render, audit/outbox, and credential-revocation work
  completed successfully; or
- `rolled_back`: the verified safety state was restored after failure.

A retry of `cutover_committed` repeats health verification; it does not skip
directly to cleanup. If private pinned-source cleanup fails after a successful
cutover, the committed journal is retained so a retry repeats health
verification before cleanup. Exact restore-source orphan directories are never
deleted while a durable `prepared` or `cutover_committed` operation may still
need operator recovery evidence. Maintenance removal is the final restore
mutation.

During maintenance, `/api/*`, `/mcp`, `/events`, and `/api/events` fail with
retryable `TEMPORARILY_UNAVAILABLE`; `/health/ready` and `/ready` still perform
database, migration, and renderer checks but return maintenance `503` with the
exact operation ID. `/health/live` and `/health/render` remain available.
`GET /api/maintenance/status` is the authenticated read-only exception. A
malformed, unreadable, oversized, or symlinked marker fails closed, and
maintenance never expires automatically.

If orchestration is interrupted or uncertain, the CLI leaves maintenance,
operation state, cutover journal, and rollback material in place. Inspect it
without changing data:

```bash
pnpm formaspecctl backup restore status
pnpm formaspecctl backup restore status --json
```

Status is also bound to and revalidates the exact recorded Docker runtime; it
does not inspect an ambient Compose project.

Resume the matching operation only after inspecting logs and status:

```bash
pnpm formaspecctl backup restore resume --yes
```

If interruption occurred before the durable operation record was created, the
status output instructs the operator to repeat the exact target ID:

```bash
pnpm formaspecctl backup restore resume \
  --backup-id backup_<40-lowercase-hex> \
  --yes
```

An explicit rollback restores the verified safety backup as a separately
supervised restore operation:

```bash
pnpm formaspecctl backup restore rollback --yes
```

If preflight stopped before any operation record, cutover journal, or worker
lock was created, the operator can explicitly clear only that empty maintenance
attempt:

```bash
pnpm formaspecctl backup restore abort --yes
```

If status reports a valid worker lock but the worker container no longer
exists, the pinned Docker supervisor can prove the exact container is absent
before removing only that stale lock:

```bash
pnpm formaspecctl backup restore clear-stale-lock --yes
```

Neither command is a force option. `abort` refuses any operation/journal/worker
evidence, and `clear-stale-lock` refuses an invalid lock, mismatched ownership,
or a worker container that still exists.

An interrupted operation whose rollback state is not yet conclusive must be
resumed first. Do not manually delete the maintenance marker, operation record,
restore journal, rollback tree, or safety bundle. A successful restore or
rollback revokes all restored agent credentials; reconnect Codex explicitly:

```bash
pnpm formaspecctl agent connect codex --yes
```

This command surface is supported only for the launcher-recorded Compose
topology created by the current `designer`/`formaspecctl` server or local-Docker
startup. Server mode must retain its mode-`0600` `.designer/env/server.env`,
loopback-only published port, exact HTTPS public origin/Host, trusted-header
configuration, fixed Compose project, and pinned named volumes. A changed env,
Host, context, daemon, image, container, label, port, or volume makes the
binding stale and restore fails before mutation. Direct/unknown Compose
projects, custom project names, bind-mounted data, Kubernetes/Swarm, guessed
volumes, and an operator invoking the CLI from a different unpinned checkout
remain unsupported.

The local-Docker implementation, focused tests, and the recorded isolated A/B
exercise are still not a completed release gate. Restore pins the source once,
validates its managed identity, and uses only the private pinned copy through
cutover; the valid-bundle pathname-swap regression test passes. Checksums and
hash chains detect inconsistent content but do not provide signed provenance.

## Compatibility launcher downtime copy

The compatibility command remains available for local evaluation and recovery
while the operator CLI is incomplete:

```bash
./designer backup /safe/path/designer-downtime-copy
```

For launcher-managed Docker, the command stops the `designer` service, copies
the complete `/data` directory, restarts the service, and writes
`manifest.txt`. In native/source mode, it refuses to copy while the launcher
process is running, so stop it first:

```bash
./designer stop
./designer backup /safe/path/designer-downtime-copy
./designer start local --no-open
```

This directory copy is not accepted by `formaspecctl backup verify`. It has no
cryptographic manifest, bounded archive validation, clean-room verification, or
automated restore. Treat it as a compatibility fallback, not as evidence that a
recoverable enterprise backup exists.

## Recovery unit

For a compatibility copy, keep the complete `DATA_DIR` together, including:

- `designer.sqlite` and any `designer.sqlite-wal` or `designer.sqlite-shm`;
- content-addressed asset directories and quarantined legacy asset data;
- organization configuration and other application-managed data files.

Never copy or restore only one table, one revision, or only the main SQLite
file. Do not mix data files from different backup times. Keep `.designer/env`
and local bridge credential stores out of data backups; they have a separate
secret-management lifecycle.

`formaspecctl backup restore <bundle> --yes` supports the source-local `./data`
recovery unit and leaves that service stopped. The
`formaspecctl backup restore --backup-id <id> --yes` command supports the
launcher-recorded local-Docker or server data and backup volumes through the
external supervisor above. Test recovery in an isolated environment, keep source bundles
unchanged, and never replace a volume manually while an operation or
maintenance marker exists. Docker volume names are deployment-specific;
determine them from `docker compose config` rather than guessing.

## Post-restore checks

A release-qualified restore workflow must keep normal writes disabled until all
of these checks pass:

1. `GET /health/ready` succeeds and reports the expected migration version.
2. The expected organization and projects are present.
3. Representative project heads and immutable revision history match the
   backup.
4. Snapshot and revision hash chains validate.
5. Representative normalized assets load and match their hashes.
6. Representative V1 and V2 documents open without migration loss.
7. Chromium renders a representative frame at the expected dimensions.
8. Audit/outbox processing resumes without gaps or duplicate operations.

The bundle verifier now covers archive/checksum, asset, canonical snapshot,
revision/hash-chain, project-head, SQLite, foreign-key, and migration-ledger
integrity. The Docker/server worker additionally checks the current schema,
organization, deterministic renderer, audit/outbox reconciliation, and agent
revocation before the supervisor clears maintenance. The isolated A/B Docker
scenario and the separate 20-step source-local V1/V2/product-spec/task/hash/
render scenario both pass. Complete normalized/legacy asset and design-system
recovery coverage, historical fixtures, failure injection, reconnect/
revocation, and a clean server-mode restore exercise remain unverified.

## Retention and unfinished operator work

Until a supported service supervisor and complete restore workflow are shipped:

- create recovery points deliberately and record who created and verified them;
- download verified bundles to an organization-approved off-host location;
- restrict backup access to Organization Administrators and storage operators;
- use encrypted storage appropriate for company data;
- test restoration into an isolated copy rather than the active volume;
- run the authenticated schedule command from a trusted supervisor and alert on
  failures or missed windows;
- review every prune preview before using its exact commit command;
- apply separate retention to downloaded/off-host copies through the
  organization's approved storage process.

Release-blocking backup work still includes server external-supervisor
integration and alerting, signing/provenance, native-installer/service
integration, server maintenance and rollback evidence, off-host destination
operations, broader asset/design-system/historical/failure recovery fixtures,
and clean install/upgrade/restore coverage across packaged targets. Do not
declare FormaSpec production-ready based on the current backup primitives,
the isolated local-Docker exercise, or the passing source-local 20-step
scenario.

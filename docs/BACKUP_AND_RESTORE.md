# Backup and restore

Last audited: 2026-07-22

## Current status

FormaSpec currently exposes three related backup/restore surfaces. They are not
interchangeable:

| Mechanism | Implemented now | Important limitation |
| --- | --- | --- |
| Verified FormaSpec bundle engine | The server can create, verify, list, and download `formaspec-backup-*.tar` bundles. Verification checks semantic asset ownership/references, snapshots, typed operations, revision chains, and project heads across strict V1/V2 documents. Verification and download use private descriptor-pinned bytes. Restore forecasts whole-workflow capacity before maintenance, rechecks each copy/extraction step, opens sources with `O_NOFOLLOW`, and uses only expected size/SHA-256 pinned bytes afterward. | Bundles remain unsigned, so integrity and consistency checks do not establish creator provenance. Node does not expose a portable atomic no-replace directory rename, so the cutover destination race remains documented for hostile local filesystems. |
| `formaspecctl` | `backup create`, `backup list`, schedule show/enable/disable/run, preview-first retention pruning, `backup verify <bundle>`, source-local bundle restore, managed-ID planned restore, explicitly authorized offline bundle restore, and status/resume/rollback/abort/stale-lock recovery are implemented. | Both Docker/server paths accept only the exact launcher-recorded Compose project, loopback binding, image, containers, verified local named volumes, secure runtime environment, and Docker context. Managed-ID restore is `HEALTHY_PLANNED_RESTORE_ONLY`; offline restore requires an operator-selected verified bundle and explicit `--yes`. Neither is a generic Compose/Kubernetes/remote-volume tool and bundles remain unsigned. Real unique-project CLI and same-machine copied-bundle smokes pass; server-mode proxy, packaged-runtime, real remote-host/network/TLS/off-site storage, and broader lifecycle evidence remain open. |
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
blocker until clean server-mode planned/offline recovery evidence, signed
provenance, native
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
render recovery. Deterministic source-built schema 1 and schema 7–11 fixtures
also verify genuine migration-ledger prefixes, exact V1 history/assets, linked
enterprise rows, and restore-to-schema-12 behavior. These fixtures are not a
substitute for anonymized real-customer corpora, `APP_MODE=server`, native
packages, off-host recovery, signed backup provenance, or the complete
asset/design-system/failure-injection matrix. The enterprise release decision
therefore remains **NO-GO**.

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

The historical backup tests build schema 1 and schema 7–11 databases by
applying the actual production migration prefix to a fresh SQLite file. They do
not imitate old databases by deleting current tables. Reviewed schema and row
digests make historical-schema or fixture-data drift fail visibly.

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

The managed-ID supervised path is deliberately classified as
`HEALTHY_PLANNED_RESTORE_ONLY`. Before maintenance, it uses the healthy current
API/database to resolve the opaque backup ID and perform target preflight. It
cannot recover a stopped or corrupt API/database from an otherwise valid
bundle. For that condition, operators must use the separately authorized
offline bundle command described below rather than relabeling the planned path.

### Offline Docker/server disaster-recovery foundation

Use this only when the exact launcher-recorded Docker/server runtime remains
available but the pinned API is stopped or its current SQLite database cannot
support managed backup-ID resolution:

```bash
pnpm formaspecctl backup restore offline \
  /safe/path/formaspec-backup-2026-07-20.tar \
  --yes
```

This is a distinct explicit authorization boundary. The CLI first runs the
standalone backup verifier and refuses a target database version newer than the
CLI supports. It then reopens the selected regular file with `O_NOFOLLOW` where
available, verifies file/device/inode/size identity against that result, and
streams only the opened descriptor through stdin to a network-disabled one-shot
worker. The host path is never exposed inside the container. The worker accepts
only the preauthorized SHA-256 and byte count, writes into a private mode-`0700`
directory, and first checks capacity for the authorized stdin payload plus a
fixed reserve. It verifies the stream exactly, fully inspects the target, runs
a conservative whole-workflow capacity forecast, and retains the immutable
target as a mode-`0400` managed bundle. Supervisor/worker child stdout and
stderr share one combined 4 MiB budget by default; excess aggregate output
terminates the child and fails recovery rather than exhausting host memory.
Focused tests also prove the 5-second SIGKILL fallback when an over-budget child
ignores SIGTERM.

Before any `/data` cutover, offline preparation performs the full bounded
bundle, SQLite, V1/V2, snapshot/revision-chain, asset, policy, and isolated
raster verification. It also creates and verifies a checksummed forensic
recovery bundle containing the exact existing data-directory bytes. This
forensic safety capture performs bounded tree accounting and capacity checks
before copying the current tree and again before writing the archive. It
deliberately does not open or bless the old database, so it can preserve the
only pre-state even when SQLite is corrupt. Durable
operation state records `recovery.mode=offline` and `safetyKind=forensic` before
the ordinary journaled cutover begins.

After preparation, the same restore engine used by planned recovery performs
the target cutover, current-schema integrity and foreign-key checks,
representative deterministic Playwright render, audit/outbox reconciliation,
monotonic ID preservation, and atomic revocation of every restored grant,
connection, and pairing nonce. The API is restarted under maintenance and must
pass maintenance-fenced and then normal readiness before success is reported.

Every failure after offline maintenance is acquired remains fenced. The CLI
does not auto-abort or restart the API, even if no durable operation exists yet
or preparation is incomplete. Correct the capacity/source/renderer/runtime
failure and resume with the same `--offline-bundle`. When a new recovery takes
over a forensic-rollback fence, the predecessor remains the durable maintenance
owner until replacement preparation has been persisted; failed preparation
restores the predecessor fence unchanged. A resumed takeover uses the current
maintenance owner as the operation ID for `offlinePrepare` and the replacement
worker; it does not accidentally resume under the retained predecessor ID.

If interruption occurred before durable preparation, resume by selecting the
same bundle again so it can be independently reverified and repinned:

```bash
pnpm formaspecctl backup restore resume \
  --offline-bundle /safe/path/formaspec-backup-2026-07-20.tar \
  --yes
```

Once status shows a durable prepared offline operation, ordinary
`backup restore resume --yes` continues from its retained target. A different
bundle is never substituted implicitly. Explicit `backup restore rollback
--yes` restores the exact forensic pre-state bytes. Because those bytes may
contain the original corruption, successful forensic rollback keeps maintenance
active, leaves the API stopped, and returns `maintenanceCleared: false` plus
`serviceReady: false`; it never claims readiness or restored credential safety.
The operator must not clear the fence or manually start the old data. Restore
control rejects direct clear for this terminal state; only a newly selected and
fully verified offline restore can atomically take over the forensic-rollback
fence.

Focused server/CLI tests prove corrupt-database capture, exact source pinning,
stdin-only transfer, full target verification, standard revocation, resume,
and forensic rollback semantics. A disposable unique-Compose smoke additionally
ran the production worker/control path against a real schema-11 design and PNG,
replaced live SQLite with corrupt marker bytes, restored the exact design and
render, revoked one grant/connection/nonce, restored the exact corrupt bytes,
persisted durable `rolled_back`/`recovery=offline` state, and cleaned up without
touching the user's live project. Its fence was removed only for disposable
cleanup before direct-clear rejection was tightened; current product semantics
do not permit that operation. A subsequent real unique-project `formaspecctl`
smoke validates that the persisted Compose identity owns the full CLI recovery
path. Server-mode lifecycle, packaged runtimes, real remote-host/off-site policy, alerting,
signed provenance, and disaster-recovery drills remain open.

### Same-machine copied-bundle recovery evidence

The historical schema-12 runtime image `sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`
passed a second, isolated source-to-clean-target recovery simulation on
2026-07-21. The hardened runner:

- rejected Docker daemon/context/config/TLS control overrides and verified the
  active local Unix socket context before creating resources;
- started independent source project `formaspecdrsourcede20d670cd` and target
  project `formaspecdrtargetde20d670cd` with distinct local data, backup, and
  renderer-socket volume names and mountpoints;
- created and verified a format-2 bundle, copied the exact hash/size through a
  separate temporary location, stopped the source, and streamed only the
  pinned bytes into the target offline preparation path;
- proved the target was initially empty, then verified SQLite integrity and
  foreign keys, migration 12, exact snapshot/revision hashes, normalized asset
  bytes and metadata, and deterministic PNG equality after restore;
- verified non-root runtime UIDs and the exact image ID for both long-lived
  services and all seven one-shot helpers; and
- removed every disposable container, volume, network, and transfer directory.

The checksum-bound evidence is
`/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json`
with SHA-256
`2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`.
The transferred bundle SHA-256 was
`f12887796030081d495ef3b266abf7b22f58cdb01fbe494072171e57ce73bfcc`;
the recovered design was `document_9989d40c2c194b5dafb7f7da08bfc4b9` at
revision `revision_3b6cbf1a84f5421b9f57c370d4541db2`.
It deliberately reports `releaseStatus: NO-GO`,
`realRemoteHostVerified: false`, `realNetworkTransferVerified: false`, and
`tlsVerified: false`. This closes a same-machine independent-target evidence
gap only; it does not establish remote storage, transport security, real
off-site recovery, packaged supervision, provenance, or company RTO/RPO.

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
repeated call in the same due window returns the existing backup. Each attempt
persists start/success/failure audit and outbox evidence. `/health/ready` and
`formaspecctl backup schedule show` report bounded overdue, stalled, failed-run,
and retention-backlog diagnostics. Failed or stalled attempts remain critical
even when the current window already contains a valid backup; error details and filesystem paths are not
published through SSE.

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
or current Compose discovery. Binding capture and every verification call live
`docker volume inspect` for the data, backup, and renderer-socket volumes. Each
must use driver `local`, scope `local`, no options, a bounded absolute
mountpoint, and a distinct backing identity. Plugin, NFS, bind-backed, and
aliased volumes are rejected. It holds the
launcher application lock, stops the local bridge, and performs these
externally supervised steps:

1. require the current API/database to be healthy, start/verify the pinned
   renderer, and complete a read-only target preflight
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

Every health request has an independent absolute deadline, including when a
requester never settles. Launcher lock acquisition rejects symlinked or
unexpected `.designer/run` state without recursively removing an unvalidated
path. If a planned pre-cutover resume or rollback worker fails after maintenance
aborts, the supervisor restarts and verifies the unchanged API. If that restart
also fails, both failures are preserved in an aggregate error. Offline recovery
does not use this auto-abort/restart behavior and remains fenced for explicit
resume.

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

For pristine or prepared pre-cutover state, the operator may request abort:

```bash
pnpm formaspecctl backup restore abort --yes
```

If status reports a valid worker lock but the worker container no longer
exists, the pinned Docker supervisor can prove the exact container is absent
before removing only that stale lock:

```bash
pnpm formaspecctl backup restore clear-stale-lock --yes
```

Neither command is a force option. `abort` refuses a cutover journal or worker
lock, verifies a prepared offline forensic bundle when present, and reopens the
unchanged live database read-only to require integrity, foreign keys, and the
current migration ledger before clearing maintenance. Corrupt pristine or
prepared offline state therefore returns `VALIDATION_FAILED` and stays fenced
for resume; raw non-SQLite/open/query failures are normalized to the same domain
error. Terminal forensic rollback cannot be cleared at all.
`clear-stale-lock` refuses an invalid lock,
mismatched ownership, or a worker container that still exists.

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
configuration, persisted exact Compose project, and pinned named volumes. A changed env,
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
healthy planned supervisor above. The offline form,
`formaspecctl backup restore offline <bundle> --yes`, supports the same pinned
Docker/server topology without consulting the
current database and preserves an exact forensic pre-state bundle first. Test
recovery in an isolated environment, keep source bundles
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
render scenario both pass. Focused offline preparation/forensic tests also pass.
Complete normalized/legacy asset and design-system recovery coverage,
anonymized real-customer fixtures, broader failure injection, reconnect/revocation, a clean
server-mode planned/offline restore exercise, and an isolated end-to-end CLI
offline disaster-recovery lifecycle remain unverified; the disposable worker/
control production-path smoke above passes.

## Retention and unfinished operator work

Until a supported external scheduler, alert-delivery integration, and complete
restore workflow are shipped:

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

Release-blocking backup work still includes installed external schedule
invocation and alert delivery, signing/provenance, native-installer/service
integration, server maintenance and rollback evidence, off-host destination
operations, broader asset/design-system/historical/failure recovery fixtures,
and clean install/upgrade/restore coverage across packaged targets. Do not
declare FormaSpec production-ready based on the current backup primitives,
the isolated local-Docker exercise, or the passing source-local 20-step
scenario.

# FormaSpec support bundles

FormaSpec support bundles are deliberately small, source-local diagnostic
archives. They are not backups and cannot restore an installation. The
collector has no network or subprocess access and does not inspect Docker
volumes or an operating-system credential store.

## Safe workflow

Preview the exact inventory without writing a file:

```bash
pnpm formaspecctl support-bundle preview
pnpm formaspecctl support-bundle preview --json
```

After reviewing the inventory, authorize creation explicitly:

```bash
pnpm formaspecctl support-bundle create --yes
pnpm formaspecctl support-bundle create ./formaspec-support.tar --yes
```

Creation writes both the TAR archive and an adjacent
`<archive>.manifest.json` local-preview sidecar. The sidecar records the exact
entry inventory, entry hashes, archive byte count, and archive SHA-256. Review
the sidecar and sanitized log entries locally before sharing the TAR. Existing
archive or sidecar files are never overwritten.

Without an output argument, the archive is written beneath
`.designer/support-bundles/`. The `--yes` flag is mandatory; an interactive
terminal prompt is intentionally not accepted as a substitute.

## Included inventory

Only the following fixed inventory is eligible:

- FormaSpec CLI, supported database, Node runtime, and operating-system
  version metadata. Hostname and environment variables are omitted.
- Source-local migration status from `data/designer.sqlite`, when the migration
  ledger can be opened read-only. Only version/count/state metadata is copied;
  no database path, row, schema, snapshot, or design content is copied.
- Sanitized launcher state: recognized mode, recorded-port validity,
  process-alive state, URL classification, environment-file presence, and lock
  presence. Saved URLs, PIDs, and environment-file paths are omitted.
- Sanitized local-bridge state: schema version, process-alive state, URL
  classification, and whether an instance ID was recorded. The instance ID and
  URL are omitted.
- Key names from only `.designer/env/docker.env` and
  `.designer/env/server.env`. Every value is represented as `<redacted>`;
  comments, malformed lines, and file contents are omitted.
- Bounded tails from only `.designer/logs/local.log` and
  `.designer/logs/formaspec-bridge.log`. Symlinks and non-regular files are
  skipped. ANSI/control sequences, private paths, URLs, authorization/cookie
  headers, labeled secrets, common provider tokens, JWTs, and private-key
  blocks are removed or redacted.

The archive contains:

```text
checksums.sha256
support-manifest.json
diagnostics/config-keys.json
diagnostics/migration-status.json
diagnostics/runtime-state.json
diagnostics/versions.json
logs/local.log                 # only when the allowlisted file exists
logs/formaspec-bridge.log      # only when the allowlisted file exists
```

Entries are ordered deterministically, use fixed TAR ownership/mode/timestamp
metadata, and have SHA-256 records. For the same source snapshot and creation
time, the TAR bytes and checksums are identical.

## Always excluded

The collector never adds:

- SQLite databases, WAL/SHM files, snapshots, revisions, designs, or audit
  records;
- assets, uploaded images, rendered previews, portable exports, or backups;
- environment values, environment dumps, arbitrary configuration files, or
  saved environment-file paths;
- repository source, Git data, workspace inventories, or arbitrary filesystem
  paths;
- bearer tokens, scoped grants, pairing nonces, authorization headers,
  credential-store data, private keys, or cookies;
- Docker/container logs, browser storage, network responses, or command output.

Do not manually add excluded material to the TAR. Use a verified FormaSpec
backup for recovery and follow the organization's protected data-transfer
process for design data.

## Enforced bounds

| Input/output | Limit |
| --- | ---: |
| Each named config file | 64 KiB |
| Config keys per file | 256 |
| Each named state file | 16 KiB |
| Tail read per allowlisted log | 256 KiB |
| Sanitized output per log | 192 KiB and 2,000 lines |
| Payload files | 16 |
| Total payload bytes | 512 KiB |
| Final TAR bytes | 768 KiB |

Oversized config/state inputs are reported only by a fixed status and are not
read into the bundle. Logs are tail-read and marked `truncated` in the manifest
when any source/line/byte limit applies. Crossing a total file or byte limit
aborts creation instead of silently widening collection.

## Review and incident handling

Redaction is defense in depth, not permission to share diagnostics publicly.
Application logs may contain product text or organization-specific context
that is not a credential. Review every included sanitized log before attaching
a bundle to a ticket. If a secret is found, revoke/rotate it, delete every copy
of the bundle, and report the redaction gap through the security process.

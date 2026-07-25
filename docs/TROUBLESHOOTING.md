# Troubleshooting

## The launcher reports missing requirements

```bash
./designer doctor auto
```

Use Docker mode when a compatible local Node/pnpm toolchain is unavailable.

## FormaSpec does not open

```bash
pnpm formaspecctl ensure-running --json
pnpm formaspecctl status
./designer logs
```

Check `/health/live`, `/health/ready`, and `/health/render`. Keep Docker bound
to `127.0.0.1` in local mode.

## A FormaSpec preview link does not open

Run `pnpm formaspecctl ensure-running --json`. The launcher resumes only the
runtime mode that created the link. If it reports Docker as unavailable, start
Docker Desktop/Engine and retry; do not start local mode because that would use
a different data store. Installed `formaspec://open-review` handlers compare
the link's `store_…` identity with the recovered runtime before opening the
exact persisted preview.

## Codex cannot see FormaSpec

```bash
./designer --yes agent connect codex
```

Then verify `codex mcp get formaspec` and start a new Codex task. Codex should
contain no bearer token for this MCP entry. Invoke the managed version-0.3.0
integration as
`[@FormaSpec](plugin://formaspec@formaspec)`.

If an old task still shows removed identities, open a new Codex task. Tasks
retain the plugin inventory they had when they were created.

## A write reports VERSION_CONFLICT

Do not overwrite. Preserve the local draft, refetch the authoritative head,
inspect the latest actor/version, then create a new preview. V1 does not merge
automatically.

## Rendering fails

Source evaluation needs Playwright Chromium or explicitly allowed system
Chrome. Production must not enable the software fallback. See server logs and
`/health/render`.

## Backup verification fails

Do not restore or download-as-valid a failed bundle. Preserve it for diagnosis,
create a new online backup, and compare manifest/checksum/database errors.

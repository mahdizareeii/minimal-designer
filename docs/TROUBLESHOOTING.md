# Troubleshooting

## The launcher reports missing requirements

```bash
./designer doctor auto
```

Use Docker mode when a compatible local Node/pnpm toolchain is unavailable.

## FormaSpec does not open

```bash
pnpm formaspecctl status
./designer logs
```

Check `/health/live`, `/health/ready`, and `/health/render`. Keep Docker bound
to `127.0.0.1` in local mode.

## Codex cannot see FormaSpec

```bash
./designer --yes agent connect codex
```

Then verify `codex mcp get formaspec` and start a new Codex task. Codex should
contain no bearer token for this MCP entry. The managed integration is
`formaspec@formaspec`, invoked as
`[@FormaSpec](plugin://formaspec@formaspec)`.

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

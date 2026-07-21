# Upgrading

Current upgrades are source/operator procedures, not a production-grade
automatic workflow.

1. Create and download a verified backup:

   ```bash
   pnpm formaspecctl backup create
   pnpm formaspecctl backup list
   ```

2. Verify the downloaded bundle independently.
3. Test the new code and automatic migrations against a disposable restored
   copy; do not use the active data directory.
4. Stop FormaSpec.
5. Update through the organization's reviewed source process and install from
   the pinned lockfile.
6. Run typecheck, all tests, build, launcher tests, and Compose validation.
7. Start on loopback and verify migrations, projects, history, assets, SSE,
   Codex, and real Chromium rendering.
8. Restore access only after the evidence passes.

Database migrations are forward-only and the ledger is immutable. The server
refuses a database newer than its supported version. Never delete or rewrite
migration rows, snapshots, or historical revisions to force a downgrade.

Supported source and pinned Docker/server maintenance commands now cover managed
restore, separately authorized offline restore, status, resume, rollback, abort,
and stale-lock recovery:

```bash
pnpm formaspecctl -- backup restore --backup-id backup_<40-lowercase-hex> --yes
pnpm formaspecctl -- backup restore offline /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore status
pnpm formaspecctl -- backup restore resume --yes
pnpm formaspecctl -- backup restore resume --offline-bundle /safe/path/formaspec-backup.tar --yes
pnpm formaspecctl -- backup restore rollback --yes
```

Managed backup-ID restore requires a healthy current API and database for
resolution and preflight; the offline command verifies an operator-selected
bundle without opening that database. These are maintenance foundations, not a
release-qualified upgrade/downgrade or privileged native-package lifecycle.

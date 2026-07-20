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

A supported maintenance-mode restore/rollback command is not implemented yet.

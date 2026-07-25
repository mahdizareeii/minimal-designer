# Product-manager to backup-restore E2E

FormaSpec includes one deterministic Playwright release scenario at
`apps/server/e2e/product-manager-backup-restore.spec.ts`. It uses a fresh
temporary data directory, backup directory, SQLite database, loopback port,
and browser context for every run. Existing projects, launcher state, and
Docker volumes are never used.

The scenario records these 20 observable steps:

1. Start an isolated local workspace and pass readiness.
2. Create a web project from the dashboard in a real browser.
3. Create and verify the backup required before V2 migration.
4. Migrate only the active project head from V1 to strict V2.
5. Enter and save the canonical product brief without creating an agent task.
6. Complete all 22 versioned product-manager interview sections.
7. Pair a short-lived, project-scoped Codex connection and initialize MCP.
8. Confirm the exact Product/Design selection, create the immutable task through
   MCP, claim it, and append an in-progress transition.
9. Read the active browser context and canonical V2 project head.
10. Preview a structured multi-screen design using transaction-local IDs.
11. Lint the persisted preview without changing history.
12. Render the same preview as a bounded PNG.
13. Transition the MCP-created task to `awaiting_approval` with its exact preview
    output; the agent does not commit or complete it.
14. Use the website's human **Commit** action to atomically commit the exact
    preview as an immutable revision and complete the task.
15. Select and correct the same design manually in the browser editor.
16. Read that selection and preview a selection-scoped agent refinement.
17. Commit the refinement while preserving the human-authored copy.
18. Restore the human revision through browser history and inspect its hashes.
19. Validate canonical JSON, a portable `.formaspec.zip`, and a final backup.
20. Add post-backup drift, stop the database, restore, restart, and prove exact
    recovery of project hashes, product specification, interview, task, and PNG
    rendering while proving the drift and sentinel project disappeared.

The test attaches a JSON evidence record with step durations and the explicit
release limitations. On failure, Playwright retains a trace and screenshots.

## Run it

Run the root release scenario command:

```bash
pnpm test:e2e:release
```

The root command builds core, web, and server before invoking the server's
typed Playwright release config.

Chrome is the default channel on macOS. Set
`FORMASPEC_E2E_BROWSER_CHANNEL` to select another installed Chromium channel.

## Security and release boundary

- The browser uses the local human principal.
- MCP uses a separately paired bearer grant restricted to the test project and
  the exact design/task scopes needed by the workflow.
- Agent-owned previews are inspected through authenticated MCP content blocks;
  the browser principal cannot bypass preview ownership through REST.
- The task agent stops at `awaiting_approval`; only the website's authenticated
  human action commits or discards the exact preview. Direct non-task MCP writes
  remain governed separately by normal write approval.
- Restore runs only after Fastify has closed its SQLite database.
- The bundle pathname is pinned to its verified byte length and SHA-256 before
  extraction and cutover.
- The final restart is the render and persistence smoke test.

Passing this scenario is meaningful integrated local evidence, but it does not
change the enterprise release decision by itself. Server-mode external
supervisor recovery, signed backup provenance, native installers, and the full
security/deployment matrix remain independent release gates.

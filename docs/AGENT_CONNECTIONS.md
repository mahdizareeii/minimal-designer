# Agent connections

Open `/administration` as an Organization Administrator to inspect agent name,
adapter, connection status, granted scopes, project restrictions, last-used
time, expiration, reconnect, and immediate revoke.

## Connect Codex

In authenticated FormaSpec modes, the website is the connection-authorization
boundary:

1. Choose **Connect Codex** in Administration and approve the requested scopes.
2. FormaSpec creates the connection and a short-lived one-time pairing nonce.
3. The browser opens a bearer-grant-free handler URL with the expected
   connection ID and one-time nonce:

   ```text
   formaspec://connect-agent?connection=<connection-id>&nonce=<pairing-nonce>
   ```

4. If an installed handler does not open, run the exact fallback command shown
   by Administration:

   ```bash
   ./designer --yes agent connect codex \
     --pairing-nonce <pairing-nonce> \
     --connection-id <connection-id>
   ```

The equivalent CLI syntax is:

```text
formaspecctl agent connect codex [--pairing-nonce <nonce>] [--connection-id <id>] [--yes]
```

`--connection-id` is optional, but may be used only with `--pairing-nonce`; the
website supplies both so the bridge can reject a valid nonce that resolves to
an unexpected connection. The CLI accepts exact `fspair_…` and
`connection_…` identifiers only. The nonce contains no bearer grant, but it is
a short-lived authorization credential: do not paste it into tickets, logs, or
chat, and do not reuse it.

The CLI starts or refreshes the owned loopback bridge and passes the pairing
ticket over its private control endpoint. The bridge posts only `{ "nonce":
"…" }` to exact `POST /api/agent-connections/pair`, verifies the optional
expected connection ID, verifies MCP and the returned authorization context,
then stores the upstream scoped grant in the OS credential store. It writes a
credential-free `formaspec` MCP entry, installs and verifies the managed
FormaSpec 0.4.0 plugin, removes the legacy plugin through Codex, and verifies
the final single-identity configuration.

The managed Codex entry uses server-scoped automatic approval for the trusted
local FormaSpec bridge. The installation click or CLI confirmation is the
single consent boundary; subsequent FormaSpec tool calls do not prompt one by
one. `doctor` and `status` confirm the managed entry is credential-free
Streamable HTTP and targets the exact active loopback bridge before reporting
automatic approval. Global Codex approval and sandbox settings are preserved.

Installer-owned standalone legacy skills are deleted only when their
`.formaspec-managed.json` marker proves ownership. Unmanaged files are
preserved and reported as a collision. Start a new Codex task after the upgrade
and use the only supported mention:

```text
[@FormaSpec](plugin://formaspec@formaspec)
```

## Codex/CLI task approval boundary

The website never creates agent tasks. Codex or the CLI creates the immutable
task through MCP after exact Product/Design selection confirmation. The
connected agent claims the task, reads its authorized context, creates and
inspects the exact rendered preview, runs linting, and transitions the task to
`awaiting_approval` with the `previewId`. The agent must not commit the preview
or complete the task. A human uses FormaSpec's before/after review to **Commit**
or **Discard**.

Direct requests create and claim an immutable design-preview task first. The
agent publishes the inspected exact preview and never calls
`design_commit_preview`; a human commits or discards it in FormaSpec.

Only `/api/agent-connections/pair` is available to the headless bridge without
a browser session or trusted identity. Creating a connection, reconnecting it,
and revoking it remain Organization Administrator actions and require the
active browser authentication and CSRF boundary. In session or trusted-header
mode, `formaspecctl agent connect codex` without a website-issued ticket may
reuse an exact still-valid stored grant, but it cannot create or rotate a
connection headlessly. Legacy self-creation remains limited to local
`AUTH_MODE=none` evaluation.

The bridge fails closed when the OS credential store has no scoped grant. It
does not accept a caller-supplied bearer token as a substitute, validates the
literal bound loopback Host, rejects browser-origin/fetch-metadata requests,
and accepts MCP POST bodies only as `application/json`.

The launcher fingerprints the built bridge runtime. A later installer or
source build automatically replaces an older owned bridge process before
authorization, preventing stale security code from remaining resident. On
macOS the grant is written through the system Keychain prompt in a private PTY
and read back for an exact constant-time verification before setup succeeds.

## Reconnect and revoke

Reconnect in Administration stages a new pending replacement connection and
one-time nonce while the existing active grant remains usable. Only successful
pairing atomically activates the replacement and revokes its exact predecessor;
an expired, cancelled, or blocked handler leaves the predecessor untouched.
Immediate revoke still marks the selected connection and all current grants
unusable; authentication requires the owning connection to remain active and
unexpired on every request and event stream. A restore revokes restored grants,
connections, pairing nonces, replacement intents, and browser sessions, so
reconnect from Administration afterward.

When a packaged protocol handler is installed, the Administration flow must
parse the exact `connection`/`nonce` form above, invoke `formaspecctl` without a
shell or bearer token, and open Administration. The macOS, Linux, and Windows
source handlers also accept the explicitly tested queryless local-no-auth and
nonce-only forms; they reject extra, reordered, duplicated, encoded,
credential-bearing, oversized, control-character, and otherwise unsafe input.
They separately accept the secret-free, ordered `open-review` identifiers,
run the fixed `ensure-running` recovery preflight, require an exact data-store
match, and then open only the corresponding persisted-preview review route.
Clean installed protocol lifecycle evidence remains a release blocker.

## Other MCP clients

For unsupported MCP clients, `formaspec-mcp-config` or
`formaspecctl agent config generic` prints bounded, credential-free JSON/TOML
examples and verification steps without inspecting or changing client files.
Pairing and copying the reviewed configuration remain manual for those clients.
Windows current-user DPAPI storage is implemented; packaged Windows lifecycle
verification remains unfinished.

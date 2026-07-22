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
credential-free `formaspec` MCP entry, installs the managed version-0.2.0
FormaSpec and Minimal UI skills/plugins, and verifies Codex configuration.

Canonical installation completes before managed compatibility assets are
refreshed. Older `minimal-ui` content is replaced only when its own
`.formaspec-managed.json` marker proves ownership by `formaspecctl`; unmanaged
legacy content is left untouched. The connector never overwrites an unmanaged
`formaspec` or `minimal-ui` skill/plugin/marketplace. Both current identities
share the one token-free MCP entry and can be mentioned as
`[@FormaSpec](plugin://formaspec@formaspec)` or
`[@Minimal UI](plugin://minimal-ui@formaspec)` after starting a new Codex task.

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

Reconnect in Administration issues a new one-time nonce for that exact
connection and follows the same handler/fallback flow. Immediate revoke marks
the connection and all current grants unusable; authentication requires the
owning connection to remain active and unexpired on every request and event
stream. A restore revokes restored grants, connections, pairing nonces, and
browser sessions, so reconnect from Administration afterward.

When a packaged protocol handler is installed, the Administration flow must
parse the exact `connection`/`nonce` form above, invoke `formaspecctl` without a
shell or bearer token, and open Administration. The macOS, Linux, and Windows
source handlers also accept the explicitly tested queryless local-no-auth and
nonce-only forms; they reject extra, reordered, duplicated, encoded,
credential-bearing, oversized, control-character, and otherwise unsafe input.
Clean installed protocol lifecycle evidence remains a release blocker.

## Other MCP clients

For unsupported MCP clients, `formaspec-mcp-config` or
`formaspecctl agent config generic` prints bounded, credential-free JSON/TOML
examples and verification steps without inspecting or changing client files.
Pairing and copying the reviewed configuration remain manual for those clients.
Windows current-user DPAPI storage is implemented; packaged Windows lifecycle
verification remains unfinished.

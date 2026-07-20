# Agent connections

Open `/administration` to inspect agent name, adapter, connection status,
granted scopes, project restrictions, last-used time, expiration, reconnect,
and immediate revoke.

The supported Codex path is:

```bash
./designer --yes agent connect codex
```

One explicit authorization starts the loopback bridge, creates/consumes a
short-lived pairing challenge, stores the upstream grant in the OS credential
store, writes a credential-free `formaspec` MCP entry, installs the managed
Minimal UI skill/plugin, and verifies Codex configuration.

Re-authorizing the managed Codex adapter atomically replaces older connections
with the same organization, adapter, and managed display name. Their grants and
pairing nonces become unusable before the new challenge is returned. The bridge
serializes concurrent authorization attempts so it cannot retain a losing,
already-revoked token.

The bridge fails closed when the OS credential store has no scoped grant. It
does not accept a caller-supplied bearer token as a substitute, validates the
literal bound loopback Host, rejects browser-origin/fetch-metadata requests,
and accepts MCP POST bodies only as `application/json`.

The launcher fingerprints the built bridge runtime. A later installer or
source build automatically replaces an older owned bridge process before
authorization, preventing stale security code from remaining resident. On
macOS the grant is written through the system Keychain prompt in a private PTY
and read back for an exact constant-time verification before setup succeeds.

The browser can issue a one-time `formaspec://connect-agent` challenge. A
packaged protocol handler is not available yet, so use the CLI command when no
handler opens.

Revocation marks the connection and all current grants unusable immediately;
authentication also requires the owning connection to remain active and
unexpired on every request.
For unsupported MCP clients, `formaspec-mcp-config` prints bounded,
credential-free JSON/TOML examples and verification steps without inspecting
or changing client files. Pairing and copying the reviewed configuration remain
manual for those clients. Windows current-user DPAPI storage is implemented;
packaged Windows lifecycle verification remains unfinished.

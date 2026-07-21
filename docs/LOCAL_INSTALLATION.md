# Local installation

## Supported source modes

The source installer supports macOS, Linux, and WSL2. A native Windows WiX v4
unsigned-MSI builder foundation exists, but no MSI artifact or real Windows
service/ACL/lifecycle evidence exists; use WSL2 or Docker Desktop for source
evaluation unless you are explicitly developing the native packaging path.

Docker mode requires Docker Engine/Desktop and Compose v2:

```bash
./designer --yes install docker
```

Local mode currently requires Node.js 24 and pnpm 11:

```bash
./designer --yes install local
```

A retained unsigned macOS ARM64 engineering checkpoint is stored at
`artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
(SHA-256 `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`,
185,279,180 bytes). Source/license and package-integrity checks pass. A private,
non-installing `pkgutil --expand-full` smoke verifies bundled Node v24.14.0,
Chromium headless shell revision 1228, schema-12 health, real Playwright PNG
rendering, the exact 51-tool/25-resource MCP inventory, and native migration,
backup, log, and support paths without changing system install targets or
receipts for its frozen bytes. Current workspace parity fails because exhaustive
SSE event authorization and project/revision-bound historical-release outputs
were finalized later. The package was not installed. A same-host repeat produced identical
payload/workspace trees but different outer PKG bytes, so it remains **NO-GO**
until Chromium LGPL-notice policy, signing, notarization, independent
reproducibility, vulnerability scanning, and clean privileged lifecycle
evidence pass. The preserved `schema11-current` and earlier `schema10-current`
candidates are historical only. Linux DEB/RPM source builders,
deterministic payload layout, systemd units, lifecycle scripts, and
macOS-runnable unit tests now exist, but no release-qualified Linux artifact or
real Linux lifecycle evidence exists. See
[Native Linux packaging](./LINUX_PACKAGING.md). A native-Windows-only WiX v4
builder also exists, but it requires an externally supplied service host and
caller-supplied provenance whose internal consistency is checked without
establishing a trust anchor; no real WiX compile, Windows artifact, or lifecycle
has been built or qualified. See
[Native Windows packaging](./WINDOWS_PACKAGING.md).

## What installation changes

- dependencies and production artifacts are prepared inside the repository;
- application state stays under `.designer/`;
- source data defaults to `data/`;
- the bridge binds to `127.0.0.1:4312`;
- supported Codex is configured only after explicit authorization;
- the managed MCP entry contains no bearer token;
- the upstream grant is stored in macOS Keychain or Linux Secret Service.

Existing `.designer` state is preserved. The `designer` compatibility wrapper
delegates supported lifecycle commands to `formaspecctl` when built.

Native packages do not write operator state into the installed application
tree. Their `formaspecctl` wrappers provide one strict absolute-path contract:

- macOS data, backups, logs, and support bundles live below
  `~/Library/Application Support/FormaSpec/`; runtime records and the local
  bridge live below its `runtime/` child;
- Linux service data and backups live below `/var/lib/formaspec/`, while the
  invoking user's CLI/bridge records use `$XDG_STATE_HOME/formaspec` or
  `~/.local/state/formaspec`;
- `FORMASPEC_RUNTIME_DIR`, `FORMASPEC_DATA_DIR`, `FORMASPEC_BACKUP_DIR`,
  `FORMASPEC_LOG_DIR`, and `FORMASPEC_SUPPORT_DIR` must be absolute whenever
  explicitly overridden.

Migration status, loopback API commands, and support-bundle collection honor
those paths. Arbitrary bundle restore remains source-workspace-only: a packaged
native runtime fails closed before verification or mutation until a supervised
native stop/safety-backup/cutover/rollback/restart workflow exists.

## Useful commands

```bash
./designer doctor auto
pnpm formaspecctl status
pnpm formaspecctl restart
pnpm formaspecctl backup create
pnpm formaspecctl backup list
```

The unsigned schema-12 macOS payload defines LaunchAgent autostart and the
`formaspec://` protocol, but those installed behaviors have not been exercised.
Static/package inspection and retained-checkpoint non-installing runtime
evidence pass for the frozen bytes; they do not establish current-source parity
or replace privileged install lifecycle evidence. A
real clean install/automatic-start/protocol/upgrade/uninstall/reinstall matrix
has not run, and there is still no supported source uninstall command.

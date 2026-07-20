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

An earlier engineering-only, self-contained unsigned macOS ARM64 PKG exists at
`artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`. It bundles the
exact Node and Chromium headless-shell runtimes, so an installed user would not
need Node.js, pnpm, Playwright, or Chromium. It is **not release-approved** and
does not match the current schema-11 source tree. Do not install or present it
as current; rebuild only after source stabilization, and keep the gate closed
until license, signing/notarization, scan, reproducibility, and clean lifecycle
evidence passes. Linux DEB/RPM source builders,
deterministic payload layout, systemd units, lifecycle scripts, and
macOS-runnable unit tests now exist, but no release-qualified Linux artifact or
real Linux lifecycle evidence exists. See
[Native Linux packaging](./LINUX_PACKAGING.md). A native-Windows-only WiX v4
builder also exists, but it requires an externally supplied real service host
and exact provenance; no Windows artifact has been built or qualified. See
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

## Useful commands

```bash
./designer doctor auto
pnpm formaspecctl status
pnpm formaspecctl restart
pnpm formaspecctl backup create
pnpm formaspecctl backup list
```

The unsigned macOS payload defines LaunchAgent autostart and the `formaspec://`
protocol, and both pass static/package inspection plus a non-installing runtime
smoke. A real clean install/upgrade/uninstall/reinstall matrix has not run, and
there is still no supported source uninstall command.

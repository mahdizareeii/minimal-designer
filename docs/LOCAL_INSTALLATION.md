# Local installation

## Supported source modes

The source installer supports macOS, Linux, and WSL2. Native Windows packaging
is not implemented; use WSL2 or Docker Desktop for source evaluation.

Docker mode requires Docker Engine/Desktop and Compose v2:

```bash
./designer --yes install docker
```

Local mode currently requires Node.js 24 and pnpm 11:

```bash
./designer --yes install local
```

An engineering-only, self-contained unsigned macOS ARM64 PKG now exists at
`artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`. It bundles the
exact Node and Chromium headless-shell runtimes, so an installed user would not
need Node.js, pnpm, Playwright, or Chromium. It is **not release-approved** and
must not be treated as a production installer until its recorded license,
signing/notarization, scan, reproducibility, and clean lifecycle gates pass.
Windows MSI and Linux DEB/RPM packages are not implemented yet.

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

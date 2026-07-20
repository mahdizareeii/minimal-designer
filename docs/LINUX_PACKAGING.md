# Native Linux packaging

## Status

FormaSpec has a source-level, reproducible packaging foundation for unsigned
DEB and RPM artifacts. It is intentionally **not release-approved**. The
builders, deterministic layout, lifecycle scripts, and unit tests exist, but a
real Linux clean-install, upgrade, uninstall, reinstall, renderer-sandbox,
desktop-protocol, backup-preservation, vulnerability, license, and
reproducibility matrix has not run yet.

Do not distribute an artifact produced by these commands until the target
distribution evidence and the repository-wide release gates pass.

## Build commands

Build on the target Linux architecture from a frozen, already installed pnpm
workspace with the pinned Playwright Chromium headless shell present:

```bash
pnpm package:linux:deb
```

```bash
pnpm package:linux:rpm
```

The DEB builder requires Linux and an executable `/usr/bin/dpkg-deb`. The RPM
builder requires Linux and an executable `/usr/bin/rpmbuild`. Both fail closed
on macOS, Windows, unsupported CPU architectures, a non-pinned Node runtime,
missing built workspace output, missing Chromium, unsafe symlinks, leaked
local build paths, or absent package tools.

Supported initial architectures are:

| Node architecture | DEB | RPM |
| --- | --- | --- |
| `x64` | `amd64` | `x86_64` |
| `arm64` | `arm64` | `aarch64` |

Artifacts use explicit unsigned names and adjacent SHA-256 files:

```text
FormaSpec-<version>-linux-<architecture>-unsigned.deb
FormaSpec-<version>-linux-<architecture>-unsigned.deb.sha256
FormaSpec-<version>-linux-<architecture>-unsigned.rpm
FormaSpec-<version>-linux-<architecture>-unsigned.rpm.sha256
```

`SOURCE_DATE_EPOCH` is accepted as a whole Unix timestamp. The default is zero
so staging timestamps and package build metadata do not depend on the build
clock. The payload is normalized to deterministic directory/file permissions,
sorted traversal, and fixed timestamps. DEB ownership is forced to root; the
RPM file manifest uses root ownership and fixed build-host/source-date macros.

## Installed topology

The package includes the already-built TypeScript workspace, pinned Node.js
runtime, exact pinned Chromium headless shell, Node license provenance, and
the Chromium payload's upstream notice files. Installed users do not need
Node.js, pnpm, Playwright, or a system Chromium installation.

This does not make the artifact distribution-agnostic or statically linked.
It still relies on the target distribution's systemd, glibc, desktop helpers,
certificate bundle, and native shared libraries used by the pinned Chromium
binary. The exact target-specific library inventory is an open evidence gate,
not something the source builder guesses or downloads.

| Path | Purpose |
| --- | --- |
| `/opt/formaspec` | Read-only managed application and bundled runtimes |
| `/etc/formaspec/formaspec.env` | Non-secret operational limits; preserved as a package configuration file |
| `/var/lib/formaspec/data` | SQLite and normalized assets |
| `/var/lib/formaspec/backups` | Managed backups |
| `/var/cache/formaspec-renderer` | Renderer-only writable home/cache; no application data or backups |
| `/run/formaspec` | Renderer Unix socket |
| `/usr/bin/formaspecctl` | Packaged control CLI |
| `/usr/bin/designer` | Compatibility lifecycle launcher |

The installer creates a locked, non-root `formaspec` system account with
`/var/lib/formaspec` as its home and no login shell. It refuses to reuse a root
or incompatible account and refuses to overwrite unmanaged FormaSpec paths.
It never generates an application password, bearer token, OAuth secret, or
agent credential.

## Service and desktop behavior

Two system services are installed and enabled:

- `formaspec-renderer.service` runs the renderer as `formaspec`, permits Unix
  sockets only, denies IP networking, and cannot write the API data or backup
  directories;
- `formaspec-api.service` runs as `formaspec`, binds `127.0.0.1:4310`, and is
  allowed only loopback IP traffic plus the renderer Unix socket.

Both use restrictive systemd filesystem, device, privilege, resource, and
process settings. A running systemd system instance is mandatory; package
configuration fails rather than silently leaving an unsupervised process.

Privileged install scripts never open a browser or configure a user account.
The desktop entry advertises the secret-free `formaspec` URL scheme. Its
handler accepts only `formaspec://`, `formaspec://open`, and
`formaspec://connect-agent`; malformed, parameterized, or unknown links are
rejected. The connect link opens the local Administration page so the user can
perform the existing explicit authorization flow. It never places a token in
the URL or invokes a shell-interpolated command.

## Upgrade and uninstall data policy

Package upgrade restarts the services from the new post-install step; the DEB
pre-remove path also stops the old version before replacement. Removal
disables/stops the services and removes only package-owned
application files. `/var/lib/formaspec/data` and
`/var/lib/formaspec/backups` are deliberately not package-owned and are never
deleted by DEB or RPM uninstall scripts, including purge/removal script paths.

Operators must verify an independent backup before manually deleting those
directories or the service account. No automated cleanup command is provided
by this packaging foundation.

## Verification still required on Linux

Before treating either package as usable beyond engineering evaluation, run
and retain evidence for all of the following on every supported distribution
and architecture:

1. clean install, automatic startup, health, real PNG render, and MCP bridge;
2. package upgrade across preserved V1/V2 data and immutable history;
3. uninstall/reinstall with exact `/data` and `/backups` preservation;
4. systemd renderer IP-egress denial and Chromium sandbox operation;
5. desktop launch and strict protocol-handler behavior under a real user
   session;
6. required shared-library inventory for the bundled Node and Chromium
   executables;
7. artifact-specific SBOM, notices/legal review, vulnerability scans, and
   independent byte-for-byte reproducibility;
8. repository backup/restore, security, browser, visual, and performance
   release gates.

The macOS-runnable installer unit tests use injected package-command runners;
they do not claim that `dpkg-deb`, `rpmbuild`, systemd, desktop integration, or
native lifecycle behavior was exercised.

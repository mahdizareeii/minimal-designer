# Retained CI and release evidence

## Status and boundary

The repository contains provider-native GitHub Actions workflows for repeatable
source, browser, Docker, unsigned Linux packaging, and unsigned macOS package
plus privately extracted-runtime checks. Every retained
artifact is deliberately named `NO-GO-*`. Passing these workflows is evidence
for engineering review; it is not production approval and does not close the
release blockers recorded in the enterprise status matrix.

The workflows use read-only repository permissions, immutable reviewed action
commit SHAs, credential-free checkout, per-workflow concurrency cancellation,
bounded job deadlines, frozen pnpm installation, exact Node.js 24.14.0, exact
pnpm 11.9.0, and repository-pinned Playwright 1.61.1 browser runtimes. They consume
no GitHub secrets and do not deploy, install generated packages, sign,
notarize, publish a release, or fabricate service hosts or credentials.

## Workflows

| Workflow | Retained evidence | Scope |
| --- | --- | --- |
| `.github/workflows/source-ci.yml` | `NO-GO-source-sbom-license-*`, `NO-GO-dependency-audit-*` | Frozen install, fail-closed high-severity pnpm advisory audit with retained JSON, workflow contract tests, every package's typecheck/test/build, compatibility launcher, Compose configuration, deterministic CycloneDX/license/checksum evidence, and permissive-license gate |
| `.github/workflows/browser-release-gates.yml` | `NO-GO-browser-*` | Selection alignment on pinned Chromium DPR 1/2 plus Firefox and WebKit DPR 1, editor/prototype behavior, deterministic Chromium visual baselines, 1,000-node performance budgets, and the product-manager-to-MCP-to-backup/restore release scenario |
| `.github/workflows/docker-schema11-smoke.yml` | `NO-GO-docker-schema11-*`, `NO-GO-cross-browser-docker-*`, `NO-GO-offhost-restore-*` | Current schema-16 local contract (the workflow/artifact names are retained for compatibility), external Playwright worker with no fallback, real PNG, deterministic rerender and design persistence after API restart, non-root/read-only/capability/resource/network constraints, local distinct volumes, logs, full disposable cleanup, Firefox/WebKit alignment against the exact image produced by that job, and copied-bundle restore into an independently mounted clean project. Hosted provenance and real remote-host/TLS recovery remain open. |
| `.github/workflows/linux-native-packaging.yml` | `NO-GO-unsigned-linux-foundation-*` | Deterministic unsigned DEB/RPM builds on Ubuntu 24.04 x64, exact toolchain capture, adjacent checksum validation, non-installing metadata inspection, and linkage to exact passing source SBOM/license evidence |
| `.github/workflows/macos-native-packaging.yml` | `NO-GO-unsigned-macos-foundation-*` | Main/manual-only macOS build of the exact unsigned PKG, source/artifact evidence, exact known blocker enforcement, and a private extracted-byte API/renderer/MCP/CLI smoke without package installation, LaunchAgents, Keychain, Codex configuration, or browser opening |

Pushes to `main` and pull requests run the source, browser, and Docker checks.
The relatively expensive Linux and macOS package builds run on `main` and by
explicit manual dispatch. A pull request therefore cannot manufacture or
distribute a native package merely by changing workflow content.

## Local contract verification

The workflow contract tests do not require GitHub or Docker:

```bash
pnpm test:ci-workflows
```

They fail closed on mutable or unreviewed action references, secret
consumption, missing job timeouts, optimistic artifact names, missing gates
including Firefox/WebKit alignment and the exact-built-image Docker browser gate,
removal of the dependency advisory audit, native-package installation,
toolchain drift, an unpinned Playwright base
image, invalid Linux checksums, or license evidence that does not pass the
checked-in policy.

The 8/8 workflow-contract suite also requires the Docker smoke to run an
in-container renderer-egress canary covering DNS resolution, direct TCP, and
non-loopback interface visibility, and to record the fail-closed result in the
summary.

The macOS runtime-smoke unit contract is platform-neutral:

```bash
pnpm test:macos-pkg-runtime-smoke
```

The current contract suite validates frozen historical-package expectations.
A fresh current payload must contain exactly one FormaSpec 0.3.0 identity over
one token-free `formaspec` MCP entry at `http://127.0.0.1:4312/mcp`; this remains
a non-installing contract check, not an installed-package lifecycle result.

After a fresh unsigned PKG is built on macOS, the real smoke runs with explicit
artifact and output paths:

```bash
node scripts/ci-macos-pkg-runtime-smoke.mjs --pkg <unsigned.pkg> --output <new-evidence-directory>
```

For the retained historical package, it validates exact Node, Chromium, schema
13, the 52-tool MCP inventory
including `design_system_component_insert_preview`, resource names, rendering,
backup, migration, and support-path contracts. It writes a checksum-bound,
deterministically ordered `NO-GO-SUMMARY.json`, terminates extracted process
groups, removes private temporary state, and proves known system installation
targets and the package receipt did not change. It does not prove privileged
install/upgrade/uninstall behavior or process-level renderer egress denial.

The historical schema-13 source checkpoint passed 678/678 application tests, launcher
212/212, and typecheck/build for all seven workspaces. Direct protected-route
authorization is 108/108 with zero uncovered; the MCP inventory is 52 tools and
25 resources. Installed/link verification confirms `drizzle-orm` 0.45.2;
application 678/678, launcher 212/212, all seven typechecks/builds, Docker/
egress, Firefox/WebKit, recovery, and exact SBOM/license gates pass against it.
Audit currently reports zero high/critical findings; remaining advisories are
under remediation. Chrome editor/admin/component insertion 4/4, selection
12/12, handoff 1/1, visual 7/7, revision inspect 1/1, the 20-step release
scenario 1/1, and the 1,000-node budget 1/1 passed immediately before the
dependency update. Current schema-16 equivalents have since passed locally;
the schema-13 SBOM/license result remains historical.

Current schema-16 local source verification passes the seven-package suite
842/842 (core 59, server 467, web 91, CLI 96, local bridge 20, Workspace Bridge
37, and installer 72), launcher 225/225, all workspace typechecks/builds,
editor/Administration 5/5, release E2E 1/1, preview integration 2/2, Chromium
alignment 12/12, Firefox/WebKit alignment 12/12, visual regression 7/7, the
1,000-node release budgets, and macOS runtime-smoke contracts 11/11. Image
`sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1`
also passes deterministic restart rendering, renderer-egress denial, exact-
image Firefox/WebKit, and copied-bundle recovery. The retained summaries are
`artifacts/ci/docker-schema11/summary.json` (SHA-256
`9096961bce57ccb8976e3c06ea8d4c501c58cc238d7cbea81864550cbbe29860`),
`artifacts/ci/cross-browser-docker/summary.json` (SHA-256
`f3bf8212ae79f1058ee3caf7c746c7bc0676c6d9d951bf3b50d1449ec68a1adf`),
and `artifacts/ci/offhost-restore-simulation/NO-GO-SUMMARY.json` (SHA-256
`fe43f516c063703a620688fe04736a946b45d42f77f615fe57b175d27ee509f4`).
These local uncommitted-source results are not one hosted release-candidate
run and do not replace current SBOM/security/image/OS scans, signed native
lifecycle evidence, or real remote-host/TLS recovery.

The Docker smoke can be run separately on a disposable local Docker daemon:

```bash
pnpm ci:docker-schema11-smoke
```

It creates a randomized Compose project and loopback port, writes bounded
evidence under `artifacts/ci/docker-schema11`, and removes all project
containers and volumes in its cleanup path. It never points at existing FormaSpec
volumes or production configuration.

After that build, run the exact image through Firefox and WebKit:

```bash
pnpm ci:cross-browser-docker-smoke
```

The workflow contracts require this command, its fixed `formaspec/server:local`
image binding, and its separate retained `NO-GO-cross-browser-docker-*`
artifact. The disposable test runner uses no network, a read-only root,
non-root `pwuser`, dropped capabilities, and no-new-privileges. Firefox needs a
runner-only `seccomp=unconfined` exception to create its own namespace; the
production API and renderer services do not use that exception.

To exercise copied-bundle recovery into an independent clean project using the
same prebuilt image:

```bash
pnpm ci:offhost-restore-smoke
```

The command rejects Docker endpoint/context/config/TLS environment overrides,
accepts only a verified local Unix socket or Windows named pipe, never builds
or pulls, and requires exact image IDs plus non-root runtime UIDs for every
service/helper container. It is intentionally a same-machine simulation and
always writes `releaseStatus: NO-GO`.

## Historical local schema-13 checkpoint (`NO-GO`)

Disposable Compose project `formaspeccischema1369037dfc8a` used image
`sha256:55601784007855ffac507b20c8025d64d9ca5f572eb9a2834a0fb239a30378a0`,
reached schema 13, created design
`document_c304f0d8e19d449fa450b335e79c182e` at revision
`revision_b71067ccd8e548b1b5385c366dabb263`, and produced the same 512×339
PNG SHA-256 `cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`
before and after API restart. The egress canary returned DNS `EAI_AGAIN`, TCP
`ENETUNREACH`, and zero external interfaces; cleanup passed. Summary:
`/private/tmp/formaspec-docker-schema13-drizzle0452-20260721-current/summary.json`,
SHA-256 `8e0d3baa22b934f90d7e6f36022365a825f5b6457ca6bb6e51f993a1fb59caed`.

The same image passed Firefox/WebKit alignment 12/12 with complete cleanup.
Summary SHA-256:
`a4c16b03a094abba6abd2144c9ed0af78684897c97956c77789526f57eb6f41c`.

Same-image copied-bundle recovery ran from `formaspecdrsource8878ef1a23` to
`formaspecdrtarget8878ef1a23`, preserving design
`document_34da61e488444c48b144646e778f7edc` at revision
`revision_5da62614cff8498db21be8d9346eb34a`. Bundle SHA-256 was
`3fcba430b476f1dc2ce943405af418a1b1fdc629876f1e8407b8cf5b725c2fef`;
snapshot, revision, asset, render, SQLite integrity, and foreign-key
comparisons all passed and cleanup was complete. The `NO-GO` summary SHA-256
is `198f93aace5caf60f550e95436711b10107433acc7d85b9175fce8d4722dcc6d`.

Exact linked-0.45.2 source SBOM/license evidence reports 342 components and
zero policy violations. Its directory is
`/private/tmp/formaspec-release-evidence-schema13-drizzle0452-20260721-current`;
SHA-256 values are `82794fb6d820633ba4687126f3668ab21f045c6ceb73cd7761d3abd48b204bf8`
for `SHA256SUMS`, `2519a41a66f84120ed8db9d48c4ee6706d40faf7a279bca79fb74120c81aaf9a`
for `formaspec.cdx.json`, and
`d296b7340521a7f7854dc13fbf4b9e245d79e23ca7169da4146babb23eca52b0`
for `licenses.json`.

All schema-13 results are temporary local `NO-GO` evidence, not retained hosted
artifacts, provenance, scanning, or an independently reproducible candidate.

## Historical schema-12 local checkpoint

The prior disposable local run on 2026-07-21 passed from source identity
`local-uncommitted-final437-eventauth-sqlbounded-cli` as Compose
project `formaspeccischema118e2818fed6`. It reached schema 12 readiness,
created design `document_0e6b4b61e3964110b9a4533ef2a63398` at revision
`revision_aea2807b70cb4c8c9b6588c191de0218`, preserved the design through an
API-only restart, and produced the same 512×339 PNG SHA-256
`cacf72adda9b70d6c7e732676da6c2be2575d7b456abffb35d04f749cfe7bdcf`
before and after restart. API and renderer used identical image
`sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`,
ran non-root with read-only roots, dropped capabilities, no-new-privileges, and
bounded PID/memory/CPU resources; the renderer used `network_mode: none`,
mounted only `/run/formaspec`, and failed the egress canary closed with DNS
`EAI_AGAIN`, TCP `ENETUNREACH`, and zero external interfaces. Cleanup removed every temporary container and
volume. The summary is
`/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json`
(SHA-256 `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`).
Because the summary is in temporary local storage, this is historical local
schema-12 evidence, not retained CI, provenance, vulnerability scanning, or
independent reproducibility.

That schema-12 reviewed image then passed Firefox/WebKit 12/12 once. Its summary is
`/private/tmp/formaspec-cross-browser-docker-20260721-final437-eventauth-sqlbounded-cli/summary.json`
(SHA-256 `2b723c3ddac0404bea7a1124559945ec78f69a6a6ced48923f9d170456c71b9b`).
The immediately prior fit-sync image passed three consecutive 12/12 runs after
initial canvas fitting moved synchronously into `useLayoutEffect`, fixing the
WebKit initial-fit race. Its main summary is
`/private/tmp/formaspec-cross-browser-docker-20260721-final430-auth106-supervision-egress-fit-sync-runtime/summary.json`;
the sibling `-repeat2` and `-repeat3` directories contain byte-identical
summaries, all hashing to
`0b28b9a0f78ec5687496cd61a7b930fa00d0f276c5dfbb0c0901ce7410a9938b`.
Together these are historical schema-12 pass and repeated-flake evidence, not
retained GitHub-hosted or cross-OS runs.

The same image also passed a hardened same-machine copied-bundle recovery
simulation. A verified bundle moved from source project
`formaspecdrsourcede20d670cd` into an independently mounted clean target
`formaspecdrtargetde20d670cd`; SQLite integrity/foreign keys, snapshot and
revision hashes, normalized asset bytes/metadata, and the deterministic PNG all
matched. The script rejected Docker control overrides, verified the local Unix
socket context, proved non-root runtime UIDs for both services and all seven
one-shot helpers, and removed all containers, volumes, networks, and transfer
directories. The checksum-bound `NO-GO` summary is
`/private/tmp/formaspec-offhost-restore-20260721-final437-eventauth-sqlbounded-cli/NO-GO-SUMMARY.json`
(SHA-256 `2a7bf59d47579f4c5f6f20bf779976e9dd4a6260b6670e73f245753ef3abbdc9`).
The transferred bundle SHA-256 was
`f12887796030081d495ef3b266abf7b22f58cdb01fbe494072171e57ce73bfcc`;
the recovered design was `document_9989d40c2c194b5dafb7f7da08bfc4b9` at
revision `revision_3b6cbf1a84f5421b9f57c370d4541db2`.
It explicitly does not prove a real remote host, network transfer, TLS, object
storage, remote credentials, or production recovery objectives.

The historical schema-13 Docker result and this historical schema-12 result are
independent of native installer evidence. The
retained pre-current-SSE-authorization unsigned PKG under
`artifacts/candidates/schema12-current/` has passing frozen package-integrity
and extracted-runtime evidence, but current-source verification records expected
drift; it was not installed and remains `NO-GO`. Its SHA-256 is
`9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`.
The extracted-runtime summary hashes to
`c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`.
The same-host repeat retained identical payload/workspace trees but different
outer PKG bytes; its negative diagnostic summary hashes to
`570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`.
Reproducibility therefore remains explicitly unproven. Chromium LGPL-notice
approval, signing, notarization, artifact/native/OS vulnerability scanning,
and clean native lifecycle evidence also remain open. The preserved
`schema11-current` package is historical pre-final-patch evidence only.

## Evidence interpretation

GitHub artifact retention is 14 days for browser diagnostics and 30 days for
source, Docker, Linux, and macOS evidence. A release owner must archive the exact
workflow run URL, source commit, workflow files, checks, and retained artifact
digests in the release record. GitHub-hosted runner logs are not a provenance
signature or an independent reproducibility result.

The Linux manifest remains `NO-GO` even when both builders pass. It does not
prove clean installation, upgrade, rollback, repair, uninstall/reinstall,
systemd supervision, protocol registration, data preservation, native
Chromium sandboxing, renderer egress denial, distribution compatibility,
artifact-specific vulnerability status, independent reproducibility, legal
approval, provenance, or signing.

Windows remains source scaffolding only. No workflow claims a real MSI because
the repository still lacks a qualified Windows service host and native Windows
lifecycle evidence. macOS signing and notarization likewise remain external,
credential-gated blockers and are intentionally absent from these workflows.

# Unsigned macOS PKG evidence

Last audited: 2026-07-22

Release decision: **NO-GO**

Current-workspace parity: **FAIL for the retained schema-12 checkpoint**

The retained engineering checkpoint under
`artifacts/candidates/schema12-current/` preserves passing package-integrity,
workspace-tree, and extracted-runtime evidence for its frozen bytes. Its
extracted API and renderer reached schema 12, rendered a real Playwright PNG,
exposed the checkpoint's MCP inventory, and honored private native CLI state
paths without installing the package. The current workspace has since added
exhaustive SSE event authorization and project/revision-bound historical-release
REST and MCP outputs, so a new package is required before parity can be claimed.
The checkpoint remains unsigned and was not installed. The preserved
`schema11-current` and `schema10-current` candidates are historical evidence
only. Do not install any PKG without separate explicit operator approval
immediately beforehand. The release decision remains **NO-GO**.

FormaSpec can produce and inspect an unsigned macOS PKG without a network
scanner, Apple account, signing identity, notarization credential, or external
SaaS. This is artifact-integrity and inventory evidence. It does not authorize
distribution.

## Build and verify

Run on macOS after a frozen workspace install and production build:

```bash
pnpm package:macos:unsigned
pnpm release:evidence:generate
pnpm release:evidence:check
pnpm test:macos-pkg-evidence
pnpm test:macos-pkg-runtime-smoke
pnpm release:evidence:macos:generate
pnpm release:evidence:macos:verify
pnpm release:evidence:macos:gate
```

`generate` always retains the evidence when the artifact is structurally valid.
`verify` recalculates the package evidence and passes only when the checked
files are current. `gate` additionally fails while any release blocker remains.
The provider-neutral `pnpm ci:macos-pkg-evidence` entry point runs the same
sequence against an already-built PKG.

For a fresh package built from a frozen current source tree, run the separate non-installing extracted
runtime smoke with explicit paths:

```bash
pnpm ci:macos-pkg-runtime-smoke --pkg <unsigned.pkg> --output <new-evidence-directory>
```

The smoke invokes only `pkgutil` inspection/private expansion and the extracted
Node runtime. It starts the extracted API, renderer, and CLI against private
runtime/data/backup/log/support directories; verifies schema 12, a real
Playwright PNG, the exact 51-tool and 25-resource MCP inventories, migration,
backup, and support-bundle path behavior; then terminates process groups and
removes the private tree. It never invokes package installation, LaunchAgents,
Keychain, Codex, protocol handlers, or a browser opener. This is stronger
packaged-byte evidence, not privileged lifecycle or renderer-egress proof.

The main/manual-only `.github/workflows/macos-native-packaging.yml` performs the
build, source evidence, package evidence, exact expected blocker check, and
runtime smoke, then retains everything under an explicitly `NO-GO-*` artifact.
No hosted run has been retained yet.

The tools remain offline. They read the PKG, its canonical `.sha256` sidecar,
the checked-in license policy, and the passing source-workspace SBOM/license
evidence. They invoke only local macOS tools: `pkgutil`, `lsbom`, `plutil`, and
`file`.

## Generated files

Evidence is normally written below
`artifacts/release-evidence/macos-pkg/<artifact-name>/`. The retained schema-12
checkpoint evidence is stored below
`artifacts/candidates/schema12-current/release-evidence/`; historical
schema-11 and schema-10 evidence remains below the corresponding candidate
directories. Historical schema-10 package evidence is retained below
`artifacts/candidates/schema10-current/release-evidence/macos-pkg/<artifact-name>/`:

| File | Contents |
| --- | --- |
| `artifact.cdx.json` | CycloneDX 1.6 artifact SBOM linking the PKG hash to the exact source SBOM and the components actually present in the payload |
| `components.json` | Deduplicated npm/workspace manifest inventory, instance paths/hashes, source linkage results, excluded build-only workspaces, exact packaged workspace-tree entries/hashes, and bundled runtime components |
| `verification.json` | Artifact/signature/package metadata, BOM and payload-tree hashes/counts, exact workspace-tree comparison summaries, scripts, required key files, source-evidence hashes, performed checks, limitations, and blockers |
| `SHA256SUMS` | Deterministic SHA-256 checksums for all three JSON evidence files |

The retained checkpoint also has a root
`artifacts/candidates/schema12-current/SHA256SUMS` manifest covering 14 retained
files: the checkpoint README, package and sidecar, and all source, package,
runtime-smoke, and reproducibility evidence. It passes 14/14 with
`shasum -a 256 -c SHA256SUMS` from the candidate directory.

No checkout path, username, hostname, timestamp, random identifier, credential,
or raw signing output is recorded.

## Integrity checks

The verifier performs all of the following before reporting integrity `pass`:

- hashes the exact PKG through one no-follow descriptor and verifies the
  canonical sidecar;
- confirms `pkgutil` reports the artifact as unsigned;
- expands the flat package into a private temporary directory;
- validates the component identifier, version, install location, root
  authorization, application bundle identity, immutable install manifest, and
  pre/post-install scripts;
- requires exact agreement between the installer BOM and extracted content
  paths, and rejects traversal, unsupported entries, absolute/escaping
  symlinks, unreceipted payload files, or missing receipt files;
- computes a deterministic content/mode/symlink-aware payload-tree hash and
  records any AppleDouble metadata;
- hashes required launch agents, wrappers, application/server/renderer/CLI/
  bridge/core entry points, the bundled Node executable, and installer scripts;
- inventories direct package roots in the bundled pnpm virtual store and every
  packaged workspace manifest;
- links every third-party purl and exact package-manifest hash to the passing
  source CycloneDX SBOM, rejecting missing, unknown, or changed components;
- compares every relative path, entry type, size, and content hash in the
  packaged core/server/web/CLI/local-bridge/Workspace-Bridge `dist/` trees and
  managed CLI assets against the current workspace outputs, then rescans the
  source trees to reject concurrent or stale builds;
- inventories the exact bundled Node runtime and pinned Chromium headless-shell
  revision with executable and local license-evidence hashes, while rejecting
  FFmpeg, Chrome for Testing, Firefox, WebKit, or any other browser payload.

## Why the release gate remains closed

An integrity pass proves what bytes are in this particular artifact. It does
not prove publisher identity, safety, legal approval, or repeatability. The
gate remains closed until all recorded blockers are resolved, including:

- a real Developer ID Installer signature and Apple notarization/stapling
  evidence;
- an independent reproducible-build comparison;
- retained dependency, native-binary, Chromium, and operating-system
  vulnerability scan results;
- legal and policy review of Chromium headless shell's composite third-party
  license bundle, including its LGPL notices;
- clean-install, automatic-startup, protocol-handler, upgrade, uninstall, and
  reinstall tests on supported macOS versions.

The same-host repeat build is also explicitly negative evidence: the payload
tree and all seven workspace trees were identical, but the outer PKG bytes and
size differed. Reproducibility is therefore not achieved and must not be
inferred from deterministic inner-tree hashes.

No credential or provenance is fabricated. If signing or scanning inputs are
unavailable, the unsigned artifact and deterministic evidence may be retained
for engineering review, but release remains **NO-GO**.

## Retained schema-12 unsigned engineering checkpoint

The retained checkpoint is:

- Artifact: `artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
- SHA-256: `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`
- Size: 185,279,180 bytes
- Signature: unsigned
- Installation performed: no
- Source SBOM/license policy: `PASS`, 342 third-party components and zero
  policy violations
- Package integrity: `PASS`, 349 npm/workspace components, seven exact
  workspace trees, and two bundled runtimes
- Payload-tree SHA-256:
  `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`
- Workspace-tree SHA-256:
  `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`
- Extracted-runtime smoke: `PASS`; checksum-bound summary SHA-256
  `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`
- Same-host reproducibility diagnostic: `FAILED`; checksum-bound summary
  SHA-256 `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`
- Release decision: `NO-GO`

The extracted-runtime smoke privately expands the package with
`pkgutil --expand-full`, verifies bundled Node v24.14.0 and Chromium headless
shell revision 1228, starts the extracted API and renderer at schema 12,
renders a 512×339 PNG through Playwright, checks the exact MCP inventory, and
exercises packaged CLI migration, backup, log, and support-directory
resolution. It terminates all process groups, removes temporary state, and
records that system install targets and package receipts were unchanged. It
does not prove LaunchAgent ownership or startup, protocol registration,
install/upgrade/uninstall/reinstall behavior, native service isolation, or
process-level renderer egress denial.

The repeat-build artifact had SHA-256
`2c49f45a6840218b995cc969576f4209d0c94802a160c679ad02483ed5ba4dd0`
and size 185,279,075 bytes. Its payload-tree and workspace-tree hashes matched
the final candidate exactly, but its outer bytes did not. The release gate
therefore remains closed on exactly these package-level blockers:

1. `CHROMIUM_RUNTIME_CONTAINS_LGPL_NOTICES`.
2. `PACKAGE_UNSIGNED`.
3. `NOTARIZATION_EVIDENCE_MISSING`.
4. `REPRODUCIBILITY_EVIDENCE_MISSING`.
5. `VULNERABILITY_SCAN_MISSING`.

## Retained pre-final-patch schema-11 checkpoint

The retained checkpoint is:

- Artifact: `artifacts/candidates/schema11-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
- Historical checkpoint SHA-256: `3aad0cd887a7ce83e59cd85e0527500083e71eb31e9340d96dec2eca958017c2`
- Historical checkpoint size: 176.3 MiB
- Checkpoint artifact integrity: `PASS` at the pre-final-patch checkpoint only
- Current-workspace parity: `FAIL`
- Current gate: `FAIL` — packaged `packages/core/dist` differs from the current
  workspace
- Release decision: `NO-GO`
- Checkpoint inventory: 349 packaged npm/workspace components, seven workspace
  trees, and two bundled runtimes
- Installation performed: no

At that checkpoint, the five recorded release blockers were Chromium
LGPL-notice policy, missing signature, missing notarization, missing independent
reproducibility, and missing vulnerability scanning. Current workspace parity is
an additional prerequisite before any new artifact can be evaluated. These
checkpoint bytes must not be presented as a current-source candidate.

## Separate historical Docker evidence

Native PKG evidence and Docker evidence are independent. The historical
Compose project `formaspeccischema118e2818fed6` passed the schema-12 Docker
smoke with both services using image
`sha256:39667c3304d926288ef9d73c59eee85164c435d46cf362b18ef1b22f0331fd7f`.
The temporary summary is
`/private/tmp/formaspec-docker-schema12-smoke-20260721-final437-eventauth-sqlbounded-cli/summary.json`
(SHA-256 `efc87b99e30320b8af75c479eee709addbc0fd5f6afd33e82751b89acecfe24a`).
That smoke includes the passing DNS/TCP/interface renderer-egress canary. It
does not validate native installation behavior, and its temporary local evidence
is not signing, notarization, vulnerability-scan, reproducibility, or retained
provenance evidence.

## Historical schema-10 checkpoint

The previous detailed checkpoint candidate is retained for comparison only:

- Artifact: `artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
- SHA-256: `15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`
- Size: 184,835,514 bytes
- Payload entries: 20,349
- Regular files: 16,901
- Directories: 2,561
- Contained symlinks: 887
- AppleDouble/`.DS_Store` entries: 0
- Logical payload bytes: 553,503,427
- Payload-tree SHA-256:
  `cdcd8c70e80ca4140dccdf2b5a5a1e6624426292d8ed0cf3a136de0aaf52108f`

Exact workspace-output linkage also passed:

- Evidence schema: 2.
- Trees compared: 7 — core, server, web, CLI, local bridge, and Workspace
  Bridge `dist/` trees plus the managed CLI assets.
- Entries compared: 429, including 408 regular files, 21 directories, and no
  symlinks.
- Logical bytes compared: 13,095,705.
- Combined workspace-tree SHA-256:
  `4f380a609426526562cab60560ede54290de93e9434fdcb0445752bbf56b3785`.
- Missing, extra, type-mismatched, or content-mismatched entries: 0.

This additional gate detects stale compiled output even when package manifests
and selected entry points still match. Focused fixtures cover missing, extra,
tampered, and stale trees, including the previously observed missing
`renderer-endpoint` output and stale server hashes.

Source linkage passed for all packaged JavaScript components:

- 349 packaged npm/workspace components matched the source evidence.
- All 342 source third-party packages are present.
- Missing packages: 0.
- Unknown packages: 0.
- Manifest mismatches: 0.
- The build-only `@formaspec/installer` workspace is explicitly excluded.
- Source SBOM SHA-256:
  `7a7b1a2415a9705e43224a567792a5b4a747a3b2939b5ad0bda052450d9fd76e`.
- Source license-evidence SHA-256:
  `da2e68f66ca32d25e2d613a9441872c64b010a49a449ce8693823619c5aaafdf`.

The bundled runtimes are Node.js v24.14.0 and the Chromium headless shell at
Playwright revision 1228. FFmpeg is not packaged. Node's local license policy
passes with:

- License SHA-256:
  `4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18`.
- Provenance SHA-256:
  `4387053c4d8a5b48b29f575c210b3245c33a0683672111daf633316899698199`.
- Official source-archive SHA-256:
  `9fe025ef4028aba95d16e7810518bf4a5e8abfb0bdc07d8a3fdbb0afd538d77f`.

Evidence is retained at
`artifacts/candidates/schema10-current/release-evidence/macos-pkg/FormaSpec-0.2.0-macos-arm64-unsigned/`.
Its deterministic evidence-file hashes are:

- `artifact.cdx.json`:
  `1704645739ea50c8e254bfc049941e81f0a09ef32d874a590ea4115544635941`.
- `components.json`:
  `a20013bf6317e837f3bd8544974c5fcab064c9f24171f955ab8c55795d71e16a`.
- `verification.json`:
  `91385637b700e405db45ffe626af6c0f95ef3d79bcc3a316da96176f845be0a1`.

All 12 focused evidence tests pass, and both evidence generation and exact
verification pass. The release gate intentionally fails on exactly these five
blockers:

1. `CHROMIUM_RUNTIME_CONTAINS_LGPL_NOTICES` — the Chromium composite notice
   hash is
   `ea614f3494514366b3ee83db6e3e6ded39e0060c9ff3fb283ffb9a2f60ce59c5`.
2. `PACKAGE_UNSIGNED`.
3. `NOTARIZATION_EVIDENCE_MISSING`.
4. `REPRODUCIBILITY_EVIDENCE_MISSING`.
5. `VULNERABILITY_SCAN_MISSING`.

This is a verified engineering artifact, not a release approval. The final
decision remains **NO-GO**.

## Historical non-installing packaged-runtime smoke

The previous integrity-verified PKG was exercised without installation before
the final source rebuild. Its bundled Node v24.14.0 runtime started the packaged renderer against only
`chromium_headless_shell-1228`, then started the packaged API on a temporary
loopback port and private data directories.

These verified historical results belong only to artifact SHA-256
`90a5cee6d4ec28f4465feb78b6790a8552ad60c93b352652f8d6d95d2c77cb22`:

- `/health/live`, `/health/ready`, and `/health/render` returned HTTP 200;
- readiness reported schema 8 and the remote worker contract with
  renderer `2`, raster normalizer `1`, IPC `2`, no fallback, and matched
  5,242,880-byte / 32,000,000-pixel limits;
- render health reported Playwright worker mode with no warnings;
- a real 1100×720 PNG fixture was fully decoded and normalized by the packaged
  worker to a deterministic 83,398-byte content-addressed PNG;
- MCP `initialize` returned server ID `formaspec`, version `0.2.0`, the Minimal
  UI alias workflow, and protocol `2025-06-18`; `tools/list` returned 42 tools,
  and `context_get` plus `design_create` completed against a new V1 project;
- `design_render` returned a 408×512 PNG through the packaged Playwright
  renderer;
- the packaged CLI emitted token-free generic Streamable HTTP configuration
  for a temporary loopback bridge on port 4399;
- API and renderer processes stopped cleanly and removed the temporary socket.

The historical PKG was not installed and no administrator credential was
requested. This smoke evidence belongs only to the historical `15d3104a…`
candidate. The retained pre-final-patch schema-11 `3aad0cd8…` checkpoint also
was not installed and now fails current-workspace parity at
`packages/core/dist`; native install lifecycle evidence remains required. The
decision remains **NO-GO**.

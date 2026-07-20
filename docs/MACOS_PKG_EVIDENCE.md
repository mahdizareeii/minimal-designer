# Unsigned macOS PKG evidence

Last verified: 2026-07-20

Release decision: **NO-GO**

Current-workspace parity: **STALE — schema-10 checkpoint only**

The candidate below was rebuilt from the schema-10 workspace after the
portable-import, product-specification persistence, revision-inspect, launcher,
and Docker hardening changes. Exact workspace equality and artifact integrity
passed for that checkpoint. Migration 11 and later source changes mean it no
longer matches the current workspace. Do not install or present it as current;
do not install any replacement as part of verification without separate
explicit operator approval immediately beforehand. The release decision remains
NO-GO.

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
pnpm release:evidence:macos:generate
pnpm release:evidence:macos:verify
pnpm release:evidence:macos:gate
```

`generate` always retains the evidence when the artifact is structurally valid.
`verify` recalculates the package evidence and passes only when the checked
files are current. `gate` additionally fails while any release blocker remains.
The provider-neutral `pnpm ci:macos-pkg-evidence` entry point runs the same
sequence against an already-built PKG.

The tools remain offline. They read the PKG, its canonical `.sha256` sidecar,
the checked-in license policy, and the passing source-workspace SBOM/license
evidence. They invoke only local macOS tools: `pkgutil`, `lsbom`, `plutil`, and
`file`.

## Generated files

Evidence is normally written below
`artifacts/release-evidence/macos-pkg/<artifact-name>/`. The current isolated
candidate evidence is retained below
`artifacts/candidates/schema10-current/release-evidence/macos-pkg/<artifact-name>/`:

| File | Contents |
| --- | --- |
| `artifact.cdx.json` | CycloneDX 1.6 artifact SBOM linking the PKG hash to the exact source SBOM and the components actually present in the payload |
| `components.json` | Deduplicated npm/workspace manifest inventory, instance paths/hashes, source linkage results, excluded build-only workspaces, exact packaged workspace-tree entries/hashes, and bundled runtime components |
| `verification.json` | Artifact/signature/package metadata, BOM and payload-tree hashes/counts, exact workspace-tree comparison summaries, scripts, required key files, source-evidence hashes, performed checks, limitations, and blockers |
| `SHA256SUMS` | Deterministic SHA-256 checksums for all three JSON evidence files |

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

No credential or provenance is fabricated. If signing or scanning inputs are
unavailable, the unsigned artifact and deterministic evidence may be retained
for engineering review, but release remains **NO-GO**.

## Current verified result

The locally verified current-workspace candidate is:

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
requested. This smoke evidence is retained rather than rewritten as evidence
for the current `15d3104a…` candidate. A current-artifact runtime rerun and native
install lifecycle remain required, and the five release blockers are unchanged;
the decision remains **NO-GO**.

# FormaSpec schema-12 unsigned macOS checkpoint

Release decision: **NO-GO**

This directory contains a retained unsigned macOS ARM64 engineering checkpoint
built before the exhaustive SSE authorization and current project/revision
historical-release interfaces were finalized. It must not be described as a
current-source package. It is separate from and does not replace the preserved
`schema11-current` checkpoint.

The checkpoint's original package-integrity, extracted-runtime, and
reproducibility evidence below remains valid for its frozen bytes. Current
workspace verification reports expected server-output drift across exhaustive
event authorization and the project/revision-bound historical-release REST and
MCP surfaces. A new package must be built from a frozen current workspace before
parity can be claimed; this drift does not invalidate the retained checkpoint's
original artifact hashes.

## Exact artifact

- File: `installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
- SHA-256: `9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`
- Size: 185,279,180 bytes
- Signature: unsigned
- Installation performed: no

## Verified evidence

- Source SBOM/license policy: **PASS**, 342 installed third-party components,
  zero policy violations.
- Package integrity: **PASS**, 349 npm/workspace components, seven exact
  workspace trees, two bundled runtimes, and no workspace-output drift.
- Payload tree SHA-256:
  `375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`.
- Workspace-tree SHA-256:
  `5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`.
- Non-installing extracted runtime smoke: **PASS**, checksum-bound summary
  SHA-256 `c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`.
  It verifies Node v24.14.0, Chromium headless shell revision 1228, schema 12
  health, real Playwright PNG rendering, exact 51-tool/25-resource MCP
  inventory, and packaged CLI migration/backup/support paths using private
  native state. System install targets and package receipts remained unchanged.
- Same-host repeat-build diagnostic: **FAILED reproducibility**. The installed
  payload and workspace trees were identical, but the outer PKG bytes differed.
  The checksum-bound diagnostic summary SHA-256 is
  `570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`.
- Root `SHA256SUMS` binds this README, the package and adjacent sidecar, and all
  retained source/package/runtime/reproducibility evidence in this checkpoint.
  From this directory, verify it with `shasum -a 256 -c SHA256SUMS`.

## Release blockers

The release gate intentionally remains closed on exactly these package-level
blockers:

1. Chromium composite LGPL notices are not policy-approved.
2. The package has no Developer ID Installer signature.
3. Apple notarization/stapling evidence is absent.
4. Independent byte-for-byte reproducibility is absent; even the same-host
   diagnostic produced different outer PKG bytes.
5. Dependency/native-binary/Chromium/OS vulnerability scan evidence is absent.

Clean install, automatic startup, protocol registration, upgrade, uninstall,
and reinstall were not exercised. The extracted-byte smoke is deliberately not
a substitute for privileged native lifecycle testing or process-level renderer
egress isolation.

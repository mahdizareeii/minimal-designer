# Licensing and JavaScript supply-chain evidence

FormaSpec permits only dependencies suitable for free company production use
under the checked-in permissive policy. The reviewed set currently includes
MIT, ISC, Apache-2.0, BSD, BlueOak, OFL, CC0, CC-BY attribution data, Unlicense,
WTFPL, and Zlib identifiers. Copyleft and source-available families such as
GPL, LGPL, AGPL, SSPL, BUSL, and Elastic are rejected. An unknown license also
fails closed until the policy is explicitly reviewed and changed.

The authoritative policy is `release/license-policy.json`. It has no
package-specific bypasses. Bundled Inter and Vazirmatn fonts are OFL-1.1, and
the Lucide icon dependency is ISC. `tldraw` remains intentionally absent
because its production SDK requires separate licensing.

## Deterministic evidence

After a frozen pnpm installation, generate the source-workspace evidence:

```bash
pnpm test:release-evidence
pnpm release:evidence:generate
pnpm release:evidence:check
```

Or run the provider-neutral CI entry point:

```bash
pnpm ci:release-evidence
```

Generation and checking use only local `package.json` files,
`pnpm-lock.yaml`, pnpm's installed dependency graph, and installed package
license/notice files. The evidence process sets pnpm offline and does not call
a registry, vulnerability service, license SaaS, or any other network API.
CI must run `pnpm install --frozen-lockfile` beforehand; a stale installation
is rejected by exact comparison with `node_modules/.pnpm/lock.yaml`.

The generated, intentionally untracked `artifacts/release-evidence/` directory
contains:

| File | Contents |
| --- | --- |
| `formaspec.cdx.json` | Deterministic CycloneDX 1.6 source-workspace SBOM with purls, dependency edges, lockfile integrity hashes, scopes, and policy status |
| `licenses.json` | Sorted package/version/license inventory, manifest hashes, hashed license/notice evidence, inputs, policy decision, and violations |
| `SHA256SUMS` | SHA-256 checksums for the two JSON evidence files |

No timestamp, checkout path, random serial number, username, or machine name is
written. Repeated generation from the same target, lockfile, manifests,
installed package evidence, and policy is byte-identical. `check` recalculates
all three files and fails on drift, missing evidence, symlinks, an unclassified
dependency scope, a missing lockfile integrity, an unknown license, or a denied
license.

Archive the evidence directory even when the policy step fails so the exact
failure is available to reviewers. A release pipeline should run generation as
one step, retain the directory as a build artifact, and then run the gate.

## Historical verified result

On 2026-07-21, after replacing Sharp/libvips with the pinned Playwright
Chromium raster worker, historical schema-12 Darwin ARM64 source evidence produced
342 distinct third-party package/version components. The deterministic
generator, its eight focused tests, and the strict permissive-only policy all
pass with zero violations. The retained source SBOM SHA-256 is
`571b39478f99c3ffdb3ff761c79e58c420f09296741961807cc13a06420c513a` and
the retained license-evidence SHA-256 is
`6ecc9a43fdd37beae32e9c6995503a71a175e40dffbf93672083eaf6de9c80bb`.
`apps/server/package.json`, `pnpm-lock.yaml`, and the retained
`formaspec/server:local` image manifest contain no Sharp or libvips package.
Current schema-16 source and target-artifact evidence must be regenerated before
release qualification.

Linux and Windows release targets must still generate and retain their own
evidence because native optional dependencies and OS payloads are
target-specific. Passing this source-workspace gate does not by itself approve
a container or native installer artifact.

## Retained schema-12 unsigned macOS checkpoint

The retained engineering checkpoint is stored at
`artifacts/candidates/schema12-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`.
Its size is 185,279,180 bytes and its SHA-256 is
`9724f2874c520b5b2b2fa99419978c392a22ee2f534ec9c1ca6e6c49db3fea18`.
Package integrity passes with 349 npm/workspace components, all seven exact
workspace trees, and two bundled runtimes. The payload-tree SHA-256 is
`375daa2689cebdac26c1bd88322e3ea124e30c4c234f364faab4880a65b1d110`
and the workspace-tree SHA-256 is
`5478d6e03ab5ac6bac4fe57e2f26c4bf78802c1c5424da9ef5eb7f77617329c1`.
The non-installing extracted-runtime smoke passes for the frozen bytes, but the
package was not installed and does not match the current workspace's exhaustive
SSE and project/revision historical-release interfaces. Its checksum-bound
summary SHA-256 is
`c1719a9ebab5c7d241fa329df1d3bb6b19bb34b252c063abc276818e48c41964`.

Release remains **NO-GO**. Chromium headless shell revision 1228 has a complete
component/notice inventory, but its composite notice file contains LGPL
notices and is not approved by the permissive-only release policy. The package
also lacks a Developer ID Installer signature, notarization/stapling evidence,
and artifact/native-binary/Chromium/OS vulnerability scan evidence. A same-host
repeat build produced identical payload and workspace trees but different
outer PKG bytes and size, so reproducibility is demonstrably not achieved. The
negative diagnostic summary SHA-256 is
`570d1fb98fb61bc8b2f56b75a4a4379575d7ef2c6bf10bb2a1000ad69a2de710`.

## Retained historical schema-11 checkpoint

The preserved package under `artifacts/candidates/schema11-current/` is a
pre-final-patch historical checkpoint. Its SHA-256 is
`3aad0cd887a7ce83e59cd85e0527500083e71eb31e9340d96dec2eca958017c2` and
its historical size is 176.3 MiB. It was not installed, and its packaged
`packages/core/dist` does not match the current workspace. It must not be
presented as the current-source candidate.

## Historical schema-10 unsigned macOS artifact

The earlier exact unsigned Darwin ARM64 package
`artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
has offline, artifact-specific inventory and integrity evidence for the
schema-10 checkpoint. Its
SHA-256 is
`15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`.
The verifier expanded the package, reconciled all 20,349 BOM/payload entries,
and linked all 349 packaged npm/workspace components to the exact passing
source evidence. All 342 source third-party packages are present, with no
missing, unknown, or manifest-mismatched packages; the build-only
`@formaspec/installer` workspace is explicitly excluded.

Artifact evidence schema 2 additionally compares all 429 entries and 408 files
across seven packaged workspace trees against the checkpoint core/server/web/CLI/
bridge build outputs and managed CLI assets. Their combined content hash is
`4f380a609426526562cab60560ede54290de93e9434fdcb0445752bbf56b3785`,
with no missing, extra, type-mismatched, or content-mismatched entry. This
closes the stale-compiled-output gap that package-manifest linkage alone cannot
detect.

The package also contains locally verified license/provenance evidence for the
bundled Node.js v24.14.0 runtime. The Chromium headless-shell revision 1228
inventory is complete, but its composite notice file contains LGPL notices and
is not allowlisted by the permissive-only release policy. Consequently the
artifact gate fails closed with
`CHROMIUM_RUNTIME_CONTAINS_LGPL_NOTICES`. Signing, notarization,
reproducibility, and vulnerability-scan evidence are also absent, producing
exactly five artifact blockers. This artifact is historical and remains
**NO-GO** for distribution. Do not present it as the current candidate.

See [Unsigned macOS PKG evidence](./MACOS_PKG_EVIDENCE.md) for the artifact
hashes, runtime evidence, verification procedure, and complete blocker list.

## Boundaries still requiring release work

The source-workspace foundation does not prove a Docker image, Windows MSI, or
Linux DEB/RPM artifact. Deterministic Linux DEB/RPM and native-Windows-only WiX
source builders now exist, but no target artifact, target-specific SBOM/license
report, or native lifecycle evidence has been produced. The Windows builder
requires an externally supplied service host plus caller-supplied service-host
and WiX provenance; current checks prove internal consistency, not a trust
anchor or real WiX compile. It does not discover, download, fabricate, or sign
them. The macOS checkpoint evidence records the bytes and component linkage of
one exact retained unsigned PKG and historical predecessors. It does not
approve Chromium's composite notices, scan operating-system packages or
binaries for known vulnerabilities, establish reproducibility, exercise a
native lifecycle matrix, or sign/prove artifact provenance. Those legal reviews,
artifact-specific scans, reproducibility comparisons, signing/notarization,
cross-platform evidence, and native-installer CI steps remain release
blockers.

License metadata and hashed notice files are evidence for review, not legal
advice. Legal and security owners must review each release target's generated
inventory and attribution obligations before production distribution.

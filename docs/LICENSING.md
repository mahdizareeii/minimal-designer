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

## Current verified result

On 2026-07-20, after replacing Sharp/libvips with the pinned Playwright
Chromium raster worker, the current Darwin ARM64 installation produced 342
distinct third-party package/version components. The deterministic generator,
its eight focused tests, and the strict permissive-only policy all pass with
zero violations. `apps/server/package.json`, `pnpm-lock.yaml`, and the rebuilt
`formaspec/server:local` image manifests contain no Sharp or libvips package.

Linux and Windows release targets must still generate and retain their own
evidence because native optional dependencies and OS payloads are
target-specific. Passing this source-workspace gate does not by itself approve
a container or native installer artifact.

## Verified unsigned macOS artifact

The exact unsigned Darwin ARM64 package
`artifacts/candidates/schema10-current/installers/FormaSpec-0.2.0-macos-arm64-unsigned.pkg`
now has offline, artifact-specific inventory and integrity evidence. Its
SHA-256 is
`15d3104a36827da455b874405eaef91b3e2150f90e56b9ba33ad89e155a15f49`.
The verifier expanded the package, reconciled all 20,349 BOM/payload entries,
and linked all 349 packaged npm/workspace components to the exact passing
source evidence. All 342 source third-party packages are present, with no
missing, unknown, or manifest-mismatched packages; the build-only
`@formaspec/installer` workspace is explicitly excluded.

Artifact evidence schema 2 additionally compares all 429 entries and 408 files
across seven packaged workspace trees against the current core/server/web/CLI/
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
exactly five current artifact blockers. This exact artifact therefore remains
**NO-GO** for distribution.

See [Unsigned macOS PKG evidence](./MACOS_PKG_EVIDENCE.md) for the artifact
hashes, runtime evidence, verification procedure, and complete blocker list.

## Boundaries still requiring release work

The source-workspace foundation does not prove a Docker image, Windows MSI, or
Linux DEB/RPM artifact. The macOS evidence proves the bytes and component
linkage of one exact unsigned PKG only; it does not approve Chromium's
composite notices, scan operating-system packages or binaries for known
vulnerabilities, establish reproducibility, exercise a native lifecycle
matrix, or sign/prove artifact provenance. Those legal reviews,
artifact-specific scans, reproducibility comparisons, signing/notarization,
cross-platform evidence, and native-installer CI steps remain release
blockers.

License metadata and hashed notice files are evidence for review, not legal
advice. Legal and security owners must review each release target's generated
inventory and attribution obligations before production distribution.

# Native Windows packaging

## Status

FormaSpec has a source-level WiX v4 foundation intended to produce an unsigned
MSI on native Windows. It is intentionally **not release-approved**. The
builder checks the internal consistency of a caller-supplied self-contained
application payload, native service-host executable, service-host/license
provenance, and WiX executable/provenance. Those caller-supplied records are
self-attestation, not a trust anchor. The builder does not download, discover,
fabricate, sign, or substitute any input.

No real WiX compile or Windows MSI artifact has been produced or qualified by
this repository checkpoint. Current unit tests use fake PE/CFB fixtures and an
injected fake WiX runner; they do not validate an MSI through Windows Installer.
A release still requires a real service host, Windows Service
Control Manager lifecycle proof, service/data/credential ACL verification,
named-pipe renderer and Chromium proof, process-tree containment with a Job
Object or equivalent, protocol registration, clean install/upgrade/uninstall/
reinstall tests, signing, vulnerability/license scans, and independent
reproducibility.

## Build command

First prepare a frozen, already-built, self-contained Windows application
payload. It must contain the pinned Node and Chromium runtimes plus the required
FormaSpec workspace output. Then run on native Windows:

```powershell
pnpm package:windows:msi -- `
  --application-payload C:\absolute\path\to\payload `
  --output C:\absolute\path\to\artifacts `
  --version 0.2.0 `
  --architecture x64 `
  --service-host C:\absolute\path\to\formaspec-service-host.exe `
  --service-host-provenance C:\absolute\path\to\service-host.provenance.json `
  --service-host-license C:\absolute\path\to\SERVICE-HOST-LICENSE.txt `
  --wix C:\absolute\path\to\wix.exe `
  --wix-provenance C:\absolute\path\to\wix.provenance.json
```

Supported initial architectures are `x64` and `arm64`. The version must be a
three-part numeric Windows Installer version. Set `SOURCE_DATE_EPOCH` or pass
`--source-date-epoch <unix-seconds>` to pin staging timestamps.

The command runs only on native Windows and is intended to emit an explicitly
unsigned MSI plus an adjacent SHA-256 file. The current result check recognizes
only the compound-file header; it does not yet validate product/service/
component tables or extract and compare installed payload bytes. Passing
source-level tests or producing a header-shaped file does not satisfy the
native lifecycle or release gates.

## Required external inputs

The service-host provenance is expected to describe the executable and license hashes,
architecture, source archive hash/URL, permissive SPDX identifier, and the
FormaSpec service-host contract/capabilities. The WiX provenance must bind the
exact `wix.exe`, its source hash/URL, version, size, SHA-256, and Microsoft
Reciprocal License identifier. These records are build inputs and review
evidence; today they are caller-supplied self-attestation, not code-signing
credentials, a source-controlled/signed release lock, or proof of runtime
behavior.

## Implemented source hardening

The source foundation now uses one cross-architecture UpgradeCode so x64 and
ARM64 packages cannot intentionally coexist as separate product families. It
copies verified payload files into a private staging snapshot before WiX reads
them, invokes WiX with a minimal allowlisted environment, and gives external
packaging commands an absolute deadline. Focused tests cover these contracts.
They reduce build-time risk but do not prove a valid MSI or Windows runtime.

## Known foundation defects

The current source must not be promoted until these design defects are fixed
and verified on Windows:

- API and renderer service definitions use `LocalSystem` without proven
  restricted identities, ProgramData/named-pipe ACLs, renderer egress denial,
  or descendant containment. Loopback `AUTH_MODE=none` is not an acceptable
  shared-machine trust boundary.
- WiX and service-host provenance does not bind a trusted source archive or the
  full WiX distribution. Caller-supplied matching provenance remains self-
  attestation.
- MSI output validation still accepts a compound-file header without checking
  Windows Installer tables or extracting and comparing the packaged payload.
- PE checks prove only header/machine shape, not a functional Node, Chromium,
  or service host. The real service host, strict protocol parsing, service stop
  behavior, and Windows process-tree containment are absent or unverified.

Production release remains **NO-GO** until the repository-wide release
checklist and every Windows-specific gate pass.

# Native Windows packaging

## Status

FormaSpec has a source-level WiX v4 foundation for producing an unsigned MSI
on native Windows. It is intentionally **not release-approved**. The builder
validates a caller-supplied self-contained application payload, a real native
service-host executable with exact provenance and permissive-license evidence,
and an exact caller-supplied WiX executable with provenance. It does not
download, discover, fabricate, sign, or substitute any of those inputs.

No Windows MSI artifact has been produced or qualified by this repository
checkpoint. A release still requires a real service host, Windows Service
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

The command runs only on native Windows and emits an explicitly unsigned MSI
plus an adjacent SHA-256 file. The build fails closed on missing or mismatched
payloads, unsafe paths/symlinks, architecture drift, invalid provenance,
unapproved service-host licensing, a mismatched WiX binary, or an invalid MSI
result. Passing source-level tests or producing an MSI does not satisfy the
native lifecycle or release gates.

## Required external inputs

The service-host provenance must bind the exact executable and license hashes,
architecture, source archive hash/URL, permissive SPDX identifier, and the
FormaSpec service-host contract/capabilities. The WiX provenance must bind the
exact `wix.exe`, its source hash/URL, version, size, SHA-256, and Microsoft
Reciprocal License identifier. These records are build inputs and review
evidence; they are not code-signing credentials or proof of runtime behavior.

Production release remains **NO-GO** until the repository-wide release
checklist and every Windows-specific gate pass.

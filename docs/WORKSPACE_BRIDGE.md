# Workspace Bridge

Two boundaries must not be confused:

- the implemented **local MCP bridge** proxies Codex to FormaSpec and keeps the
  scoped grant outside Codex configuration;
- the separate **Workspace Bridge** inspects explicitly selected source
  repositories on a workstation under a local read-only grant.

## Implemented foundation

`apps/workspace-bridge` now provides:

- explicit repository selection;
- expiring, immediately revocable `inventory:read` grants stored only on the
  workstation with private permissions;
- organization-policy loading through either a compatible REST identity or the
  authorized local MCP bridge, with repository enablement, allowed platforms,
  byte/entity bounds, and exclusion patterns enforced before persistence;
- policy exclusion patterns persisted into each explicit repository grant;
- bounded content fingerprinting of every included regular file (including
  metadata and assets) without including the absolute repository path in the
  upload form; incomplete fingerprints cannot authorize a launch. Platform and
  Git discovery metadata use bounded regular-file reads with no symlink
  following before the main walker begins;
- bounded traversal with no symlink following;
- generated-directory and secret-pattern exclusion;
- initial detection for web, Android, iOS/Xcode, Flutter, and React Native;
  `generic-git` is emitted only as a fallback when no specific platform is
  detected;
- bounded component, screen, route, token, asset, flow, and business-rule
  symbol discovery;
- a local inventory containing relative paths for workstation diagnostics and
  a separate upload inventory containing only opaque `locationId` values;
- fail-closed file/entity/byte limits;
- automatic persistence of the bounded path-free inventory when a FormaSpec
  connection is configured;
- immutable local binding of the explicit grant to the exact central inventory
  ID and hash accepted by FormaSpec, with cross-process locking so binding and
  revocation cannot race or resurrect a revoked grant;
- an approval-gated `launch-codex` boundary that rechecks the active grant,
  repository fingerprint, current organization policy, exact central inventory
  binding, and immutable handoff approval immediately before launch;
- no shell, central arbitrary-path, repository file-mutation, or general
  subprocess capability. The only subprocess is the locally discovered Codex
  executable, started with `shell: false`, one secret-free handoff argument,
  the explicitly selected repository as its exact working directory, and a
  minimal path/terminal/locale environment allowlist rather than inherited
  workstation credentials. Windows names are matched case-insensitively and
  emitted with canonical environment keys.

Source-development commands after building the package are:

```bash
pnpm workspace-bridge -- grant /explicit/repository/path
pnpm workspace-bridge -- inspect repo_grant_...
pnpm workspace-bridge -- launch-codex repo_grant_... handoff_... --print-plan
pnpm workspace-bridge -- launch-codex repo_grant_... handoff_...
pnpm workspace-bridge -- revoke repo_grant_...
```

`inspect` is path-free by default. `--local-paths` is an explicit
workstation-only diagnostic option and must never be forwarded to the central
server.

For the preferred token-free path, point `FORMASPEC_UPSTREAM_MCP_URL` at the
authorized local bridge `/mcp` endpoint. The Workspace Bridge calls
`organization_policy_read`, scans under that policy, then calls the
non-destructive `repository_inventory_persist` tool. This remains usable when
the upstream UI uses trusted-header identity because the local bridge supplies
its scoped agent grant. `launch-codex` additionally calls only `handoff_read`
and `repository_inventory_read`; the MCP URL must be a credential-free loopback
`/mcp` endpoint and no bearer value is forwarded to Codex.

`FORMASPEC_API_URL` is the direct REST alternative. In token-authenticated API
mode, supply `FORMASPEC_API_TOKEN`; a trusted-header server still needs a
compatible workstation API identity channel. FormaSpec never writes a token
into Codex or the repository grant.

Migration 8 and `WorkspaceHandoffService` now add the central, audited half of
the boundary:

- strict path-free inventory persistence with a 1 MiB/10,000-entity limit;
- canonical SHA-256 identity, exact retry deduplication, and
  active/superseded/revoked lifecycle;
- rejection of path-, command-, shell-, execution-, and unknown fields;
- immutable, idempotent implementation-mapping batches pinned to exact design,
  product-specification, and active-inventory hashes, with all source metadata
  derived from opaque inventory entities;
- revision- and inventory-pinned handoff specifications;
- immutable handoff versions and append-only review/approval/implementation
  transitions;
- independent Product Manager approval and Engineer implementation gates;
- REST, MCP read tools, replayable outbox events, and an initial editor handoff
  panel.

MCP also exposes `repository_inventory_persist` as a non-destructive write with
the same strict path-free schema and `workspace:inventory:write` scope check.
Connected `grant` commands return the opaque persisted inventory ID/hash and
deduplication state after central acceptance, and store that exact ID/hash in
the private local grant. Grants created before this binding existed remain
readable but must be recreated through a connected `grant` command before they
can launch Codex.

`launch-codex` accepts only a handoff whose central status is `implementing`
and whose final immutable transition is the exact `approved` → `implementing`
`start_implementation` authorization for the current handoff version. Its
active central inventory ID/hash/fingerprint must also match the local grant.
`--dry-run` and
`--print-plan` perform the same validation and print the exact executable,
working directory, and single secret-free task reference without starting a
process. A real launch repeats all checks after plan review to catch expiry,
revocation, repository changes, or central state changes at the process-
creation boundary. While Codex is running, a 500 ms authorization monitor
continues checking grant expiry/revocation, organization policy, handoff state,
and the active central inventory. Every probe has an abortable hard deadline;
stalling fails closed. On POSIX systems failure terminates the dedicated Codex
process group with `SIGTERM` and then bounded `SIGKILL`, including descendant
tool processes. Repository content is intentionally not required to retain the
pre-launch fingerprint after process creation because the approved Codex task
is expected to edit that repository.

## Not yet implemented

Automatic mapping suggestions, incremental rescans, packaged
supervision, native credential storage on Windows, broader secret-exclusion
fixtures, and the full local plan/diff/validation/commit/PR execution handoff
remain required. Direct REST use in a trusted-header deployment also needs a
supported workstation identity channel; using the authorized local MCP bridge
avoids that limitation for policy, inventory, implementation mapping, handoff,
and launch validation.
Packaged Windows process-tree containment still requires Job Object or
equivalent retained evidence; the current Windows fallback terminates the
direct Codex child only.

Codex will use its own authorized repository tools for an explicitly approved
implementation. The Workspace Bridge and central FormaSpec server will never
become a general shell or unrestricted file server.

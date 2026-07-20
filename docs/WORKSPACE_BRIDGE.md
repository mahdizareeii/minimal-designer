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
- repository fingerprinting without including the absolute repository path in
  the upload form;
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
- no subprocess, shell, arbitrary network, or repository file-mutation
  capability; outbound requests are limited to the explicitly configured
  FormaSpec REST origin or `/mcp` endpoint for policy and path-free inventory
  persistence.

Source-development commands after building the package are:

```bash
pnpm workspace-bridge -- grant /explicit/repository/path
pnpm workspace-bridge -- inspect repo_grant_...
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
its scoped agent grant.

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
- revision- and inventory-pinned handoff specifications;
- immutable handoff versions and append-only review/approval/implementation
  transitions;
- independent Product Manager approval and Engineer implementation gates;
- REST, MCP read tools, replayable outbox events, and an initial editor handoff
  panel.

MCP also exposes `repository_inventory_persist` as a non-destructive write with
the same strict path-free schema and `workspace:inventory:write` scope check.
Connected `grant` commands return the opaque persisted inventory ID/hash and
deduplication state after central acceptance.

## Not yet implemented

Framework-aware mapping review and automatic mapping upload, selected-workspace
Codex launch, packaged supervision, native credential storage on Windows,
broader secret-exclusion fixtures, and the full local plan/diff/validation/
commit/PR execution handoff remain required. Direct REST use in a trusted-header
deployment also needs a supported workstation identity channel; using the
authorized local MCP bridge avoids that limitation for policy read and
inventory persistence.

Codex will use its own authorized repository tools for an explicitly approved
implementation. The Workspace Bridge and central FormaSpec server will never
become a general shell or unrestricted file server.

# FormaSpec security

Last audited: 2026-07-20

## Current security posture

The current MVP is suitable for loopback development or an SSH-tunnel-only
evaluation. It is **not approved for direct production exposure** and does not
yet meet the FormaSpec enterprise security model.

Organization/project authorization, scoped grants, exact commits, strict
server trust configuration, and a network-denied renderer are now implemented
foundations. Production remains blocked by incomplete exhaustive authorization,
proxy, browser, restore, image-worker, prompt-injection, secret-exclusion,
installer, and long-running operational evidence. An isolated local-Docker
restore/safety-restore exercise now passes, but the server command is only
`HEALTHY_PLANNED_RESTORE_ONLY`, not offline disaster recovery. Clean server
planned-restore supervision, broader recovery evidence, and signed provenance
remain unverified. Additional proxy-origin authentication hardening is active
in the current working tree and must be rerun through the full deployment
matrix before its details are treated as verified release evidence.

## Current controls that are retained

| Control | Current behavior |
| --- | --- |
| Loopback defaults | Native startup defaults to `127.0.0.1`. Launcher-created Docker/server configurations bind the published port to loopback. |
| Bearer comparison | Configured bearer tokens are compared with `timingSafeEqual`. |
| CORS | Browser origins are restricted to a configured allowlist. |
| Request limits | Fastify body size, multipart file count/size, operation count, and operation JSON byte limits exist. |
| Typed design model | V1 documents and normalized operations use Zod schemas and reject arbitrary HTML, CSS, JavaScript, paths, and remote asset URLs. |
| Raster allowlist | Uploads accept only detected PNG, JPEG, or WebP bytes; uploaded SVG is rejected. |
| Optimistic concurrency | Writes require an expected base version and return `VERSION_CONFLICT` instead of auto-merging. |
| Revision immutability | SQLite triggers reject revision update and delete. Restore creates a new revision. |
| MCP annotations | Read, write, preview, and destructive tools have approval hints. |
| Organization policy | A strict schema-version-1 policy is read through REST/MCP, edited by an Organization Administrator with an expected configuration hash, exported as secret-free YAML, and enforced for agents, identity mappings, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. |
| Portable import boundary | Read-only validation is separate from Organization Administrator mutation. Import requires scoped idempotency, preserve-ID conflict failure or deterministic clone remapping, strict V1/V2/product-spec validation, isolated raster normalization, database rollback on failure, and immutable migration-10 provenance. |
| Live event authorization | SSE resolves the actor again before every delivered event and every 15-second heartbeat, so revocation or policy denial closes an already-open stream. |
| Container isolation | Docker runs API and renderer separately. The renderer is `pwuser`, network-disabled, read-only, capability-free, no-new-privileges, and resource-limited. Linux startup inspects the mount table and refuses `/data`, `/backups`, or nested production mounts; the rebuilt renderer exposes only `/run/formaspec`. |
| Restore fencing | Launcher-pinned Docker/server planned restore is externally supervised against a mode-`0600` exact runtime binding, a non-expiring shared worker lock, fail-closed maintenance, and crash-resumable operation/journal state. Every capture/verification requires local-driver/local-scope Docker volumes with no options, bounded absolute and distinct backing mountpoints; plugin, NFS, bind-backed, and aliased volumes fail closed. Fastify never restores its own open database and refuses to open SQLite during incomplete cutover. The path requires a healthy current API/database and is not offline disaster recovery. |
| Restore source identity | Restore and verified download use `O_NOFOLLOW` plus private descriptor-pinned bytes, expected size/SHA-256 validation, and only the opened pin for later reads. Whole-workflow capacity is checked before maintenance and every copy/extraction step rechecks available space. Active-operation source-pin orphans are preserved; committed journal evidence survives cleanup failure. |
| Local agent bridge | The token-free Codex URL is a loopback proxy that requires an OS-stored scoped grant upstream, validates its bound Host, rejects browser-origin requests, strips caller credentials, fails closed when no grant is available, and is automatically restarted when its runtime fingerprint is stale. |
| Render-job metadata | Migration 11 persists only bounded API-owned lifecycle metadata: organization/internal scope, hashes, versions, dimensions, bounded warnings, and safe errors. It does not store documents, raw assets, PNG bytes, paths, or filenames. Owner leases/heartbeats recover only expired work; terminal deletion requires scoped permits at the exact 30-day cutoff. The renderer remains database-free. |
| Selected-workspace launch | The Workspace Bridge binds a local grant to the exact central inventory and approved handoff, launches Codex with `shell: false`, exact repository `cwd`, one secret-free task reference, and a minimal environment, then monitors revocation/policy/handoff/inventory state. POSIX process groups are terminated on withdrawal; Windows Job Object/equivalent descendant containment remains a release blocker. |
| Prompt/data separation | MCP instructions tell agents to treat design text and metadata as untrusted data rather than instructions. |

These controls reduce risk but do not by themselves close the release gates.

## Current authentication modes

### `AUTH_MODE=none`

Use only with `APP_MODE=local` on loopback. There is no user authentication;
strict local mode ignores proxy identity headers and rejects non-loopback
binding unless using the explicit container-local boundary.

Safe evaluation command:

```bash
./designer start docker --no-open
```

Do not change `BIND_ADDRESS` to `0.0.0.0` while authentication is disabled.

### `AUTH_MODE=token`

This is retained only as a compatibility authentication mechanism. Service
authorization still resolves the principal's organization/project access; a
shared token is not a substitute for role or scoped-grant policy.

The legacy environment MCP-token path is also bounded at the HTTP boundary by
organization policy. It is rejected unless agents and the legacy-token path are
enabled, `generic_mcp` is allowed, project restrictions are not required, the
token age is within the maximum grant lifetime, the active-connection cap has
not been reached, and at least one requested scope is policy-approved. This
compatibility path cannot bypass `agents.allowedScopes`.

### `AUTH_MODE=trusted-header`

Browser/REST identity is taken from one reverse-proxy header. MCP uses the
configured bearer token. This mode is safe only if the application port is
unreachable except from the verified proxy and the proxy removes every
client-provided copy of the identity header.

Trusted identities honor exact policy role mappings whose claim is `identity`,
`external_id`, or `trusted_user`. A first trusted identity may bootstrap as
Organization Administrator only while the organization still has default or
quarantined legacy configuration and no other non-local principal exists;
stored-policy operation does not retain that bootstrap exception.

Server mode now refuses incomplete HTTPS/public-URL, trusted-proxy,
Host/Origin, identity, CSRF, CSP/security-header, and MCP-auth configuration.
Every non-health server request must also arrive from an allowlisted raw socket
peer with the separate `x-formaspec-proxy-secret` hop credential. The value is
compared through fixed-size digests, must not reuse `DESIGNER_TOKEN`, is never a
browser/agent credential, and must be stripped and overwritten by the reverse
proxy. Exact minimal health probes remain credential-free after raw-peer and
Host validation.
Per-project authorization, scoped grants, and audit exist. Treat the mode as an
implemented foundation, not enterprise readiness, until the real
reverse-proxy/direct-port matrix and all role/scope cases pass.

The launcher can generate a placeholder-safe configuration without printing the
token:

```bash
./designer server init --public-url https://designer.company.example
./designer start server
```

Do not run `./designer token` in shared terminals, captured logs, tickets, or
chat transcripts.

## P0 findings and current disposition

| Severity | Finding | Evidence | Required correction |
| --- | --- | --- | --- |
| Critical | Object authorization was absent | **Implemented foundation:** organization/project authorization now covers service lookups and scoped grants. | Complete the exhaustive route/resource/role/scope/ID matrix before release. |
| High | SSE crossed actors and could not replay | **Implemented foundation:** persisted organization-scoped outbox, replay, monotonic IDs, `Last-Event-ID`, gaps, and per-event/per-heartbeat reauthorization exist. Revocation closes active streams. | Add load, retention, reconnect, and publisher-failure tests. |
| High | Preview commit was not exact/fully atomic | **Implemented foundation:** exact content-addressed snapshots commit inside one immediate transaction and publish afterward. | Extend fault injection, concurrent CAS, restart, and corruption evidence. |
| High | Destructive approval boundary was bypassable | **Implemented foundation:** ordinary commits reject archive operations; archive has separate preview/commit paths. | Finish negative coverage and client approval annotations. |
| High | Server trust mode was not fail-closed | **Implemented foundation:** strict local/server modes, HTTPS/public URL, proxy ranges, Host/Origin/CSRF, and security headers exist. | Prove the real reverse-proxy/direct-port deployment matrix. |
| High | Renderer lacked an egress/process boundary | **Implemented foundation:** Docker uses a separate non-root worker, bounded Unix-socket IPC, `network_mode: none`, read-only root, dropped capabilities, per-job contexts, resource/time limits, fail-closed production-volume mount validation, and migration-11 persistent bounded job lifecycle metadata. | Add real named-pipe/native packaging, canary egress automation, stress/crash/recovery evidence, retention operations/UI, and server deployment proof. |
| Medium | Raster files were not normalized | Full PNG/JPEG/WebP decode now runs through the pinned Chromium renderer worker; APNG/animated WebP/MPO/SVG/malformed input is rejected, EXIF orientation is applied, metadata is stripped, output is deterministic PNG, API/worker limits are versioned and matched, and content-addressed storage plus legacy-BLOB fallback is verified. The same full-decode verifier is required by backup creation/verification, restore preflight, safety-backup verification, and final cutover. | Add operator-approved legacy quarantine cleanup, a larger malformed corpus, and upload-storm/queue evidence. |
| Medium | CSRF/CSP/security header policy was missing | Origin/Host/CSRF intent and CSP/framing/MIME/referrer/transport headers now exist. | Complete browser and reverse-proxy coverage. |
| Medium | MCP schemas have permissive fallbacks | Generic passthrough output and record-shaped temporary operation fallback reduce schema strictness. | Strict discriminated input/output schemas for each tool. |
| Medium | Audit and revocation were absent | Append-only audit events plus expiring/revocable scoped grants and Agent Connections controls exist. Managed re-authorization atomically rotates exact matching connections, production authentication checks the owning connection, Codex scope/expiry/project restrictions come from policy, and restart/rollback tests cover invalidation. Audit retention now uses an admin-only exact preview/commit, minimum-policy cutoff, bounded batches, atomic temporary delete permits, restart-safe idempotency, retained audit/outbox evidence, and an immutable SHA-256 run chain. | Complete stable managed-connection identity, scheduled retention supervision/alerting, administration UX, and the full lifecycle matrix. |
| Medium | Backups were not integrity verified | Online checksummed bundles, strict V1/V2 document and asset ownership/reference verification, descriptor-pinned verify/download/restore bytes, whole-workflow capacity preflight, post-trigger credential revocation checks, audit, source-local restore, and externally supervised launcher-pinned Docker/server planned restore exist. Runtime volume identity is revalidated live and recovery/lock/health failure paths fail closed. An isolated A-only then A+B safety-restore exercise preserved IDs/revisions and revoked restored credentials. | Add a separately authorized offline disaster-recovery path, clean server planned-restore evidence, approved signing/provenance, OS-native no-replace cutover support, broader recovery fixtures, and the full release E2E. |

## Required security invariants

Phase 1 and later code must enforce these invariants at the service layer, not
only in route handlers:

- Every design, revision, preview, asset, context, event, task, handoff, and
  export belongs to an organization and, where applicable, a project.
- Every access resolves an authenticated principal and an effective role or
  scoped agent grant.
- Object IDs are never treated as authorization.
- Local mode binds to loopback and ignores all proxy identity headers.
- Server mode refuses startup without a public HTTPS URL, trusted proxy ranges,
  a separate internal proxy secret, Host/Origin allowlists, identity mapping,
  CSP/security headers, and MCP auth.
- Browser state-changing requests have CSRF protection appropriate to the
  identity mechanism.
- MCP grants have explicit scopes, optional project restrictions, expiry,
  auditability, and immediate revocation.
- Revocation is checked for every request and active event stream.
- Design text, product specifications, repository source, and filenames remain
  untrusted data.
- No central interface accepts arbitrary filesystem paths, shell commands,
  remote URLs, HTML, CSS, JavaScript, or unsanitized SVG.
- Archive is always previewed and committed through a destructive approval
  boundary.
- Renderer and image workers run non-root with bounded resources and no external
  network.
- Secrets are stored only in approved environment/OS secret stores and are
  redacted from logs, exports, support bundles, and task payloads.
- Backup extraction is bounded against traversal and unsafe entry types.
  Portable ZIP validation rejects unsafe/duplicate paths, unsupported
  compression, encryption, non-regular entries, local/central mismatches,
  descriptor/CRC/checksum errors, hidden trailing data, and
  archive/entry/count/aggregate expansion limits before mutation. Entries are
  inflated independently in bounded 16 KiB chunks; multipart bodies and
  extracted entry buffers remain memory-resident within the configured caps.
- A running Fastify process never replaces its own open database; restore is
  externally supervised and uses exact runtime, worker-lock, maintenance, and
  journal ownership.
- Backup hashes establish byte consistency, not authenticity. Provenance claims
  require an approved signing and key-management boundary.

## Deployment guidance before Phase 1 closes

Use one of these two evaluation patterns:

1. Local Docker bound to `127.0.0.1`.
2. Server bound to `127.0.0.1` and reached through an SSH tunnel.

```bash
# Server
./designer server init --ssh-only
./designer start server

# Workstation
ssh -L 4310:127.0.0.1:4310 user@your-server
```

Do not expose port 4310 on a LAN, public interface, ingress controller, or
untrusted reverse proxy until the authorization and server-mode gates pass.

## Secret handling

- `.designer/` is ignored by Git and should remain mode-restricted.
- Never place a bearer token directly in `.codex/config.toml`.
- Never commit environment files, copied databases, backups, uploaded assets,
  or support bundles.
- Use environment-variable indirection for legacy MCP bearer configuration.
- Before sharing logs or diagnostics, remove authorization headers, environment
  files, user identity values, project text, and repository paths.
- Local bridge grants live in macOS Keychain, Linux Secret Service, or a
  Windows current-user DPAPI blob and must not be copied to Codex or central
  server configuration. Real packaged Windows ACL/lifecycle evidence remains
  required.
- macOS Keychain writes use the system prompt through a private PTY; the grant
  never enters argv or environment and must pass an exact read-back check before
  authorization is reported successful.
- The local bridge never falls back to tokenless upstream MCP. An empty or
  unavailable credential store returns `BRIDGE_AUTH_REQUIRED` without
  contacting the application.

## Security validation gate

Production release is blocked until automated tests cover:

- role, organization, project, scope, expiry, and revocation matrices;
- IDOR attempts for every REST, SSE, MCP, asset, preview, and revision route;
- forged trusted headers, untrusted proxy sources, invalid Host/Origin, CSRF,
  and direct-port bypass;
- concurrent CAS and idempotent retry behavior;
- destructive archive bypass attempts;
- path traversal, symlinks, zip/tar bombs, oversized payloads, malformed and
  animated images, SVG rejection, and metadata stripping;
- renderer external-network denial and process isolation;
- restore worker/container identity, shared-lock ownership, crash recovery,
  server-supervisor lifecycle, and continued pinned-source regression coverage;
- prompt-like text inside designs, specifications, and repositories;
- secret exclusion from logs, audit views, exports, task payloads, backups, and
  support bundles.

See [THREAT_MODEL.md](./THREAT_MODEL.md) for abuse cases and
[RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) for the release decision.

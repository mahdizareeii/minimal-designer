# FormaSpec security

Last audited: 2026-07-22

## Current security posture

The current FormaSpec build is suitable for loopback development or an SSH-tunnel-only
evaluation. It is **not approved for direct production exposure** and does not
yet meet the FormaSpec enterprise security model.

Organization/project authorization, scoped grants, exact commits, strict
server trust configuration, migration-14 password sessions, migration-15
immutable preview-render evidence, migration-16 canonical bootstrap-credential
consumption, and a network-denied renderer are now implemented foundations.
Production remains blocked by
broader combinatorial authorization, proxy, browser, restore, image-worker,
prompt-injection, secret-exclusion, installer, and long-running operational
evidence. A historical isolated local-Docker
planned restore/safety-restore exercise passed. A separately authorized
offline bundle path also exists and can preserve corrupt pre-state bytes without
opening SQLite. A historical disposable unique-Compose worker/control smoke passed a real
corrupt-database restore, revocation, and forensic byte rollback without
touching the user's live stack; those source/Compose CLI recovery smokes are
historical runtime evidence.
Clean server planned/offline supervision, packaged lifecycle proof, broader
recovery evidence, and signed provenance remain unverified. Server mode now
requires a separate internal proxy hop
secret on every non-health request in addition to raw-peer validation; focused
server/launcher tests pass. A controlled actual-socket 1/1 lifecycle checkpoint
proves header replacement, direct-peer denial, ambiguous append rejection, and
restart-bound rotation. Real Nginx/TLS, identity-provider, public-port/firewall,
and compromise-response deployment evidence remains open.

## Current controls that are retained

| Control | Current behavior |
| --- | --- |
| Loopback defaults | Native startup defaults to `127.0.0.1`. Launcher-created Docker/server configurations bind the published port to loopback. |
| Bearer comparison | Configured bearer tokens are compared with `timingSafeEqual`. |
| Password sessions | `AUTH_MODE=session` uses versioned scrypt password hashes, 256-bit random session tokens with only SHA-256 stored, HttpOnly/SameSite Strict cookies, Secure cookies for HTTPS/server, per-session CSRF, 8-hour idle and 24-hour absolute expiry, login rotation/logout revocation, and bounded persistent login-failure buckets. |
| CORS | Browser origins are restricted to a configured allowlist. |
| Request limits | Fastify body size, multipart file count/size, operation count, and operation JSON byte limits exist. |
| Typed design model | V1 documents and normalized operations use Zod schemas and reject arbitrary HTML, CSS, JavaScript, paths, and remote asset URLs. |
| Raster allowlist | Uploads accept only detected PNG, JPEG, or WebP bytes; uploaded SVG is rejected. |
| Optimistic concurrency | Writes require an expected base version and return `VERSION_CONFLICT` instead of auto-merging. |
| Revision immutability | SQLite triggers reject revision update and delete. Restore creates a new revision. |
| MCP annotations | Read, write, preview, and destructive tools have approval hints. |
| Organization policy | A strict schema-version-1 policy is read through REST/MCP, edited by an Organization Administrator with an expected configuration hash, exported as secret-free YAML, and enforced for agents, identity mappings, repositories, assets, backups, and portable bundle export/import. Corrupt post-policy configuration fails closed; unproven legacy free-form configuration is quarantined. |
| Portable import boundary | Read-only validation is separate from Organization Administrator mutation. Import requires scoped idempotency, preserve-ID conflict failure or deterministic clone remapping, strict V1/V2/product-spec validation, isolated raster normalization, database rollback on failure, and immutable migration-10 provenance. Multipart bytes stream into a private file; ZIP entries stream independently into private files with bounded expansion, CRC, hash, and pinned file metadata rather than retaining the whole request/extracted set in memory. |
| Live event authorization | `/events` and `/api/events` authenticate bearer tokens as scoped grant actors and session cookies as token-bound session actors, while bearer-less local/trusted-header browser EventSource behavior remains mode-specific. SSE resolves the actor again before every delivered event and every 15-second heartbeat, so logout, session expiry/revocation, grant revocation, principal disablement, or policy denial closes an already-open stream. Real loopback HTTP tests cover session logout closure, replay/live filtering, marker non-leakage, grant-revocation closure, and rejected reconnect. |
| Container isolation | Docker runs API and renderer separately. The renderer is `pwuser`, network-disabled, read-only, capability-free, no-new-privileges, and resource-limited. Linux startup inspects the mount table and refuses `/data`, `/backups`, or nested production mounts; the rebuilt renderer exposes only `/run/formaspec`. |
| Restore fencing | Launcher-pinned Docker/server planned and offline restore are externally supervised against a mode-`0600` exact runtime binding, a non-expiring shared worker lock, fail-closed maintenance, and crash-resumable operation/journal state. Every capture/verification requires local-driver/local-scope Docker volumes with no options, bounded absolute and distinct backing mountpoints; plugin, NFS, bind-backed, and aliased volumes fail closed. Fastify never restores its own open database and refuses to open SQLite during incomplete cutover. Managed-ID restore requires a healthy current API/database; offline restore instead requires a separately verified operator-selected bundle and explicit `--yes`. |
| Restore source identity | Restore and verified download use `O_NOFOLLOW` plus private descriptor-pinned bytes, expected size/SHA-256 validation, and only the opened pin for later reads. Offline recovery checks receive capacity before consuming stdin; both paths run a whole-workflow forecast and every copy/extraction step rechecks available space. Spawned child stdout/stderr shares one combined 4 MiB budget by default, with a 5-second SIGKILL fallback for children that ignore SIGTERM. Active-operation source-pin orphans are preserved; committed journal evidence survives cleanup failure. |
| Offline recovery pre-state | Offline restore passes no host path into the worker: the CLI pins the verified regular file by device/inode/size and streams only stdin with an authorized SHA-256/size. Before cutover the worker applies bounded tree and capacity checks, then creates and verifies a checksummed forensic bundle of the exact current data bytes, including a corrupt database. Standard post-cutover schema/render/audit/outbox/revocation checks still apply, including revocation of restored browser sessions alongside grants, connections, and pairing nonces. Every offline failure after fencing remains in maintenance for explicit resume; it never auto-aborts or restarts the API. During takeover, the forensic predecessor remains durable until replacement preparation succeeds; resumed `offlinePrepare` and the replacement worker use the current maintenance owner rather than the predecessor ID. Forensic rollback keeps maintenance active/API stopped with `maintenanceCleared: false` and `serviceReady: false`. Restore control rejects direct clearing; only atomic handoff to a newly verified offline restore is supported. Pristine/prepared abort re-verifies the unchanged database; corrupt/non-SQLite open or query failures become structured `VALIDATION_FAILED`, so corrupt state cannot use abort to escape the fence. |
| Local agent bridge | The token-free Codex URL is a loopback proxy that requires an OS-stored scoped grant upstream, validates its bound Host, rejects browser-origin requests, strips caller credentials, fails closed when no grant is available, and is automatically restarted when its runtime fingerprint is stale. In authenticated mode, connection creation/reconnect remains an Organization Administrator browser action. The bridge consumes the administrator-issued one-time nonce only through `/api/agent-connections/pair`, verifies an optional expected connection ID, and may reuse an existing grant only when its live authorization context remains exact. |
| Render-job metadata | Migration 11 persists only bounded API-owned lifecycle metadata: organization/internal scope, hashes, versions, dimensions, bounded warnings, and safe errors. It does not store documents, raw assets, PNG bytes, paths, or filenames. Owner leases/heartbeats recover only expired work; terminal deletion requires scoped permits at the exact 30-day cutoff. The renderer remains database-free. |
| Implementation mappings | Mapping writes accept only exact V2 design entities and opaque inventory entity IDs. The server derives source symbols/opaque locations from a hash-pinned active inventory, records immutable revision/product-spec/inventory pins, and rejects caller-supplied paths or source metadata. |
| Selected-workspace launch | The Workspace Bridge binds a local grant to the exact central inventory and requires the final immutable `approved` → `implementing` `start_implementation` transition, launches Codex with `shell: false`, exact repository `cwd`, one secret-free task reference, and a minimal environment, then monitors revocation/policy/handoff/inventory state. POSIX process groups are terminated on withdrawal; Windows Job Object/equivalent descendant containment remains a release blocker. |
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

### `AUTH_MODE=session`

This is the default fresh public-server browser authentication mode and is also
available for loopback development. Local session mode allows the browser to
create the sole bootstrap administrator without an installer token. A fresh
public server fails closed until `FORMASPEC_BOOTSTRAP_TOKEN_HASH` contains the
installer-generated one-time token SHA-256.

Migration 14 enforces these invariants:

- exactly one password account may exist, and it must belong to an enabled
  human Organization Administrator;
- the account's organization, principal, login identity, bootstrap flag, and
  creation identity are immutable, and the account cannot be deleted;
- passwords are stored as versioned scrypt hashes with independent random
  salts; login failure responses do not reveal whether an identity exists;
- session tokens contain 256 random bits, only their SHA-256 hashes are stored,
  and CSRF material is separately derived and stored only as a hash;
- cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` for HTTPS/server
  deployments; sessions expire after 8 idle hours or 24 absolute hours;
- a successful login revokes older sessions for the account, logout revokes the
  current session, and expired/disabled-principal sessions fail closed;
- bounded persistent global, source, and known-identity failure buckets protect
  login without creating unbounded attacker-controlled rows;
- the public-server bootstrap credential has fixed ID `initial_admin`, stores
  only a SHA-256 token hash, and can be consumed exactly once with the atomic
  administrator creation transaction.

Browser writes require the exact per-session CSRF token returned by
`/api/auth/status`, `/api/auth/bootstrap`, or `/api/auth/login`; the fixed value
`1` is not accepted for session writes. Session actors use
`session:<sessionId>:<principalId>` and resolve the live session, principal,
membership, idle expiry, absolute expiry, and revocation state on every request,
SSE event, and heartbeat.

Browser session authentication does not authenticate MCP. Server-mode and
managed Codex agents require scoped, expiring Agent Connections; direct
loopback local MCP retains its local-actor compatibility path. The only
headless browser-identity exception is exact
`POST /api/agent-connections/pair`, which is authorized by the one-time nonce.
Connection creation, reconnect, and revoke remain Organization Administrator
browser actions with session CSRF. Restore reconciliation revokes restored
browser sessions as well as agent grants, connections, and pairing nonces.

### `AUTH_MODE=trusted-header`

Browser/REST identity is taken from one reverse-proxy header. MCP uses the
configured bearer token. This mode is safe only if the application port is
unreachable except from the verified proxy and the proxy removes every
client-provided copy of the identity header.

Trusted identities honor exact policy role mappings whose claim is `identity`,
`external_id`, or `trusted_user`. Policy validation rejects duplicate effective
identity values across those aliases so mapping order cannot change a user's
role. A first trusted identity may bootstrap as
Organization Administrator only while the organization still has default or
quarantined legacy configuration and no other non-local principal exists;
stored-policy operation does not retain that bootstrap exception.

Server mode now refuses incomplete HTTPS/public-URL, trusted-proxy,
Host/Origin, CSRF, CSP/security-header, and authentication configuration.
Trusted-header mode additionally requires an identity mapping/header and MCP
bearer token; session mode requires the one-time bootstrap-token hash until the
administrator exists.
Every non-health server request must also arrive from an allowlisted raw socket
peer with the separate `x-formaspec-proxy-secret` hop credential. The value is
compared through fixed-size digests, must not reuse `DESIGNER_TOKEN`, is never a
browser/agent credential, and must be stripped and overwritten by the reverse
proxy. Exact minimal health probes remain credential-free after raw-peer and
Host validation.
Per-project authorization, scoped grants, and audit exist. Treat the mode as an
implemented foundation, not enterprise readiness. A controlled actual-socket
loopback harness verifies replace/remove behavior, direct raw-peer rejection,
and restart-bound hop-secret rotation; real Nginx/TLS, identity-provider,
firewall/routing, public-port, and all role/scope deployment matrices remain
release gates.

The launcher defaults to password sessions and prints the one-time setup URL:

```bash
./designer server init --public-url https://designer.company.example
./designer start server
```

Use `--trusted-header` only for the existing SSO alternative:

```bash
./designer server init \
  --public-url https://designer.company.example \
  --trusted-header
```

In trusted-header mode, do not run `./designer token` in shared terminals,
captured logs, tickets, or chat transcripts. In session mode, protect the
printed `setup#bootstrap=…` URL and `.designer/env/bootstrap-token` file with
the same care until bootstrap is complete.

## P0 findings and current disposition

| Severity | Finding | Evidence | Required correction |
| --- | --- | --- | --- |
| Critical | Object authorization was absent | **Implemented foundation:** organization/project authorization covers service lookups, session actors, and scoped grants; a 108-route manifest closes the protected non-MCP inventory; all routes reject missing/malformed identities before parsing; non-pairing routes reject unavailable identities; and direct role/foreign-ID/swapped-ID/non-leak/no-mutation plus scoped-agent/session/revocation evidence covers all 108 protected routes with zero uncovered across planning/tasks/design-system/mappings, product specifications, the complete handoff lifecycle, Redesign Studio assessments, Agent Connections, Repository Inventory, backup artifact control, organization policy/audit retention, and the remaining core design/catalog routes. The matrices fixed exact principal/design/revision-scoped mapping cleanup, principal-scoped handoff cleanup, denied-plan bypass, SQL project filtering before `LIMIT`, Redesign lifecycle/version leakage, authorization-after-schema-validation leaks, and direct release access outside a project's allowed current pins. A separate project/revision-bound interface reads the exact historical release without exposing the organization catalog. | Keep the 108-route direct suite release-blocking and complete the broader human-role/project/parent-child combinatorial lifecycle matrix before release. |
| High | SSE crossed actors and could not replay | **Implemented foundation:** persisted organization-scoped outbox, replay, monotonic IDs, `Last-Event-ID`, gaps, bearer-to-scoped-grant authentication on both public event routes, and per-event/per-heartbeat reauthorization exist. Real HTTP tests prove project/organization filtering and revocation closure. | Add long-running load/backpressure, server-mode proxy, retention-gap, reconnect-storm, and publisher-failure tests. |
| High | Preview commit was not exact/fully atomic | **Implemented foundation:** exact content-addressed snapshots commit inside one immediate transaction and publish afterward. | Extend fault injection, concurrent CAS, restart, and corruption evidence. |
| High | Destructive approval boundary was bypassable | **Implemented foundation:** ordinary commits reject archive operations; archive has separate preview/commit paths. | Finish negative coverage and client approval annotations. |
| High | Server trust mode was not fail-closed | **Implemented foundation:** strict local/server modes, HTTPS/public URL, proxy ranges, a separate server-generated internal hop secret required on every non-health request, Host/Origin, session or trusted-header browser authentication, mode-appropriate CSRF, and security headers exist. Fresh public session mode requires the installer bootstrap hash. Health remains credential-free; launcher generation/storage/scrubbing and support-bundle exclusion have focused coverage. A historical controlled actual-socket loopback suite verifies proxy replacement, direct raw-peer rejection, ambiguous append rejection, and restart-bound secret rotation. | Prove real Nginx/TLS session and SSO deployments, external identity-provider behavior, firewall/routing, public-port, zero/low-downtime rotation, lifecycle, and compromise-response matrices. |
| High | Renderer lacked an egress/process boundary | **Implemented foundation:** Docker uses a separate non-root worker, bounded Unix-socket IPC, `network_mode: none`, read-only root, dropped capabilities, per-job contexts, resource/time limits, fail-closed production-volume mount validation, and migration-11 persistent bounded job lifecycle metadata. Current schema-16 image `sha256:620d231484044701403ff688493492ff5f8d12d7b09db3de6f00be83cbc658a1` fails the canary closed for DNS, direct TCP, and non-loopback external interfaces; 8/8 workflow-contract tests prevent silent removal. | Retain the current result in hosted supported-OS evidence, and add real named-pipe/native packaging, stress/crash/recovery evidence, retention operations/UI, and server deployment proof. |
| Medium | Raster files were not normalized | Full PNG/JPEG/WebP decode now runs through the pinned Chromium renderer worker; APNG/animated WebP/MPO/SVG/malformed input is rejected, EXIF orientation is applied, metadata is stripped, output is deterministic PNG, API/worker limits are versioned and matched, and content-addressed storage plus legacy-BLOB fallback is verified. The same full-decode verifier is required by backup creation/verification, restore preflight, safety-backup verification, and final cutover. | Add operator-approved legacy quarantine cleanup, a larger malformed corpus, and upload-storm/queue evidence. |
| Medium | CSRF/CSP/security header policy was missing | Origin/Host/CSRF intent and CSP/framing/MIME/referrer/transport headers now exist. | Complete browser and reverse-proxy coverage. |
| Medium | MCP schemas had permissive fallbacks | **Implemented foundation:** every tool input is strict and bounded, task/redesign inputs are discriminated, temporary preview operations mirror the exact ten-operation core union, every success family uses an exact nested DTO with ID/hash/version/state correlation, and `handoff_list` now returns bounded dedicated summaries through authorization-bound checksummed keyset pagination. Bounded generic JSON remains only inside structured `error.details`. | Keep the contract matrix release-blocking and add cursor-rotation plus large-history load evidence. |
| Medium | Audit and revocation were absent | Append-only audit events plus expiring/revocable scoped grants and Agent Connections controls exist. Managed re-authorization atomically rotates exact matching connections, production authentication checks the owning connection, Codex scope/expiry/project restrictions come from policy, and restart/rollback tests cover invalidation. Audit retention now uses an admin-only exact preview/commit, minimum-policy cutoff, bounded batches, atomic temporary delete permits, restart-safe idempotency, retained audit/outbox evidence, and an immutable SHA-256 run chain. The Administration surface provides a guided 12-section policy form, Expert JSON, secret-free YAML export, and optimistic configuration-hash updates. | Complete stable managed-connection identity, delegated administration, installed external schedule invocation and alert delivery, policy rollout/version migration, and the broader organization lifecycle matrix. |
| Medium | Backups were not integrity verified | Online checksummed bundles, strict V1/V2 document and asset ownership/reference verification, descriptor-pinned verify/download/restore bytes, whole-workflow capacity preflight, post-trigger credential revocation checks, audit, source-local restore, launcher-pinned planned restore, and explicit offline recovery exist. Scheduled runs now record durable start/success/failure audit/outbox evidence; overdue and retention-backlog diagnostics feed ready health and bounded CLI warnings; failed or stalled attempts remain critical even when the current window already has a valid backup. Offline preparation uses stdin-only pinned transfer, complete target/raster verification, and an exact forensic pre-state bundle before standard verified restore/revocation. Runtime volume identity is revalidated live and recovery/lock/health failure paths fail closed. An isolated A-only then A+B planned restore exercise preserved IDs/revisions and revoked restored credentials; a separate unique-Compose worker/control smoke restored a real design from corrupt live bytes, revoked credentials, and forensically restored those exact corrupt bytes under a retained fence. Current schema-16 evidence also passes same-host copied-bundle recovery into an independent clean Compose project with SQLite, foreign-key, asset, hash, and render verification. | Retain recovery on hosted supported-OS runners; add installed external scheduling and alert delivery, real server planned/offline lifecycle evidence, approved signing/provenance, OS-native no-replace cutover support, broader recovery fixtures, and real remote-host/TLS/off-site disaster-recovery exercises. |

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
  a separate internal proxy secret, Host/Origin allowlists, CSP/security
  headers, and either session authentication or trusted-header authentication.
  Trusted-header mode additionally requires identity mapping and MCP bearer
  auth; a fresh session deployment requires the installer bootstrap-token hash.
- Browser state-changing requests have CSRF protection appropriate to the
  identity mechanism.
- MCP grants have explicit scopes, optional project restrictions, expiry,
  auditability, and immediate revocation.
- Browser-session and agent-grant revocation is checked for every request and
  active event stream, including each SSE heartbeat.
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
  archive/entry/count/aggregate expansion limits before mutation. Multipart
  bytes stream to private storage and entries inflate independently in bounded
  16 KiB chunks into private files. Individual JSON/raster entries are loaded
  only when parsed or normalized under the 64 MiB per-entry cap.
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
- In public session mode, protect `.designer/env/bootstrap-token` and the
  printed `setup#bootstrap=…` URL. `server.env` stores only the SHA-256, but the
  one-time plaintext remains a credential until atomic bootstrap consumption.
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
  server-supervisor planned/offline lifecycle, corrupt-database forensic
  rollback, and continued pinned-source regression coverage;
- prompt-like text inside designs, specifications, and repositories;
- secret exclusion from logs, audit views, exports, task payloads, backups, and
  support bundles.

See [THREAT_MODEL.md](./THREAT_MODEL.md) for abuse cases and
[RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) for the release decision.

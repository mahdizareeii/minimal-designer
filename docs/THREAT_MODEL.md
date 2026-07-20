# FormaSpec threat model

Last audited: 2026-07-19

## Status and scope

This is the Phase 0 threat model for the existing MVP and the approved
enterprise architecture. It is not a claim that the listed mitigations already
exist. Current controls and gaps are labeled explicitly.

In scope:

- browser, REST, SSE, MCP, SQLite, assets, preview/commit, renderer, launcher,
  Docker, backups, future local bridge, Workspace Bridge, imports/exports,
  agent tasks, and organization administration;
- local, SSH-tunnel, and reverse-proxy deployments;
- accidental misuse and malicious authenticated or unauthenticated actors.

Out of scope as product capabilities: public sharing, realtime cursors,
arbitrary HTML/CSS/JavaScript, arbitrary SVG, central shell execution, and
unrestricted repository access. Attempts to introduce these capabilities are
still considered threats.

## Assets to protect

- canonical documents, immutable revisions, previews, operations, and hashes;
- product specifications, business rules, design systems, component releases,
  tokens, and implementation mappings;
- uploaded raster assets and generated renders;
- organization membership, roles, policies, agent grants, and audit history;
- agent task inputs, transitions, outputs, and handoff approvals;
- backup/export bundles and retention metadata;
- local repository inventories, mappings, paths, and connection grants;
- MCP bearer/grant material and operating-system stored secrets;
- service availability and renderer capacity.

## Actors

| Actor | Expected authority |
| --- | --- |
| Local evaluator | Full access only to the loopback local workspace. |
| Organization Admin | Membership, policy, connection, retention, and project administration. |
| Product Manager / Designer | Authorized project/specification/design changes. |
| Engineer / Reviewer | Inspection, handoff, and explicitly approved implementation workflow. |
| MCP agent | Only grant scopes, project restrictions, and expiry allow. |
| Reverse proxy | Authenticates UI users and strips client identity headers. |
| Local bridge | Holds one scoped upstream agent grant in the OS secret store. |
| Workspace Bridge | Reads only explicitly selected repositories and executes no unapproved changes. |
| Malicious user or compromised agent | Attempts cross-tenant access, destructive writes, data exfiltration, persistence, or resource exhaustion. |

The current MVP implements only coarse actor strings. It does not yet implement
the enterprise roles or scopes in this table.

## Trust boundaries

```mermaid
flowchart LR
    U["User browser"] --> P["HTTPS / trusted proxy"]
    P --> API["FormaSpec API"]
    A["Agent client"] --> LB["Local bridge"]
    LB --> API
    API --> DB[("Organization data")]
    API --> RW["Renderer worker"]
    RW -. "network denied" .-> X["External network"]
    WB["Workspace Bridge"] --> API
    WB --> R["Explicit local repository"]
```

Boundary rules:

- The proxy is trusted only from configured network ranges.
- The browser and agent are separate principals even when operated by one user.
- The renderer accepts only validated canonical snapshots and asset IDs over
  bounded IPC.
- The server does not receive arbitrary workstation filesystem paths.
- The Workspace Bridge never treats server text as permission to modify files.
- A task or handoff reference is data, not shell input.

## Threats and required treatment

| Threat | Current exposure/control | Required treatment and verification |
| --- | --- | --- |
| Forged proxy identity | Server mode validates configured proxy ranges, Host, Origin, CSRF intent, and identity presence; generated configs are fail-closed. Additional proxy-origin authentication hardening is in progress and is not yet final release evidence. | Prove the reverse proxy strips caller headers and add the full CIDR/direct-port deployment matrix after the current hardening work stabilizes. |
| Cross-project or cross-organization IDOR | Service-layer organization/project authorization covers design, asset, revision, preview, SSE, MCP, and enterprise services. | Complete the exhaustive role/scope/project ID matrix for every public route/resource. |
| Stolen or replayed MCP token | One-time pairing, hashed scoped/expiring grants, macOS Keychain, Linux Secret Service, Windows current-user DPAPI, last-use, reconnect, and immediate revocation exist. | Add real packaged cross-platform lifecycle tests, rotation policy, and broader replay fixtures. |
| CSRF against header/cookie UI identity | Server writes require trusted Origin and the configured CSRF intent header; local mode ignores caller identity. | Complete browser/proxy/cookie deployment tests across every mutating endpoint. |
| Preview/commit substitution | Base/result snapshot hashes, operation hash, engine versions, exact stored bytes, status, expiry, and transactional commit exist. | Extend restart/concurrency/fault-injection and corruption coverage. |
| Lost or phantom events | A persisted transactional outbox publishes after commit and supports replay/gap signals. | Add load, reconnect, retention, and publisher-crash operational tests. |
| Unauthorized destructive archive | Ordinary commits reject archive operations; archive requires its own preview and destructive commit path. | Complete negative tests across every client/tool input and approval annotation. |
| Revision tampering | Brotli snapshots use SHA-256 and revisions include a parent-linked hash chain plus immutable triggers. | Add operator verification/reporting and deliberate corruption fixtures. |
| Malicious design text instructs an agent | MCP instructions warn against it, but agents still consume untrusted text. | Explicit data envelopes, task policy, least-privilege tools, no automatic commit, and prompt-injection fixtures. |
| Renderer SSRF/data exfiltration | Docker uses a separate worker with `network_mode: none`; request interception and no-remote-URL schemas remain defense in depth. | Add automated canary egress tests, native-package boundary evidence, and server deployment verification. |
| Renderer escape/resource exhaustion | Worker runs as non-root with a read-only root, dropped capabilities, no-new-privileges, bounded IPC/queue, per-job context, cleanup, PID/memory/CPU/time limits, and API process isolation. Migration 11 persists only bounded API-owned job lifecycle metadata with leases/heartbeats and permit-guarded 30-day terminal retention; the worker remains database-free. | Add crash/recovery, queue saturation, malformed IPC, long-running stress, configurable retention operations/UI, and native sandbox evidence. |
| Image parser exploit or image bomb | The network-disabled pinned Chromium worker performs full decode, byte/pixel/output limits, animation/MPO rejection, EXIF orientation, metadata stripping, and deterministic PNG re-encoding under a new context per job. Backup creation/verification and restore preflight/cutover require the same worker-backed verifier. | Add a larger malformed-image corpus and upload-storm/queue evidence. |
| SVG/script injection | Uploaded SVG is currently rejected. | Preserve the prohibition for external input; lint bundled icons at build time. |
| Operation/payload denial of service | 500-operation and 1 MiB limits exist. Tree/layout complexity is not budgeted. | Per-tool strict schemas, depth/node/asset/export limits, CPU deadlines, rate policy, and 1,000-node budgets. |
| SQLite corruption, source swap, exhaustion, or partial restore | Online backup, bounded tar/checksums, strict V1/V2 semantic verification, descriptor-pinned sources/downloads, whole-workflow and per-step capacity checks, SQLite integrity/foreign-key checks, operation-aware orphan preservation, deterministic render smoke, safety backup, and externally supervised launcher-pinned Docker/server planned restore exist. Runtime binding verification rejects plugin, NFS, bind-backed, and aliased volumes; health has absolute deadlines; lock paths fail closed; and pre-cutover worker failures restart/verify the unchanged API. | The current capability is `HEALTHY_PLANNED_RESTORE_ONLY`; add a separately authorized offline disaster-recovery path, signed provenance, OS-native atomic no-replace cutover support, clean server supervision evidence, off-host policy, and full recovery E2E. |
| Backup theft | Backups contain designs, assets, identities, and potentially secrets. | Access control, encryption at rest by operator, secret exclusion, audit, retention, and destruction policy. |
| Archive/import traversal or memory exhaustion | Backup TAR and portable ZIP validation reject unsafe/duplicate paths, encryption, unsupported compression/features, non-regular entry types, local/central or descriptor/CRC mismatches, hidden trailing data, count/size excess, checksum gaps, and strict-schema/ID mismatches. Portable entries inflate independently in bounded 16 KiB chunks, and mutation is administrator-only, idempotent, conflict-aware, provenance-recorded, and covered for preserve-ID/clone, rollback, symlinks, descriptors, malformed streams, and decompression limits. | Stream multipart bodies without retaining all extracted entries simultaneously; add a larger adversarial/concurrent-import corpus and retained packaged cross-platform evidence. |
| Repository secret exfiltration | Workspace Bridge uses explicit expiring/revocable read-only grants, no symlink following, organization-policy exclusions persisted with the grant, bounded reads, workstation-only local paths, and automatic strict path-free persistence through REST or the authorized MCP bridge. | Expand secret fixtures and framework-aware mapping review, and prove across packaged platforms that local paths/content outside bounds never cross the boundary. |
| Unapproved repository modification | Workspace Bridge inventory grants are bound to the exact central inventory and approved handoff. The explicit `launch-codex` boundary revalidates policy/grant/handoff/inventory state, starts Codex with `shell: false`, exact repository `cwd`, one secret-free task reference, and a minimal environment, then monitors revocation. The central server remains shell-free. | Complete the broader approved plan/diff/validation/commit/PR workflow and packaged supervision; prove Windows Job Object/equivalent descendant containment. |
| Malicious custom URL | The UI issues allowlisted `formaspec://connect-agent` links with one-time expiring pairing nonces; grants/tokens are never placed in the URL. | Package and test strict OS protocol handlers, replay denial, malformed-link rejection, and user confirmation. |
| Supply-chain compromise | The exact pnpm version and lockfile are pinned. An offline deterministic CycloneDX 1.6 source-workspace SBOM, license/notice evidence, SHA-256 manifest, and fail-closed permissive-only policy gate exist. The earlier Sharp-free schema-10 source workspace passed with 342 third-party components and zero violations. Its unsigned macOS ARM64 candidate has checkpoint package integrity evidence but is stale relative to schema 11. Linux DEB/RPM and Windows WiX builders exist only as source foundations; no current target artifact is qualified. | Resolve the Chromium LGPL/legal-policy blocker; regenerate current schema-11 source evidence; generate artifact evidence for containers, Windows, Linux, and rebuilt macOS; add dependency/image/OS vulnerability and license scans, independent reproducibility, retained CI evidence, and real provenance/signing/notarization when credentials exist. |
| Malicious support bundle | A fixed allowlist, strict byte/file limits, deterministic archive/checksums, secret/private-path/token redaction, read-only preview, adjacent local manifest, and explicit `--yes` exist; databases/assets/backups/env values/source/credentials are excluded. | Add broader real-log fixtures, packaged cross-platform evidence, and operator review/audit policy. |

## Abuse cases

### Cross-tenant object ID

An authenticated user obtains a design, preview, revision, or asset ID from a
log, link, browser history, or guessed request and calls another endpoint. The
service now resolves organization/project access before design, preview,
revision, asset, SSE, MCP, export, and enterprise-service access. Release still
requires the exhaustive negative matrix for every route, role, grant scope,
project restriction, expiry, and revocation state.

### Preview race

Two clients preview from version N and commit concurrently. Exactly one may
advance the head. The loser must receive `VERSION_CONFLICT` without an inserted
revision, idempotency record for a false success, or published event. Exact
preview commit now performs CAS, revision/idempotency/audit/outbox insertion,
and preview status in one immediate transaction, then publishes committed
outbox state. Additional restart and injected-failure variance remains.

### Prompt-like product content

A frame, product requirement, or repository comment says to ignore policy,
archive data, reveal a token, or execute a command. Agents must treat it as
quoted untrusted data. Only the system workflow, explicit user approval, grant
scope, and typed tools determine authority.

### Renderer exfiltration

A malformed or future document field attempts to load a remote URL containing
project data. Schema rejection is the first defense. The renderer's network
namespace must independently deny the request so a schema regression cannot
become exfiltration.

### Bridge confused deputy

A server task names a local path or asks to run a command. The Workspace Bridge
must ignore server-provided paths unless they resolve to a locally approved
repository grant, and even then may only perform the approved stage. An
assessment or handoff is not permission to edit, commit, push, or open a PR.

## Security invariants to test continuously

1. Authentication success without authorization never grants object access.
2. Revoked or expired grants fail immediately, including existing SSE streams.
3. Every write is attributed to one principal and one organization/project.
4. Every accepted commit references exact validated snapshot bytes.
5. A rolled-back transaction emits no externally visible event.
6. No untrusted field is interpreted as HTML, CSS, JavaScript, URL, path, or
   shell input.
7. The renderer cannot reach the external network.
8. Backups restore into a clean location and reproduce hashes and assets.
9. Repository inspection precedes proposals; approved plans precede changes.
10. Secrets never enter logs, audit payloads, exports, tasks, or support bundles.

## Review triggers

Update this threat model whenever any of the following changes:

- authentication, proxy, organization, role, or agent-grant behavior;
- document/operation schemas or import/export formats;
- renderer, image decoder, browser, or font pipeline;
- MCP tools/resources/prompts or approval annotations;
- local bridge, Workspace Bridge, custom URL handler, or repository scanners;
- backup/restore, installer, automatic startup, update, or signing flow;
- new network destination, filesystem access, or external service.

Production release remains blocked while any critical/high finding is open or
while required security tests are absent.

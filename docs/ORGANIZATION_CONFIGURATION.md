# Organization configuration

Database foundations exist for organizations, principals, memberships, roles,
project ownership, policies, scoped agent grants, audit events, backup
schedules, and retention metadata. Existing data migrates into one legacy
organization and the local actor becomes Organization Administrator.

Roles are Organization Administrator, Product Manager, Design Editor,
Engineer, Viewer, and Agent. Agents are expiring, scoped machine identities and
may be restricted to project IDs.

The strict schema-version-1 policy now covers locales/direction, platforms and
presets, design-system/font/icon rules, assets, naming, accessibility, agents,
repositories, backups/retention, trusted identity role mappings, audit, and
exports. Organization Administrators can read/update it through REST and the
Administration JSON editor; agents read it through `organization_policy_read`
or `formaspec://organizations/current/policy`. Updates require the expected
configuration hash.

`organization.formaspec.yaml` is a secret-free export generated from the
validated database policy, never a credential store. Format-2 backups generate
and verify the same configuration against the staged database; historical
format-1 backups remain accepted. Policy is enforced for agent connection,
legacy MCP tokens, repositories, assets, backup scheduling/retention, and
portable bundle export/import.

The audit policy is executable through an Organization Administrator-only,
preview-first retention workflow. A preview fixes the current configuration
hash, policy hash, minimum 30-day cutoff, bounded candidate IDs, canonical-byte
hashes, and a 15-minute expiry. Each plan contains at most 2,000 audit rows and
2,000 published-outbox rows and at most 8 MiB of canonical evidence per kind;
conservative pre-sizing and a final exact-byte check prevent oversized
materialization. Commit revalidates that exact plan in one
immediate transaction, rejects policy or candidate drift, and uses a scoped
idempotency key. Only published outbox rows and audit rows strictly older than
the configured cutoff can be removed. Retention events and unpublished outbox
rows are never candidates. Policy-update provenance and pre-restore,
restore-commit, and restore-rollback recovery evidence are also retained
permanently because current fail-closed and crash-recovery behavior depends on
them. Each commit leaves an immutable SHA-256 chained run record plus a
retained `audit_retention.commit` audit event and `audit.retention` durable
event; temporary database delete permits are removed inside the same
transaction.

REST endpoints are
`POST /api/organization/audit-retention/previews`,
`POST /api/organization/audit-retention/previews/:previewId/commit`, and
`GET /api/organization/audit-retention/runs`. The equivalent operator commands
are `formaspecctl audit retention preview`,
`formaspecctl audit retention list`, and the explicitly authorized
`formaspecctl audit retention execute ... --yes`. This destructive
organization-administration capability is deliberately not exposed through
agent MCP tools. Complete form-based administration, delegated policy roles,
and policy migration UX remain future work.

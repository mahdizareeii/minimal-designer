import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { DomainError } from "./errors.js";
import type { DesignerEventType } from "./events.js";
import { loadOrganizationPolicy } from "./organization-policy-model.js";

export type OrganizationRole = "organization_admin" | "product_manager" | "design_editor" | "engineer" | "viewer" | "agent";

export interface AccessContext {
  actorId: string;
  principalId: string;
  organizationId: string;
  role: OrganizationRole;
  scopes: string[];
  projectIds: string[];
  grantId?: string;
}

const LEGACY_ORGANIZATION_ID = "organization_legacy";
const LEGACY_ENVIRONMENT_AGENT_SCOPES = [
  "organization_policy:read",
  "design:read",
  "design:preview",
  "design:write",
  "task:read",
  "task:claim",
  "task:update",
] as const;

function principalIdForActor(actorId: string): string {
  if (actorId === "local") return "principal_local";
  return `principal_${createHash("sha256").update(actorId).digest("hex").slice(0, 24)}`;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Report one fail-closed authorization error below.
  }
  throw new DomainError("AUTH_REQUIRED", "The agent grant has invalid authorization metadata.", 401);
}

export function resolveAccess(sqlite: Database.Database, actorId: string): AccessContext {
  if (actorId.startsWith("session:")) {
    const parts = actorId.split(":");
    const sessionId = parts[1] ?? "";
    const principalId = parts[2] ?? "";
    if (parts.length !== 3
      || !/^session_[A-Za-z0-9_-]{8,180}$/.test(sessionId)
      || !/^principal_[A-Za-z0-9_-]{8,180}$/.test(principalId)) {
      throw new DomainError("AUTH_REQUIRED", "The browser session principal is invalid.", 401);
    }
    const now = new Date().toISOString();
    const row = sqlite.prepare(
      `SELECT p.organization_id, p.disabled_at, m.role
       FROM browser_sessions s
       JOIN principals p ON p.id = s.principal_id AND p.organization_id = s.organization_id
       JOIN memberships m ON m.organization_id = p.organization_id AND m.principal_id = p.id
       WHERE s.id = ? AND s.principal_id = ?
         AND s.revoked_at IS NULL AND s.idle_expires_at > ? AND s.expires_at > ?
         AND p.kind = 'human'`,
    ).get(sessionId, principalId, now, now) as {
      organization_id: string;
      disabled_at: string | null;
      role: OrganizationRole;
    } | undefined;
    if (!row || row.disabled_at) {
      throw new DomainError("AUTH_REQUIRED", "The browser session principal is disabled or unavailable.", 401);
    }
    return {
      actorId,
      principalId,
      organizationId: row.organization_id,
      role: row.role,
      scopes: ["*"],
      projectIds: [],
    };
  }

  if (actorId.startsWith("grant_")) {
    const now = new Date().toISOString();
    const row = sqlite.prepare(
      `SELECT g.id, g.organization_id, g.principal_id, g.scopes_json, g.project_ids_json,
              g.expires_at, g.revoked_at, p.disabled_at, m.role,
              EXISTS (
                SELECT 1 FROM agent_connections c
                WHERE c.organization_id = g.organization_id
                  AND c.principal_id = g.principal_id
                  AND c.status = 'active'
                  AND (c.expires_at IS NULL OR c.expires_at > ?)
              ) AS connection_active,
              (
                SELECT c.adapter FROM agent_connections c
                WHERE c.organization_id = g.organization_id
                  AND c.principal_id = g.principal_id
                  AND c.status = 'active'
                  AND (c.expires_at IS NULL OR c.expires_at > ?)
                ORDER BY c.updated_at DESC, c.id DESC LIMIT 1
              ) AS connection_adapter
       FROM agent_grants g
       JOIN principals p ON p.id = g.principal_id AND p.organization_id = g.organization_id
       JOIN memberships m ON m.organization_id = g.organization_id AND m.principal_id = g.principal_id
       WHERE g.id = ?`,
    ).get(now, now, actorId.slice("grant_".length)) as {
      id: string;
      organization_id: string;
      principal_id: string;
      scopes_json: string;
      project_ids_json: string;
      expires_at: string;
      revoked_at: string | null;
      disabled_at: string | null;
      role: OrganizationRole;
      connection_active: number;
      connection_adapter: "codex" | "generic_mcp" | null;
    } | undefined;
    if (!row || row.revoked_at || row.disabled_at || row.expires_at <= now || row.connection_active !== 1) {
      throw new DomainError("AUTH_REQUIRED", "The agent grant is expired, revoked, or unavailable.", 401);
    }
    const scopes = parseJsonArray(row.scopes_json);
    const projectIds = parseJsonArray(row.project_ids_json);
    const policy = loadOrganizationPolicy(sqlite, row.organization_id).policy;
    const policyAllowsGrant = policy.agents.enabled
      && row.connection_adapter !== null
      && policy.agents.allowedAdapters.includes(row.connection_adapter)
      && scopes.every((scope) => policy.agents.allowedScopes.includes(
        scope as (typeof policy.agents.allowedScopes)[number],
      ))
      && (!policy.agents.requireProjectRestriction || projectIds.length > 0);
    if (!policyAllowsGrant) {
      throw new DomainError("AUTH_REQUIRED", "The agent grant is no longer permitted by organization policy.", 401);
    }
    return {
      actorId,
      principalId: row.principal_id,
      organizationId: row.organization_id,
      role: row.role,
      scopes,
      projectIds,
      grantId: row.id,
    };
  }

  const principalId = principalIdForActor(actorId);
  const agent = actorId.startsWith("usr_");
  const trustedIdentity = actorId.startsWith("trusted:") ? actorId.slice("trusted:".length) : null;
  const loadedPolicy = loadOrganizationPolicy(sqlite, LEGACY_ORGANIZATION_ID);
  const mappedRole = trustedIdentity === null ? undefined : loadedPolicy.policy.identity.roleMappings.find(
    (mapping) => ["identity", "external_id", "trusted_user"].includes(mapping.claim.toLowerCase())
      && mapping.value === trustedIdentity,
  )?.role;
  const existingNonLocalPrincipals = trustedIdentity === null ? 0 : (sqlite.prepare(
    `SELECT COUNT(*) AS count FROM principals
     WHERE organization_id = ? AND kind <> 'local'`,
  ).get(LEGACY_ORGANIZATION_ID) as { count: number }).count;
  const existingTrustedMembership = trustedIdentity === null ? undefined : sqlite.prepare(
    `SELECT m.role FROM principals p
     JOIN memberships m ON m.organization_id = p.organization_id AND m.principal_id = p.id
     WHERE p.id = ? AND p.organization_id = ? AND p.disabled_at IS NULL`,
  ).get(principalId, LEGACY_ORGANIZATION_ID) as { role: OrganizationRole } | undefined;
  const bootstrapTrustedAdmin = trustedIdentity !== null
    && (loadedPolicy.source === "default" || loadedPolicy.source === "legacy_quarantined")
    && (existingNonLocalPrincipals === 0
      || existingTrustedMembership?.role === "organization_admin");
  if (trustedIdentity !== null && !mappedRole && !bootstrapTrustedAdmin) {
    throw new DomainError("AUTH_REQUIRED", "The trusted identity is not mapped by organization policy.", 401);
  }
  const defaultRole: OrganizationRole = actorId === "local"
    ? "organization_admin"
    : agent
      ? "agent"
      : mappedRole ?? (bootstrapTrustedAdmin ? "organization_admin" : "design_editor");
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT OR IGNORE INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(principalId, LEGACY_ORGANIZATION_ID, actorId === "local" ? "local" : agent ? "agent" : "human", actorId, actorId, now);
  sqlite.prepare(
    `INSERT OR IGNORE INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(LEGACY_ORGANIZATION_ID, principalId, defaultRole, now);
  if (mappedRole) {
    sqlite.prepare(
      "UPDATE memberships SET role = ? WHERE organization_id = ? AND principal_id = ? AND role <> ?",
    ).run(mappedRole, LEGACY_ORGANIZATION_ID, principalId, mappedRole);
  }
  const row = sqlite.prepare(
    `SELECT p.organization_id, p.disabled_at, p.created_at, m.role
     FROM principals p JOIN memberships m ON m.principal_id = p.id AND m.organization_id = p.organization_id
     WHERE p.id = ?`,
  ).get(principalId) as {
    organization_id: string;
    disabled_at: string | null;
    created_at: string;
    role: OrganizationRole;
  } | undefined;
  if (!row || row.disabled_at) throw new DomainError("AUTH_REQUIRED", "The principal is disabled or unavailable.", 401);
  let scopes: string[] = ["*"];
  if (agent) {
    const agentPolicy = loadedPolicy.policy.agents;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(row.created_at)) / 1_000));
    const activeConnections = sqlite.prepare(
      `SELECT COUNT(*) AS count FROM agent_connections
       WHERE organization_id = ? AND status IN ('pending', 'active')
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(row.organization_id, now) as { count: number };
    if (!agentPolicy.enabled
      || !agentPolicy.allowLegacyEnvironmentToken
      || !agentPolicy.allowedAdapters.includes("generic_mcp")
      || agentPolicy.requireProjectRestriction
      || ageSeconds >= agentPolicy.maximumExpirySeconds
      || activeConnections.count >= agentPolicy.maximumActiveConnections) {
      throw new DomainError("AUTH_REQUIRED", "The legacy environment MCP token is not permitted by organization policy.", 401);
    }
    scopes = LEGACY_ENVIRONMENT_AGENT_SCOPES.filter((scope) => agentPolicy.allowedScopes.includes(scope));
    if (scopes.length === 0) {
      throw new DomainError("AUTH_REQUIRED", "The legacy environment MCP token has no policy-approved scopes.", 401);
    }
  }
  return {
    actorId,
    principalId,
    organizationId: row.organization_id,
    role: row.role,
    scopes,
    projectIds: [],
  };
}

export function assertProjectAccess(access: AccessContext, organizationId: string, designId: string): void {
  if (organizationId !== access.organizationId) throw new DomainError("NOT_FOUND", "Design not found.", 404);
  if (access.projectIds.length > 0 && !access.projectIds.includes(designId)) throw new DomainError("NOT_FOUND", "Design not found.", 404);
}

export function assertScope(access: AccessContext, scope: string): void {
  if (access.scopes.includes("*") || access.scopes.includes(scope)) return;
  throw new DomainError("FORBIDDEN", `The principal does not have scope ${scope}.`, 403);
}

export function assertDesignWrite(access: AccessContext): void {
  if (["organization_admin", "product_manager", "design_editor", "agent"].includes(access.role)) {
    if (access.role === "agent") assertScope(access, "design:write");
    return;
  }
  throw new DomainError("FORBIDDEN", "The current role cannot modify designs.", 403);
}

function boundedString(value: unknown, maximumLength: number, pattern?: RegExp): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return undefined;
  if (pattern && !pattern.test(value)) return undefined;
  return value;
}

function boundedNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedRetention(value: unknown): { daily: number; weekly: number; monthly: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const daily = boundedNonNegativeInteger(record.daily);
  const weekly = boundedNonNegativeInteger(record.weekly);
  const monthly = boundedNonNegativeInteger(record.monthly);
  if (daily === undefined || weekly === undefined || monthly === undefined) return undefined;
  if (daily > 3_650 || weekly > 520 || monthly > 120) return undefined;
  return { daily, weekly, monthly };
}

function boundedBackupEventDetails(action: string, details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const addInteger = (key: string, sourceKey = key) => {
    const value = boundedNonNegativeInteger(details[sourceKey]);
    if (value !== undefined) result[key] = value;
  };
  const addString = (key: string, maximumLength: number, pattern?: RegExp, sourceKey = key) => {
    const value = boundedString(details[sourceKey], maximumLength, pattern);
    if (value !== undefined) result[key] = value;
  };
  const addRetention = () => {
    const retention = boundedRetention(details.retention);
    if (retention) result.retention = retention;
  };
  const addBackupCount = () => {
    if (Array.isArray(details.backupIds)) result.backupCount = Math.min(details.backupIds.length, 20_000);
  };
  const addRetentionClass = () => addString(
    "retentionClass",
    16,
    /^(manual|daily|weekly|monthly)$/,
  );
  const addIsoTime = (key: string) => addString(
    key,
    40,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  );
  const addScheduleRun = () => {
    addString("runId", 52, /^backup_schedule_run_[a-f0-9]{32}$/);
    addIsoTime("dueAt");
    addIsoTime("nextDueAt");
    addIsoTime("startedAt");
    addIsoTime("completedAt");
  };

  switch (action) {
    case "backup.create":
      addInteger("entryCount");
      addRetentionClass();
      addIsoTime("scheduleWindow");
      break;
    case "backup.verify":
      addInteger("entryCount");
      break;
    case "backup.verify_failed":
      addString("code", 64, /^[A-Z][A-Z0-9_]*$/);
      break;
    case "backup.schedule_update":
      if (typeof details.enabled === "boolean") result.enabled = details.enabled;
      addString("cronExpression", 32, /^\d{1,2} \d{1,2} \* \* \*$/);
      if (details.timezone === "UTC") result.timezone = "UTC";
      addRetention();
      break;
    case "backup.schedule_run_started":
      addScheduleRun();
      break;
    case "backup.schedule_run":
      addScheduleRun();
      addString("status", 24, /^(created|already_completed)$/);
      addRetentionClass();
      break;
    case "backup.schedule_run_failed":
      addScheduleRun();
      addString("errorCode", 64, /^[A-Z][A-Z0-9_]*$/);
      if (typeof details.retryable === "boolean") result.retryable = details.retryable;
      break;
    case "backup.prune_preview":
      addString("planHash", 64, /^[a-f0-9]{64}$/);
      addBackupCount();
      addInteger("totalCandidateBytes");
      addIsoTime("expiresAt");
      addRetention();
      break;
    case "backup.prune_commit":
      addString("planHash", 64, /^[a-f0-9]{64}$/);
      addBackupCount();
      addInteger("prunedBytes");
      addRetention();
      break;
    case "backup.prune_cleanup_pending":
      addBackupCount();
      break;
    case "backup.download":
      addInteger("sizeBytes");
      break;
    case "backup.download_rejected":
      addString("reason", 64, /^[a-z][a-z0-9_]*$/);
      break;
    case "backup.pre_restore_create":
      addString("operationId", 120, /^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
      addString("targetBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addString("safetyBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addInteger("sizeBytes");
      break;
    case "backup.restore_commit":
      addString("operationId", 120, /^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
      addString("targetBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addString("safetyBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addInteger("schemaVersion");
      addInteger("revokedGrants");
      addInteger("revokedConnections");
      addInteger("revokedNonces");
      addInteger("revokedBrowserSessions");
      break;
    case "backup.restore_rolled_back":
      addString("operationId", 120, /^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
      addString("targetBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addString("safetyBackupId", 47, /^backup_[a-f0-9]{40}$/);
      addString("errorCode", 64, /^[A-Z][A-Z0-9_]*$/);
      break;
    default:
      // Future backup operations still notify clients without copying unknown
      // audit details into the broadly consumed event stream.
      break;
  }
  return result;
}

function boundedBackupAction(action: string): string {
  return boundedString(action, 120, /^backup\.[a-z0-9_.-]+$/) ?? "backup.unknown";
}

function boundedEventTarget(value: string, maximumLength: number): string | null {
  return boundedString(value, maximumLength, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/) ?? null;
}

export function appendAuditEvent(
  sqlite: Database.Database,
  access: AccessContext,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): number {
  const result = sqlite.prepare(
    `INSERT INTO audit_events (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(access.organizationId, access.principalId, action, targetType, targetId, JSON.stringify(details), new Date().toISOString());
  const auditEventId = Number(result.lastInsertRowid);
  const domainEventType: DesignerEventType | null = action.startsWith("design_system.")
    ? "design_system.changed"
    : action.startsWith("organization_policy.")
      ? "organization_policy.changed"
      : action.startsWith("repository_inventory.")
        ? "repository_inventory.changed"
        : action.startsWith("implementation_mapping.")
          ? "implementation_mapping.changed"
        : action.startsWith("handoff.")
          ? "handoff.transitioned"
          : action.startsWith("redesign.")
            ? "redesign.transitioned"
            : action.startsWith("backup.")
              ? "backup.operation"
              : action.startsWith("audit_retention.")
                ? "audit.retention"
                : null;
  if (domainEventType) {
    let designId = typeof details.designId === "string" ? details.designId : null;
    if (!designId && targetType === "design" && targetId) designId = targetId;
    if (!designId && targetId && targetType === "handoff") {
      const row = sqlite.prepare("SELECT design_id FROM handoffs WHERE id = ?").get(targetId) as { design_id: string } | undefined;
      designId = row?.design_id ?? null;
    }
    if (!designId && targetId && targetType === "redesign_assessment") {
      const row = sqlite.prepare("SELECT design_id FROM redesign_assessments WHERE id = ?").get(targetId) as { design_id: string | null } | undefined;
      designId = row?.design_id ?? null;
    }
    const createdAt = new Date().toISOString();
    const eventPayload = domainEventType === "backup.operation"
      ? {
        auditEventId,
        action: boundedBackupAction(action),
        targetType: boundedEventTarget(targetType, 80) ?? "backup",
        targetId: targetId === null ? null : boundedEventTarget(targetId, 240),
        details: boundedBackupEventDetails(action, details),
      }
      : {
        auditEventId,
        action,
        targetType,
        targetId,
        ...(designId ? { designId } : {}),
        details,
      };
    sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(access.organizationId, access.actorId, domainEventType, JSON.stringify(eventPayload), createdAt);
  }
  return auditEventId;
}

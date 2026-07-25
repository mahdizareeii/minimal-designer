export const PROTECTED_NON_MCP_ROUTE_FAMILIES = [
  "core_design",
  "product_spec_and_agents",
  "enterprise_domain",
  "portable_and_backup",
  "organization_policy",
  "maintenance",
] as const;

export type ProtectedNonMcpRouteFamily = (typeof PROTECTED_NON_MCP_ROUTE_FAMILIES)[number];

export const PROTECTED_NON_MCP_AUTHORIZATION_CLASSES = [
  "authenticated_project",
  "authenticated_organization",
  "pairing_nonce",
  "self_authorization_context",
  "authenticated_static_capabilities",
  "maintenance_status",
  "sse",
] as const;

export type ProtectedNonMcpAuthorizationClass =
  (typeof PROTECTED_NON_MCP_AUTHORIZATION_CLASSES)[number];

export const PROTECTED_NON_MCP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ProtectedNonMcpMethod = (typeof PROTECTED_NON_MCP_METHODS)[number];
export type ProtectedNonMcpRouteKey = `${ProtectedNonMcpMethod} ${string}`;

export interface ProtectedNonMcpRouteContractDefinition {
  method: ProtectedNonMcpMethod;
  path: string;
  family: ProtectedNonMcpRouteFamily;
  authorization: ProtectedNonMcpAuthorizationClass;
}

export interface ProtectedNonMcpRouteContract extends ProtectedNonMcpRouteContractDefinition {
  key: ProtectedNonMcpRouteKey;
}

/**
 * These surfaces are intentionally outside the protected non-MCP route
 * contract. Health and browser-authentication endpoints have their own narrow
 * executable contracts, and MCP has a separate tool/resource contract matrix.
 */
export const PROTECTED_NON_MCP_ROUTE_EXCLUSIONS = Object.freeze({
  health: Object.freeze(["/health", "/health/live", "/ready", "/health/ready", "/health/render"]),
  authentication: Object.freeze([
    "/api/auth/status",
    "/api/auth/bootstrap",
    "/api/auth/login",
    "/api/auth/session",
    "/api/auth/logout",
  ]),
  mcp: Object.freeze(["/mcp"]),
});

const protectedMethodSet = new Set<string>(PROTECTED_NON_MCP_METHODS);

export function normalizeRoutePath(value: string): string {
  const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
  const leadingSlash = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  const collapsed = leadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function isHealthContractExclusion(path: string): boolean {
  return path === "/ready"
    || path.startsWith("/ready/")
    || path === "/health"
    || path.startsWith("/health/");
}

function isMcpContractExclusion(path: string): boolean {
  return path === "/mcp" || path.startsWith("/mcp/");
}

function isAuthenticationContractExclusion(path: string): boolean {
  return path === "/api/auth" || path.startsWith("/api/auth/");
}

export function isProtectedNonMcpRoute(method: string, path: string): method is ProtectedNonMcpMethod {
  const normalizedMethod = method.toUpperCase();
  if (!protectedMethodSet.has(normalizedMethod)) return false;
  const normalizedPath = normalizeRoutePath(path);
  if (isHealthContractExclusion(normalizedPath)
    || isAuthenticationContractExclusion(normalizedPath)
    || isMcpContractExclusion(normalizedPath)) return false;
  return normalizedPath === "/api"
    || normalizedPath.startsWith("/api/")
    || normalizedPath === "/events"
    || normalizedPath.startsWith("/events/");
}

export function protectedNonMcpRouteKey(
  method: ProtectedNonMcpMethod,
  path: string,
): ProtectedNonMcpRouteKey {
  return `${method} ${normalizeRoutePath(path)}`;
}

export function defineProtectedNonMcpRouteContracts(
  definitions: readonly ProtectedNonMcpRouteContractDefinition[],
): ReadonlyMap<ProtectedNonMcpRouteKey, ProtectedNonMcpRouteContract> {
  const contracts = new Map<ProtectedNonMcpRouteKey, ProtectedNonMcpRouteContract>();
  for (const definition of definitions) {
    const normalizedPath = normalizeRoutePath(definition.path);
    if (!isProtectedNonMcpRoute(definition.method, normalizedPath)) {
      throw new Error(`Route contract is outside the protected non-MCP surface: ${definition.method} ${normalizedPath}`);
    }
    const key = protectedNonMcpRouteKey(definition.method, normalizedPath);
    if (contracts.has(key)) throw new Error(`Duplicate protected non-MCP route contract: ${key}`);
    contracts.set(key, Object.freeze({ ...definition, path: normalizedPath, key }));
  }
  return contracts;
}

export function collectProtectedNonMcpRouteRegistration(
  target: Set<ProtectedNonMcpRouteKey>,
  method: string | readonly string[],
  path: string,
): void {
  const methods = Array.isArray(method) ? method : [method];
  for (const candidate of methods) {
    const normalizedMethod = candidate.toUpperCase();
    if (!isProtectedNonMcpRoute(normalizedMethod, path)) continue;
    const key = protectedNonMcpRouteKey(normalizedMethod, path);
    if (target.has(key)) throw new Error(`Duplicate protected non-MCP route registration: ${key}`);
    target.add(key);
  }
}

const project = (
  family: ProtectedNonMcpRouteFamily,
  method: ProtectedNonMcpMethod,
  path: string,
): ProtectedNonMcpRouteContractDefinition => ({
  method,
  path,
  family,
  authorization: "authenticated_project",
});

const organization = (
  family: ProtectedNonMcpRouteFamily,
  method: ProtectedNonMcpMethod,
  path: string,
): ProtectedNonMcpRouteContractDefinition => ({
  method,
  path,
  family,
  authorization: "authenticated_organization",
});

const exception = (
  family: ProtectedNonMcpRouteFamily,
  method: ProtectedNonMcpMethod,
  path: string,
  authorization: Exclude<
    ProtectedNonMcpAuthorizationClass,
    "authenticated_project" | "authenticated_organization"
  >,
): ProtectedNonMcpRouteContractDefinition => ({ method, path, family, authorization });

export const PROTECTED_NON_MCP_ROUTE_CONTRACTS = defineProtectedNonMcpRouteContracts([
  organization("core_design", "GET", "/api/designs"),
  organization("core_design", "POST", "/api/designs"),
  project("core_design", "GET", "/api/designs/:id"),
  project("core_design", "POST", "/api/designs/:id/archive"),
  project("core_design", "POST", "/api/designs/:id/restore-archive"),
  project("core_design", "POST", "/api/designs/:id/previews"),
  project("core_design", "GET", "/api/designs/:id/previews/:previewId"),
  project("core_design", "POST", "/api/designs/:id/previews/:previewId/commit"),
  project("core_design", "POST", "/api/designs/:id/archive-previews"),
  project("core_design", "POST", "/api/designs/:id/archive-previews/:previewId/commit"),
  project("core_design", "POST", "/api/designs/:id/revisions"),
  project("core_design", "POST", "/api/designs/:id/migrations/v2"),
  project("core_design", "GET", "/api/designs/:id/history"),
  project("core_design", "GET", "/api/projects/:projectId/revisions/:revisionId/inspect"),
  project("core_design", "POST", "/api/designs/:id/restore"),
  project("core_design", "GET", "/api/designs/:id/export"),
  project("core_design", "GET", "/api/designs/:id/render.png"),
  project("core_design", "GET", "/api/designs/:id/previews/:previewId/render.png"),
  organization("core_design", "GET", "/api/context"),
  organization("core_design", "PUT", "/api/context"),
  exception("core_design", "GET", "/events", "sse"),
  exception("core_design", "GET", "/api/events", "sse"),
  organization("core_design", "POST", "/api/assets"),
  organization("core_design", "GET", "/api/assets/:id"),
  organization("core_design", "GET", "/api/products"),
  organization("core_design", "POST", "/api/products"),
  organization("core_design", "GET", "/api/products/:productId"),
  organization("core_design", "PATCH", "/api/products/:productId"),
  organization("core_design", "POST", "/api/products/:productId/archive"),
  organization("core_design", "POST", "/api/products/:productId/restore"),
  organization("core_design", "POST", "/api/products/:productId/design-move-previews"),
  organization("core_design", "GET", "/api/product-move-previews/:previewId"),
  organization("core_design", "POST", "/api/product-move-previews/:previewId/commit"),

  project("product_spec_and_agents", "GET", "/api/designs/:id/product-specification"),
  project("product_spec_and_agents", "GET", "/api/designs/:id/product-specification/history"),
  project("product_spec_and_agents", "POST", "/api/designs/:id/product-specification/previews"),
  project("product_spec_and_agents", "GET", "/api/designs/:id/product-specification/previews/:previewId"),
  project("product_spec_and_agents", "POST", "/api/designs/:id/product-specification/previews/:previewId/commit"),
  project("product_spec_and_agents", "GET", "/api/designs/:id/planning-sessions"),
  project("product_spec_and_agents", "POST", "/api/designs/:id/planning-sessions"),
  project("product_spec_and_agents", "GET", "/api/planning-sessions/:sessionId"),
  project("product_spec_and_agents", "POST", "/api/planning-sessions/:sessionId/answers"),
  project("product_spec_and_agents", "POST", "/api/planning-sessions/:sessionId/transition"),
  project("product_spec_and_agents", "GET", "/api/designs/:id/agent-tasks"),
  project("product_spec_and_agents", "POST", "/api/designs/:id/agent-tasks"),
  organization("product_spec_and_agents", "GET", "/api/agent-tasks"),
  project("product_spec_and_agents", "GET", "/api/agent-tasks/:taskId"),
  project("product_spec_and_agents", "POST", "/api/agent-tasks/:taskId/claim"),
  project("product_spec_and_agents", "POST", "/api/agent-tasks/:taskId/transition"),
  exception(
    "product_spec_and_agents",
    "GET",
    "/api/agent-authorization-context",
    "self_authorization_context",
  ),
  organization("product_spec_and_agents", "GET", "/api/agent-connections"),
  organization("product_spec_and_agents", "POST", "/api/agent-connections"),
  exception("product_spec_and_agents", "POST", "/api/agent-connections/pair", "pairing_nonce"),
  organization("product_spec_and_agents", "POST", "/api/agent-connections/:connectionId/reconnect"),
  organization("product_spec_and_agents", "POST", "/api/agent-connections/:connectionId/revoke"),

  organization("enterprise_domain", "GET", "/api/design-systems"),
  organization("enterprise_domain", "POST", "/api/design-systems"),
  organization("enterprise_domain", "GET", "/api/design-systems/:designSystemId"),
  organization("enterprise_domain", "PATCH", "/api/design-systems/:designSystemId"),
  organization("enterprise_domain", "POST", "/api/design-systems/:designSystemId/tokens"),
  organization("enterprise_domain", "POST", "/api/design-systems/:designSystemId/components"),
  organization("enterprise_domain", "GET", "/api/design-systems/:designSystemId/components"),
  organization(
    "enterprise_domain",
    "POST",
    "/api/design-systems/:designSystemId/components/:componentId/lifecycle",
  ),
  organization("enterprise_domain", "GET", "/api/design-systems/:designSystemId/releases"),
  organization("enterprise_domain", "POST", "/api/design-systems/:designSystemId/releases"),
  organization("enterprise_domain", "GET", "/api/design-system-releases/:releaseId"),
  project(
    "enterprise_domain",
    "GET",
    "/api/projects/:projectId/revisions/:revisionId/design-system-release",
  ),
  project("enterprise_domain", "GET", "/api/designs/:id/design-system-pin"),
  project("enterprise_domain", "PUT", "/api/designs/:id/design-system-pin"),
  project("enterprise_domain", "POST", "/api/designs/:id/design-system-upgrade-previews"),
  project("enterprise_domain", "GET", "/api/designs/:id/component-library"),
  project("enterprise_domain", "POST", "/api/designs/:id/component-insertion-previews"),
  project("enterprise_domain", "GET", "/api/design-system-upgrade-previews/:previewId"),
  project("enterprise_domain", "POST", "/api/design-system-upgrade-previews/:previewId/commit"),
  organization("enterprise_domain", "GET", "/api/repository-inventories"),
  organization("enterprise_domain", "POST", "/api/repository-inventories"),
  organization("enterprise_domain", "GET", "/api/repository-inventories/:inventoryId"),
  organization("enterprise_domain", "POST", "/api/repository-inventories/:inventoryId/revoke"),
  project("enterprise_domain", "GET", "/api/designs/:id/implementation-mappings"),
  project("enterprise_domain", "POST", "/api/designs/:id/implementation-mappings"),
  project("enterprise_domain", "GET", "/api/implementation-mappings/:mappingId"),
  project("enterprise_domain", "GET", "/api/designs/:id/handoffs"),
  project("enterprise_domain", "POST", "/api/designs/:id/handoffs"),
  project("enterprise_domain", "GET", "/api/handoffs/:handoffId"),
  project("enterprise_domain", "PUT", "/api/handoffs/:handoffId"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/submit-review"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/return-draft"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/approve"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/start-implementation"),
  project("enterprise_domain", "GET", "/api/handoffs/:handoffId/execution-decisions"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/execution-decisions"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/complete"),
  project("enterprise_domain", "POST", "/api/handoffs/:handoffId/cancel"),
  organization("enterprise_domain", "GET", "/api/redesign-assessments"),
  organization("enterprise_domain", "POST", "/api/redesign-assessments"),
  organization("enterprise_domain", "GET", "/api/redesign-assessments/:assessmentId"),
  organization("enterprise_domain", "GET", "/api/redesign-assessments/:assessmentId/stages/:stage/artifact"),
  organization("enterprise_domain", "PUT", "/api/redesign-assessments/:assessmentId/stages/:stage/artifact"),
  organization("enterprise_domain", "PATCH", "/api/redesign-assessments/:assessmentId/current-stage"),
  organization("enterprise_domain", "POST", "/api/redesign-assessments/:assessmentId/transition"),
  exception(
    "enterprise_domain",
    "GET",
    "/api/enterprise-domain-capabilities",
    "authenticated_static_capabilities",
  ),

  project("portable_and_backup", "POST", "/api/designs/:id/conflict-recovery/duplicate"),
  project("portable_and_backup", "GET", "/api/designs/:id/export.formaspec.zip"),
  project("portable_and_backup", "GET", "/api/designs/:id/tokens/export/:target"),
  organization("portable_and_backup", "POST", "/api/imports/validate"),
  organization("portable_and_backup", "POST", "/api/imports"),
  organization("portable_and_backup", "GET", "/api/backups"),
  organization("portable_and_backup", "POST", "/api/backups"),
  organization("portable_and_backup", "POST", "/api/backups/imports/validate"),
  organization("portable_and_backup", "POST", "/api/backups/imports"),
  organization("portable_and_backup", "GET", "/api/backups/schedule"),
  organization("portable_and_backup", "PUT", "/api/backups/schedule"),
  organization("portable_and_backup", "POST", "/api/backups/schedule/run"),
  organization("portable_and_backup", "POST", "/api/backups/prune/previews"),
  organization("portable_and_backup", "POST", "/api/backups/prune/previews/:previewId/commit"),
  organization("portable_and_backup", "POST", "/api/backups/:backupId/verify"),
  organization("portable_and_backup", "GET", "/api/backups/:backupId/download"),

  organization("organization_policy", "GET", "/api/organization/policy"),
  organization("organization_policy", "PUT", "/api/organization/policy"),
  organization("organization_policy", "GET", "/api/organization/configuration"),
  organization("organization_policy", "POST", "/api/organization/audit-retention/previews"),
  organization(
    "organization_policy",
    "POST",
    "/api/organization/audit-retention/previews/:previewId/commit",
  ),
  organization("organization_policy", "GET", "/api/organization/audit-retention/runs"),

  exception("maintenance", "GET", "/api/maintenance/status", "maintenance_status"),
]);

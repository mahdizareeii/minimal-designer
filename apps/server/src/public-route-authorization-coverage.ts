import {
  PROTECTED_NON_MCP_ROUTE_CONTRACTS,
  protectedNonMcpRouteKey,
  type ProtectedNonMcpAuthorizationClass,
  type ProtectedNonMcpMethod,
  type ProtectedNonMcpRouteFamily,
  type ProtectedNonMcpRouteKey,
} from "./public-route-contract.js";

interface DirectAuthorizationEvidenceDefinition {
  method: ProtectedNonMcpMethod;
  path: string;
  testFile: string;
}

export interface DirectAuthorizationRouteEvidence extends DirectAuthorizationEvidenceDefinition {
  key: ProtectedNonMcpRouteKey;
  family: ProtectedNonMcpRouteFamily;
  authorization: ProtectedNonMcpAuthorizationClass;
}

type RouteTuple = readonly [method: ProtectedNonMcpMethod, path: string];

function evidence(testFile: string, routes: readonly RouteTuple[]): DirectAuthorizationEvidenceDefinition[] {
  return routes.map(([method, path]) => ({ method, path, testFile }));
}

const definitions: DirectAuthorizationEvidenceDefinition[] = [
  ...evidence("apps/server/src/planning-agent-opaque-id-http-authorization.test.ts", [
    ["GET", "/api/planning-sessions/:sessionId"],
    ["POST", "/api/planning-sessions/:sessionId/answers"],
    ["POST", "/api/planning-sessions/:sessionId/transition"],
    ["GET", "/api/agent-tasks/:taskId"],
    ["POST", "/api/agent-tasks/:taskId/claim"],
    ["POST", "/api/agent-tasks/:taskId/transition"],
  ]),
  ...evidence("apps/server/src/design-system-opaque-id-http.test.ts", [
    ["GET", "/api/design-system-releases/:releaseId"],
    ["GET", "/api/design-system-upgrade-previews/:previewId"],
    ["POST", "/api/design-system-upgrade-previews/:previewId/commit"],
  ]),
  ...evidence("apps/server/src/design-system-revision-release-authorization.test.ts", [
    ["GET", "/api/projects/:projectId/revisions/:revisionId/design-system-release"],
  ]),
  ...evidence("apps/server/src/product-specification-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/product-specification"],
    ["POST", "/api/designs/:id/product-specification/previews"],
    ["GET", "/api/designs/:id/product-specification/previews/:previewId"],
    ["POST", "/api/designs/:id/product-specification/previews/:previewId/commit"],
  ]),
  ...evidence("apps/server/src/handoff-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/handoffs"],
    ["POST", "/api/designs/:id/handoffs"],
    ["GET", "/api/handoffs/:handoffId"],
    ["PUT", "/api/handoffs/:handoffId"],
    ["POST", "/api/handoffs/:handoffId/submit-review"],
    ["POST", "/api/handoffs/:handoffId/return-draft"],
    ["POST", "/api/handoffs/:handoffId/approve"],
    ["POST", "/api/handoffs/:handoffId/start-implementation"],
    ["GET", "/api/handoffs/:handoffId/execution-decisions"],
    ["POST", "/api/handoffs/:handoffId/execution-decisions"],
    ["POST", "/api/handoffs/:handoffId/complete"],
    ["POST", "/api/handoffs/:handoffId/cancel"],
  ]),
  ...evidence("apps/server/src/redesign-studio-http-authorization.test.ts", [
    ["POST", "/api/redesign-assessments"],
    ["GET", "/api/redesign-assessments/:assessmentId"],
    ["GET", "/api/redesign-assessments/:assessmentId/stages/:stage/artifact"],
    ["PUT", "/api/redesign-assessments/:assessmentId/stages/:stage/artifact"],
    ["PATCH", "/api/redesign-assessments/:assessmentId/current-stage"],
    ["POST", "/api/redesign-assessments/:assessmentId/transition"],
  ]),
  ...evidence("apps/server/src/agent-connection-http-authorization.test.ts", [
    ["GET", "/api/agent-connections"],
    ["POST", "/api/agent-connections"],
    ["POST", "/api/agent-connections/pair"],
    ["POST", "/api/agent-connections/:connectionId/reconnect"],
    ["POST", "/api/agent-connections/:connectionId/revoke"],
  ]),
  ...evidence("apps/server/src/repository-inventory-http-authorization.test.ts", [
    ["GET", "/api/repository-inventories"],
    ["POST", "/api/repository-inventories"],
    ["GET", "/api/repository-inventories/:inventoryId"],
    ["POST", "/api/repository-inventories/:inventoryId/revoke"],
  ]),
  ...evidence("apps/server/src/backup-artifact-http-authorization.test.ts", [
    ["POST", "/api/backups/imports/validate"],
    ["POST", "/api/backups/imports"],
    ["POST", "/api/backups/prune/previews"],
    ["POST", "/api/backups/prune/previews/:previewId/commit"],
    ["POST", "/api/backups/:backupId/verify"],
    ["GET", "/api/backups/:backupId/download"],
  ]),
  ...evidence("apps/server/src/organization-policy-http-authorization.test.ts", [
    ["PUT", "/api/organization/policy"],
    ["POST", "/api/organization/audit-retention/previews"],
    ["POST", "/api/organization/audit-retention/previews/:previewId/commit"],
    ["GET", "/api/organization/audit-retention/runs"],
  ]),
  ...evidence("apps/server/src/implementation-mapping-http-authorization.test.ts", [
    ["GET", "/api/implementation-mappings/:mappingId"],
    ["POST", "/api/designs/:id/implementation-mappings"],
  ]),
  ...evidence("apps/server/src/core-design-catalog-http-authorization.test.ts", [
    ["GET", "/api/designs"],
    ["POST", "/api/designs"],
    ["GET", "/api/designs/:id"],
    ["GET", "/api/context"],
  ]),
  ...evidence("apps/server/src/design-archive-http.test.ts", [
    ["POST", "/api/designs/:id/archive"],
  ]),
  ...evidence("apps/server/src/core-preview-http-authorization.test.ts", [
    ["POST", "/api/designs/:id/previews"],
    ["GET", "/api/designs/:id/previews/:previewId"],
    ["POST", "/api/designs/:id/previews/:previewId/commit"],
    ["POST", "/api/designs/:id/archive-previews"],
  ]),
  ...evidence("apps/server/src/core-revision-lifecycle-http-authorization.test.ts", [
    ["POST", "/api/designs/:id/archive-previews/:previewId/commit"],
    ["POST", "/api/designs/:id/revisions"],
    ["POST", "/api/designs/:id/migrations/v2"],
    ["GET", "/api/designs/:id/history"],
  ]),
  ...evidence("apps/server/src/core-inspect-restore-render-http-authorization.test.ts", [
    ["GET", "/api/projects/:projectId/revisions/:revisionId/inspect"],
    ["POST", "/api/designs/:id/restore"],
    ["GET", "/api/designs/:id/export"],
    ["GET", "/api/designs/:id/render.png"],
  ]),
  ...evidence("apps/server/src/core-preview-context-assets-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/previews/:previewId/render.png"],
    ["PUT", "/api/context"],
    ["POST", "/api/assets"],
    ["GET", "/api/assets/:id"],
  ]),
  ...evidence("apps/server/src/core-events-http-authorization.test.ts", [
    ["GET", "/events"],
    ["GET", "/api/events"],
  ]),
  ...evidence("apps/server/src/planning-task-collection-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/planning-sessions"],
    ["POST", "/api/designs/:id/planning-sessions"],
    ["GET", "/api/designs/:id/agent-tasks"],
    ["POST", "/api/designs/:id/agent-tasks"],
  ]),
  ...evidence("apps/server/src/portable-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/export.formaspec.zip"],
    ["GET", "/api/designs/:id/tokens/export/:target"],
    ["POST", "/api/imports/validate"],
    ["POST", "/api/imports"],
  ]),
  ...evidence("apps/server/src/backup-schedule-http-authorization.test.ts", [
    ["GET", "/api/backups"],
    ["POST", "/api/backups"],
    ["GET", "/api/backups/schedule"],
    ["PUT", "/api/backups/schedule"],
    ["POST", "/api/backups/schedule/run"],
  ]),
  ...evidence("apps/server/src/design-system-catalog-http-authorization.test.ts", [
    ["GET", "/api/design-systems"],
    ["POST", "/api/design-systems"],
    ["GET", "/api/design-systems/:designSystemId"],
    ["PATCH", "/api/design-systems/:designSystemId"],
  ]),
  ...evidence("apps/server/src/design-system-entity-http-authorization.test.ts", [
    ["POST", "/api/design-systems/:designSystemId/tokens"],
    ["POST", "/api/design-systems/:designSystemId/components"],
    ["GET", "/api/design-systems/:designSystemId/components"],
    ["POST", "/api/design-systems/:designSystemId/components/:componentId/lifecycle"],
  ]),
  ...evidence("apps/server/src/design-system-release-pin-http-authorization.test.ts", [
    ["GET", "/api/design-systems/:designSystemId/releases"],
    ["POST", "/api/design-systems/:designSystemId/releases"],
    ["GET", "/api/designs/:id/design-system-pin"],
    ["PUT", "/api/designs/:id/design-system-pin"],
  ]),
  ...evidence("apps/server/src/component-insertion-http-authorization.test.ts", [
    ["GET", "/api/designs/:id/component-library"],
    ["POST", "/api/designs/:id/component-insertion-previews"],
  ]),
  ...evidence("apps/server/src/organization-context-maintenance-http-authorization.test.ts", [
    ["GET", "/api/organization/policy"],
    ["GET", "/api/organization/configuration"],
    ["GET", "/api/agent-authorization-context"],
    ["GET", "/api/maintenance/status"],
  ]),
  ...evidence("apps/server/src/enterprise-final-http-authorization.test.ts", [
    ["POST", "/api/designs/:id/design-system-upgrade-previews"],
    ["GET", "/api/designs/:id/implementation-mappings"],
    ["GET", "/api/enterprise-domain-capabilities"],
    ["POST", "/api/designs/:id/conflict-recovery/duplicate"],
  ]),
];

function defineDirectAuthorizationEvidence(
  entries: readonly DirectAuthorizationEvidenceDefinition[],
): readonly DirectAuthorizationRouteEvidence[] {
  const seen = new Set<ProtectedNonMcpRouteKey>();
  return Object.freeze(entries.map((entry) => {
    const key = protectedNonMcpRouteKey(entry.method, entry.path);
    if (seen.has(key)) throw new Error(`Duplicate direct authorization evidence: ${key}`);
    seen.add(key);
    const contract = PROTECTED_NON_MCP_ROUTE_CONTRACTS.get(key);
    if (!contract) throw new Error(`Direct authorization evidence references an unknown route: ${key}`);
    if (!/^apps\/server\/src\/[a-z0-9-]+\.test\.ts$/u.test(entry.testFile)) {
      throw new Error(`Direct authorization evidence has an invalid test-file path: ${entry.testFile}`);
    }
    return Object.freeze({
      ...entry,
      path: contract.path,
      key,
      family: contract.family,
      authorization: contract.authorization,
    });
  }));
}

export const DIRECT_AUTHORIZATION_ROUTE_EVIDENCE = defineDirectAuthorizationEvidence(definitions);

const directAuthorizationRouteKeySet = new Set(
  DIRECT_AUTHORIZATION_ROUTE_EVIDENCE.map((entry) => entry.key),
);

export const DIRECT_AUTHORIZATION_ROUTE_KEYS = Object.freeze(
  [...directAuthorizationRouteKeySet],
);

export const UNCOVERED_DIRECT_AUTHORIZATION_ROUTES = Object.freeze(
  [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()].filter(
    (contract) => !directAuthorizationRouteKeySet.has(contract.key),
  ),
);

export const DIRECT_AUTHORIZATION_COVERAGE_SUMMARY = Object.freeze({
  total: PROTECTED_NON_MCP_ROUTE_CONTRACTS.size,
  covered: DIRECT_AUTHORIZATION_ROUTE_EVIDENCE.length,
  remaining: UNCOVERED_DIRECT_AUTHORIZATION_ROUTES.length,
});

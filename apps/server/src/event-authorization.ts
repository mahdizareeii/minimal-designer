import type { AccessContext, OrganizationRole } from "./authorization.js";
import {
  DESIGNER_EVENT_TYPES,
  type DesignerEvent,
  type DesignerEventType,
} from "./events.js";
import type { ORGANIZATION_AGENT_SCOPES } from "./organization-policy-model.js";

export type EventProjectBoundary = "project" | "organization" | "optional" | "control";
type OrganizationAgentScope = (typeof ORGANIZATION_AGENT_SCOPES)[number];

export interface DesignerEventAuthorizationPolicy {
  agentScope: OrganizationAgentScope | null;
  humanRoles: readonly OrganizationRole[];
  boundary: EventProjectBoundary;
}

const ALL_HUMAN_ROLES = Object.freeze([
  "organization_admin",
  "product_manager",
  "design_editor",
  "engineer",
  "viewer",
] as const satisfies readonly OrganizationRole[]);

const ORGANIZATION_ADMINS = Object.freeze(
  ["organization_admin"] as const satisfies readonly OrganizationRole[],
);

const readPolicy = (
  agentScope: OrganizationAgentScope,
  boundary: Exclude<EventProjectBoundary, "control">,
): DesignerEventAuthorizationPolicy => Object.freeze({
  agentScope,
  humanRoles: ALL_HUMAN_ROLES,
  boundary,
});

const administratorPolicy = (): DesignerEventAuthorizationPolicy => Object.freeze({
  agentScope: null,
  humanRoles: ORGANIZATION_ADMINS,
  boundary: "organization",
});

export const DESIGNER_EVENT_AUTHORIZATION_POLICY = Object.freeze({
  "design.created": readPolicy("design:read", "project"),
  "design.updated": readPolicy("design:read", "project"),
  "product.updated": readPolicy("design:read", "organization"),
  "asset.created": readPolicy("design:read", "optional"),
  "context.updated": readPolicy("design:read", "optional"),
  "product_spec.preview.updated": readPolicy("product_spec:read", "project"),
  "product_spec.committed": readPolicy("product_spec:read", "project"),
  "planning_session.updated": readPolicy("planning:read", "project"),
  "agent_task.transitioned": readPolicy("task:read", "project"),
  "agent_connection.changed": administratorPolicy(),
  "organization_policy.changed": readPolicy("organization_policy:read", "organization"),
  "design_system.changed": readPolicy("design_system:read", "optional"),
  "repository_inventory.changed": readPolicy("workspace:inventory:read", "organization"),
  "implementation_mapping.changed": readPolicy("implementation_mapping:read", "project"),
  "handoff.transitioned": readPolicy("handoff:read", "project"),
  "redesign.transitioned": readPolicy("redesign:read", "optional"),
  "backup.operation": administratorPolicy(),
  "audit.retention": administratorPolicy(),
  "events.gap": Object.freeze({
    agentScope: null,
    humanRoles: ALL_HUMAN_ROLES,
    boundary: "control",
  }),
} satisfies Record<DesignerEventType, DesignerEventAuthorizationPolicy>);

interface EventDesignBoundary {
  state: "absent" | "valid" | "invalid";
  designId?: string;
}

function eventDesignBoundary(event: Pick<DesignerEvent, "data" | "designId">): EventDesignBoundary {
  if (Object.prototype.hasOwnProperty.call(event.data, "designId")) {
    if (typeof event.data.designId !== "string" || event.data.designId.length === 0) {
      return { state: "invalid" };
    }
    if (event.designId !== undefined && event.designId !== event.data.designId) {
      return { state: "invalid" };
    }
    return { state: "valid", designId: event.data.designId };
  }
  if (event.designId !== undefined) {
    return event.designId.length > 0
      ? { state: "valid", designId: event.designId }
      : { state: "invalid" };
  }
  return { state: "absent" };
}

function hasAgentScope(access: AccessContext, scope: string): boolean {
  return access.scopes.includes("*") || access.scopes.includes(scope);
}

function principalCanReadPolicy(
  access: AccessContext,
  policy: DesignerEventAuthorizationPolicy,
): boolean {
  if (policy.boundary === "control") return true;
  if (access.role === "agent") {
    return policy.agentScope !== null && hasAgentScope(access, policy.agentScope);
  }
  return policy.humanRoles.includes(access.role);
}

function boundaryCanBeVisible(
  access: AccessContext,
  boundary: EventProjectBoundary,
): boolean {
  if (boundary === "control") return false;
  if (access.projectIds.length === 0) return true;
  return boundary === "project" || boundary === "optional";
}

export function hasDesignerEventReadAccess(access: AccessContext): boolean {
  return DESIGNER_EVENT_TYPES.some((eventType) => {
    const policy = DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType];
    return principalCanReadPolicy(access, policy) && boundaryCanBeVisible(access, policy.boundary);
  });
}

export function canReadDesignerEvent(
  access: AccessContext,
  event: Pick<DesignerEvent, "type" | "data" | "designId">,
): boolean {
  const policy = DESIGNER_EVENT_AUTHORIZATION_POLICY[event.type];
  if (!principalCanReadPolicy(access, policy)) return false;
  if (policy.boundary === "control") return event.type === "events.gap";

  const design = eventDesignBoundary(event);
  if (design.state === "invalid") return false;
  if (policy.boundary === "organization") {
    return design.state === "absent" && access.projectIds.length === 0;
  }
  if (policy.boundary === "project" && design.state !== "valid") return false;
  if (access.projectIds.length === 0) return true;
  return design.state === "valid" && access.projectIds.includes(design.designId as string);
}

export interface DesignerEventSqlVisibility {
  sql: string;
  parameters: string[];
}

export function designerEventSqlVisibility(
  access: AccessContext,
  columns: { eventType?: string; payload?: string } = {},
): DesignerEventSqlVisibility {
  const eventTypeColumn = columns.eventType ?? "event_type";
  const payloadColumn = columns.payload ?? "payload_json";
  const designType = `json_type(${payloadColumn}, '$.designId')`;
  const designValue = `json_extract(${payloadColumn}, '$.designId')`;
  const readable = DESIGNER_EVENT_TYPES.filter((eventType) => {
    const policy = DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType];
    return principalCanReadPolicy(access, policy) && policy.boundary !== "control";
  });
  const inClause = (values: readonly string[]) => values.map(() => "?").join(", ");

  if (access.projectIds.length > 0) {
    const projectTypes = readable.filter((eventType) => {
      const boundary = DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType].boundary;
      return boundary === "project" || boundary === "optional";
    });
    if (projectTypes.length === 0) return { sql: "0", parameters: [] };
    return {
      sql: `(${eventTypeColumn} IN (${inClause(projectTypes)}) AND ${designType} = 'text' AND ${designValue} IN (${inClause(access.projectIds)}))`,
      parameters: [...projectTypes, ...access.projectIds],
    };
  }

  const boundaryClause: Record<Exclude<EventProjectBoundary, "control">, string> = {
    project: `${designType} = 'text'`,
    organization: `${designType} IS NULL`,
    optional: `(${designType} IS NULL OR ${designType} = 'text')`,
  };
  const clauses: string[] = [];
  const parameters: string[] = [];
  for (const boundary of ["project", "organization", "optional"] as const) {
    const eventTypes = readable.filter(
      (eventType) => DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType].boundary === boundary,
    );
    if (eventTypes.length === 0) continue;
    clauses.push(`(${eventTypeColumn} IN (${inClause(eventTypes)}) AND ${boundaryClause[boundary]})`);
    parameters.push(...eventTypes);
  }

  return {
    sql: clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0",
    parameters,
  };
}

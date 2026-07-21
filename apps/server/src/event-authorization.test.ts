import { describe, expect, it } from "vitest";

import type { AccessContext, OrganizationRole } from "./authorization.js";
import {
  canReadDesignerEvent,
  DESIGNER_EVENT_AUTHORIZATION_POLICY,
  designerEventSqlVisibility,
  hasDesignerEventReadAccess,
  type EventProjectBoundary,
} from "./event-authorization.js";
import { DESIGNER_EVENT_TYPES, type DesignerEventType } from "./events.js";

const ALL_HUMAN_ROLES: OrganizationRole[] = [
  "organization_admin",
  "product_manager",
  "design_editor",
  "engineer",
  "viewer",
];

function access(input: Partial<AccessContext> & Pick<AccessContext, "role">): AccessContext {
  return {
    actorId: input.actorId ?? `actor_${input.role}`,
    principalId: input.principalId ?? `principal_${input.role}`,
    organizationId: input.organizationId ?? "organization_legacy",
    role: input.role,
    scopes: input.scopes ?? ["*"],
    projectIds: input.projectIds ?? [],
    ...(input.grantId ? { grantId: input.grantId } : {}),
  };
}

function event(type: DesignerEventType, designId?: unknown) {
  return {
    type,
    data: designId === undefined ? {} : { designId },
    ...(typeof designId === "string" ? { designId } : {}),
  };
}

describe("designer event authorization policy", () => {
  it("is runtime-exhaustive and pins every event family to its scope and boundary", () => {
    expect(Object.keys(DESIGNER_EVENT_AUTHORIZATION_POLICY)).toEqual([...DESIGNER_EVENT_TYPES]);
    expect(DESIGNER_EVENT_TYPES).toHaveLength(18);

    const expected: Record<DesignerEventType, { agentScope: string | null; boundary: EventProjectBoundary }> = {
      "design.created": { agentScope: "design:read", boundary: "project" },
      "design.updated": { agentScope: "design:read", boundary: "project" },
      "asset.created": { agentScope: "design:read", boundary: "optional" },
      "context.updated": { agentScope: "design:read", boundary: "optional" },
      "product_spec.preview.updated": { agentScope: "product_spec:read", boundary: "project" },
      "product_spec.committed": { agentScope: "product_spec:read", boundary: "project" },
      "planning_session.updated": { agentScope: "planning:read", boundary: "project" },
      "agent_task.transitioned": { agentScope: "task:read", boundary: "project" },
      "agent_connection.changed": { agentScope: null, boundary: "organization" },
      "organization_policy.changed": { agentScope: "organization_policy:read", boundary: "organization" },
      "design_system.changed": { agentScope: "design_system:read", boundary: "optional" },
      "repository_inventory.changed": { agentScope: "workspace:inventory:read", boundary: "organization" },
      "implementation_mapping.changed": { agentScope: "implementation_mapping:read", boundary: "project" },
      "handoff.transitioned": { agentScope: "handoff:read", boundary: "project" },
      "redesign.transitioned": { agentScope: "redesign:read", boundary: "optional" },
      "backup.operation": { agentScope: null, boundary: "organization" },
      "audit.retention": { agentScope: null, boundary: "organization" },
      "events.gap": { agentScope: null, boundary: "control" },
    };

    for (const eventType of DESIGNER_EVENT_TYPES) {
      expect(DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType], eventType).toMatchObject(expected[eventType]);
      const expectedHumanRoles = ["agent_connection.changed", "backup.operation", "audit.retention"].includes(eventType)
        ? ["organization_admin"]
        : ALL_HUMAN_ROLES;
      expect(DESIGNER_EVENT_AUTHORIZATION_POLICY[eventType].humanRoles, eventType).toEqual(expectedHumanRoles);
    }
  });

  it("enforces agent scope and project, organization, optional, and control boundaries", () => {
    const designReader = access({ role: "agent", scopes: ["design:read"], projectIds: ["document_allowed"] });
    expect(canReadDesignerEvent(designReader, event("design.updated", "document_allowed"))).toBe(true);
    expect(canReadDesignerEvent(designReader, event("design.updated", "document_denied"))).toBe(false);
    expect(canReadDesignerEvent(designReader, event("design.updated"))).toBe(false);
    expect(canReadDesignerEvent(designReader, {
      type: "design.updated",
      designId: "document_denied",
      data: { designId: "document_allowed" },
    })).toBe(false);
    expect(canReadDesignerEvent(designReader, event("agent_task.transitioned", "document_allowed"))).toBe(false);
    expect(canReadDesignerEvent(designReader, event("asset.created", "document_allowed"))).toBe(true);
    expect(canReadDesignerEvent(designReader, event("asset.created"))).toBe(false);

    const unrestrictedDesignReader = access({ role: "agent", scopes: ["design:read"] });
    expect(canReadDesignerEvent(unrestrictedDesignReader, event("asset.created"))).toBe(true);
    expect(canReadDesignerEvent(unrestrictedDesignReader, event("asset.created", 42))).toBe(false);

    const policyReader = access({ role: "agent", scopes: ["organization_policy:read"] });
    expect(canReadDesignerEvent(policyReader, event("organization_policy.changed"))).toBe(true);
    expect(canReadDesignerEvent(policyReader, event("organization_policy.changed", "document_injected"))).toBe(false);
    expect(canReadDesignerEvent(policyReader, event("backup.operation"))).toBe(false);

    const viewer = access({ role: "viewer" });
    const admin = access({ role: "organization_admin" });
    expect(canReadDesignerEvent(viewer, event("backup.operation"))).toBe(false);
    expect(canReadDesignerEvent(admin, event("backup.operation"))).toBe(true);
    expect(canReadDesignerEvent(viewer, event("events.gap"))).toBe(true);
  });

  it("allows streams for any readable event scope and rejects scope-boundary combinations with no visible family", () => {
    expect(hasDesignerEventReadAccess(access({
      role: "agent",
      scopes: ["task:read"],
      projectIds: ["document_allowed"],
    }))).toBe(true);
    expect(hasDesignerEventReadAccess(access({
      role: "agent",
      scopes: ["organization_policy:read"],
      projectIds: ["document_allowed"],
    }))).toBe(false);
    expect(hasDesignerEventReadAccess(access({
      role: "agent",
      scopes: ["design:write"],
      projectIds: ["document_allowed"],
    }))).toBe(false);
    expect(hasDesignerEventReadAccess(access({ role: "viewer" }))).toBe(true);

    const taskVisibility = designerEventSqlVisibility(access({
      role: "agent",
      scopes: ["task:read"],
      projectIds: ["document_allowed"],
    }));
    expect(taskVisibility.parameters).toEqual(["agent_task.transitioned", "document_allowed"]);
    expect(taskVisibility.sql).toContain("json_type(payload_json, '$.designId') = 'text'");

    const manyProjects = Array.from({ length: 200 }, (_, index) => `document_${String(index).padStart(8, "0")}`);
    const boundedVisibility = designerEventSqlVisibility(access({
      role: "agent",
      scopes: ["task:read"],
      projectIds: manyProjects,
    }));
    expect(boundedVisibility.parameters).toHaveLength(201);
    expect(boundedVisibility.parameters.slice(1)).toEqual(manyProjects);

    const deniedVisibility = designerEventSqlVisibility(access({
      role: "agent",
      scopes: ["organization_policy:read"],
      projectIds: ["document_allowed"],
    }));
    expect(deniedVisibility).toEqual({ sql: "0", parameters: [] });
  });
});

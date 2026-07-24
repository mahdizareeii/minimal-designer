import { afterEach, describe, expect, it } from "vitest";

import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EnterpriseService } from "./enterprise-service.js";
import { EventHub } from "./events.js";
import { DesignerService } from "./service.js";

const databases: DesignerDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): {
  database: DesignerDatabase;
  designer: DesignerService;
  enterprise: EnterpriseService;
} {
  const database = new DesignerDatabase(":memory:");
  databases.push(database);
  const events = new EventHub();
  const designer = new DesignerService(database, events, 900);
  const enterprise = new EnterpriseService(database, events, { designerService: designer });
  return { database, designer, enterprise };
}

function expectNotFound(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("NOT_FOUND");
    return;
  }
  throw new Error("Expected archived project access to return NOT_FOUND.");
}

describe("archived project enterprise opacity", () => {
  it("hides retained product-specification, planning, task, and connection records", () => {
    const { designer, enterprise } = fixture();
    const created = designer.createDesign("local", {
      name: "Archived enterprise surface",
      preset: "web",
      idempotencyKey: "archived-enterprise-create-0001",
    });
    const specificationPreview = enterprise.previewProductSpecification("local", {
      designId: created.design.id,
      baseVersion: 0,
      naturalLanguageBrief: "A retained product brief that must become opaque after project deletion.",
    });
    const planning = enterprise.createPlanningSession("local", {
      designId: created.design.id,
      idempotencyKey: "archived-enterprise-planning-0001",
    });
    const task = enterprise.createAgentTask("local", {
      designId: created.design.id,
      brief: "Create an exact design preview for approval.",
      baseVersion: created.design.version,
      expectedOutput: "design_preview",
      idempotencyKey: "archived-enterprise-task-0001",
    });
    const pairing = enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Archived project connection",
      scopes: ["design:read", "task:read"],
      projectIds: [created.design.id],
      expiresInSeconds: 3_600,
    });

    designer.archiveDesign("local", created.design.id, {
      expectedVersion: created.design.version,
      idempotencyKey: "archived-enterprise-delete-0001",
      confirmationName: created.design.name,
    });

    expectNotFound(() => enterprise.readProductSpecificationPreview(
      "local",
      created.design.id,
      specificationPreview.id,
    ));
    expectNotFound(() => enterprise.listPlanningSessions("local", created.design.id));
    expectNotFound(() => enterprise.readPlanningSession("local", planning.session.id));
    expectNotFound(() => enterprise.listAgentTasks("local", { designId: created.design.id }));
    expectNotFound(() => enterprise.readAgentTask("local", task.id));
    expect(enterprise.listAgentTasks("local")).toEqual([]);
    expectNotFound(() => enterprise.pairAgentConnection(pairing.nonce));
    expectNotFound(() => enterprise.renewAgentConnectionPairing("local", pairing.connection.id));
    expectNotFound(() => enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Replacement archived project connection",
      scopes: ["design:read"],
      projectIds: [created.design.id],
      expiresInSeconds: 3_600,
    }));
  });

  it("filters archived tasks before applying a global list limit", () => {
    const { designer, enterprise } = fixture();
    const active = designer.createDesign("local", {
      name: "Active task project",
      preset: "phone",
      idempotencyKey: "archived-task-list-active-design-0001",
    });
    const retainedTask = enterprise.createAgentTask("local", {
      designId: active.design.id,
      brief: "This task must remain visible.",
      baseVersion: active.design.version,
      expectedOutput: "product_spec_preview",
      idempotencyKey: "archived-task-list-active-task-0001",
    });
    const archived = designer.createDesign("local", {
      name: "Archived task project",
      preset: "tablet",
      idempotencyKey: "archived-task-list-hidden-design-0001",
    });
    enterprise.createAgentTask("local", {
      designId: archived.design.id,
      brief: "This newer task must not consume the only result slot.",
      baseVersion: archived.design.version,
      expectedOutput: "product_spec_preview",
      idempotencyKey: "archived-task-list-hidden-task-0001",
    });
    designer.archiveDesign("local", archived.design.id, {
      expectedVersion: archived.design.version,
      idempotencyKey: "archived-task-list-delete-0001",
      confirmationName: archived.design.name,
    });

    expect(enterprise.listAgentTasks("local", { limit: 1 }).map((task) => task.id)).toEqual([retainedTask.id]);
  });

  it("filters stale archived editor leases before resolving workspace context", () => {
    const { database, designer } = fixture();
    const active = designer.createDesign("local", {
      name: "Active editor context",
      preset: "web",
      idempotencyKey: "archived-context-active-design-0001",
    });
    const archived = designer.createDesign("local", {
      name: "Archived editor context",
      preset: "phone",
      idempotencyKey: "archived-context-hidden-design-0001",
    });
    designer.archiveDesign("local", archived.design.id, {
      expectedVersion: archived.design.version,
      idempotencyKey: "archived-context-delete-0001",
      confirmationName: archived.design.name,
    });
    const now = new Date().toISOString();
    database.sqlite.prepare(
      `INSERT INTO contexts (actor_id, design_id, page_id, selection_json, updated_at, organization_id)
       VALUES (?, ?, ?, ?, ?, 'organization_legacy')`,
    ).run(
      "stale_active_editor_context",
      active.design.id,
      active.document.pages[0]!.id,
      JSON.stringify([active.document.pages[0]!.children[0]!]),
      now,
    );
    database.sqlite.prepare(
      `INSERT INTO contexts (actor_id, design_id, page_id, selection_json, updated_at, organization_id)
       VALUES (?, ?, ?, ?, ?, 'organization_legacy')`,
    ).run(
      "stale_archived_editor_context",
      archived.design.id,
      archived.document.pages[0]!.id,
      JSON.stringify([archived.document.pages[0]!.children[0]!]),
      now,
    );

    const context = designer.getContext("local", { workspaceFallback: true });
    expect(context).toMatchObject({
      designId: active.design.id,
      pageId: active.document.pages[0]!.id,
      selection: [active.document.pages[0]!.children[0]!],
      contextSource: "workspace",
    });
    expect(JSON.stringify(context)).not.toContain(archived.design.id);
    expect(JSON.stringify(context)).not.toContain(archived.document.pages[0]!.id);
  });
});

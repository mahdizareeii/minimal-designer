import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { DesignSystemService } from "./design-system-service.js";
import { EventHub } from "./events.js";
import { DesignerService } from "./service.js";

const databases: DesignerDatabase[] = [];
const temporaryDirectories: string[] = [];

function setup(filename = ":memory:") {
  const database = new DesignerDatabase(filename);
  databases.push(database);
  const designer = new DesignerService(database, new EventHub(), 900);
  const design = designer.createDesign("local", {
    name: "Design-system project",
    preset: "web",
    idempotencyKey: "design-system-test-project",
  });
  let time = new Date("2026-07-19T10:00:00.000Z");
  const systems = new DesignSystemService(database, {
    now: () => new Date(time),
    upgradePreviewTtlSeconds: 900,
  });
  return {
    database,
    designer,
    design,
    systems,
    setTime(value: string) { time = new Date(value); },
  };
}

function token(value: string | number, family: "color" | "spacing" = "color") {
  return {
    id: "token_primaryaction0001",
    path: "action.primary.background",
    name: "Primary action background",
    family,
    layer: "semantic",
    value,
    deprecated: false,
  };
}

function component(version: number, options: {
  removeLabel?: boolean;
  id?: string;
  key?: string;
  name?: string;
  rootNodeId?: string;
  status?: "draft" | "published" | "deprecated";
} = {}) {
  const rootNodeId = options.rootNodeId ?? "node_primarybuttonroot001";
  return {
    id: options.id ?? "component_primarybutton0001",
    key: options.key ?? "button.primary",
    name: options.name ?? "Primary button",
    version,
    status: options.status ?? "published" as const,
    root_node_id: rootNodeId,
    properties_schema: options.removeLabel ? [] : [{
      key: "label",
      label: "Label",
      required: true,
      type: "text" as const,
      default: "Continue",
    }],
    slots: [],
    states: [{ key: "default" as const, name: "Default", node_id: rootNodeId }],
    allowed_overrides: {
      allow_text: true,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: ["color" as const],
      allowed_style_paths: ["fill" as const],
    },
    platform_mappings: [],
    documentation: {
      summary: "Primary product action.",
      usage: [],
      accessibility: [],
      do_list: [],
      dont_list: [],
    },
  };
}

function createPublishedRelease(
  systems: DesignSystemService,
  designSystemId: string,
  releaseVersion: number,
  tokenVersion: number,
  componentVersion: number,
) {
  return systems.createRelease("local", designSystemId, {
    expectedLatestVersion: releaseVersion - 1,
    name: `Release ${releaseVersion}`,
    status: "published",
    tokenVersions: [{ tokenId: "token_primaryaction0001", version: tokenVersion }],
    componentVersions: [{ componentDefinitionId: "component_primarybutton0001", version: componentVersion }],
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("persisted design-system service", () => {
  it("creates mutable system metadata and append-only token, component, and release versions", () => {
    const { database, systems, setTime } = setup();
    const system = systems.createDesignSystem("local", {
      name: "Company Product System",
      description: "Shared product primitives.",
    });
    expect(system.id).toMatch(/^system_[a-f0-9]{32}$/);
    expect(system.status).toBe("active");

    setTime("2026-07-19T10:01:00.000Z");
    const renamed = systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      name: "Company Product Foundation",
    });
    expect(renamed.name).toBe("Company Product Foundation");
    expect(() => systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      description: "stale write",
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    const tokenV1 = systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    const componentV1 = systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, tokenV1.version, componentV1.version);
    expect(release).toMatchObject({
      version: 1,
      status: "published",
      tokenVersions: [{ tokenId: tokenV1.tokenId, version: 1 }],
      componentVersions: [{ componentDefinitionId: componentV1.componentId, version: 1 }],
    });
    expect(release.publishedAt).not.toBeNull();

    expect(() => database.sqlite.prepare(
      "UPDATE design_system_tokens SET status = 'deprecated' WHERE design_system_id = ? AND token_id = ? AND version = 1",
    ).run(system.id, tokenV1.tokenId)).toThrow("design system tokens are immutable");
    expect(() => database.sqlite.prepare(
      "UPDATE component_definitions SET status = 'deprecated' WHERE design_system_id = ? AND component_id = ? AND version = 1",
    ).run(system.id, componentV1.componentId)).toThrow("component definitions are immutable");
    expect(() => database.sqlite.prepare(
      "UPDATE design_system_releases SET name = 'changed' WHERE id = ?",
    ).run(release.id)).toThrow("design system releases are immutable");

    const actions = database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'design_system.%' ORDER BY id",
    ).all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual([
      "design_system.create",
      "design_system.update",
      "design_system.token_version.create",
      "design_system.component_version.create",
      "design_system.release.create",
    ]);
  });

  it("pins published releases and atomically commits a ready upgrade preview", () => {
    const { systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Checkout System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    const initialPin = systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    expect(initialPin.releaseVersion).toBe(1);

    setTime("2026-07-19T10:05:00.000Z");
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(preview.status).toBe("ready");
    expect(preview.canCommit).toBe(true);
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "COMPONENT_VERSION_CHANGED",
      "TOKEN_VALUE_CHANGED",
    ]);

    const committed = systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    });
    expect(committed.preview.status).toBe("committed");
    expect(committed.pin).toMatchObject({ releaseId: release2.id, releaseVersion: 2 });
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_ALREADY_COMMITTED" }));
  });

  it("persists blocked upgrade diagnostics and rejects stale or expired preview commits", () => {
    const { systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Risky System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });

    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token(8, "spacing"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2, { removeLabel: true }),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const blocked = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.canCommit).toBe(false);
    expect(blocked.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TOKEN_FAMILY_CHANGED", severity: "error", safety: "blocked" }),
      expect.objectContaining({ code: "COMPONENT_CONTRACT_REVIEW_REQUIRED", severity: "warning" }),
    ]));
    expect(systems.readUpgradePreview("local", blocked.id).diagnostics).toEqual(blocked.diagnostics);
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: blocked.id,
      expectedPreviewHash: blocked.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_NOT_COMMITTABLE" }));

    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 2,
      status: "published",
      token: token("#0f172a"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 2,
      definition: component(3),
    });
    const release3 = createPublishedRelease(systems, system.id, 3, 3, 3);
    setTime("2026-07-19T11:00:00.000Z");
    const expiring = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release3.id,
    });
    setTime("2026-07-19T11:16:00.000Z");
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: expiring.id,
      expectedPreviewHash: expiring.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_EXPIRED" }));
  });

  it("enforces organization-administrator writes and project pin compare-and-swap", () => {
    const { database, systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Restricted System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, 1, 1);

    const viewer = resolveAccess(database.sqlite, "viewer@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);
    expect(systems.readDesignSystem("viewer@example.com", system.id).id).toBe(system.id);
    expect(() => systems.createDesignSystem("viewer@example.com", { name: "Denied" }))
      .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    expect(() => systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    setTime("2026-07-19T12:00:00.000Z");
    const archived = systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      status: "archived",
    });
    expect(archived.status).toBe("archived");
    expect(() => systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#ffffff"),
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("lets design editors author typed drafts and creates immutable publish/deprecate versions", () => {
    const { database, systems } = setup();
    const system = systems.createDesignSystem("local", { name: "Component Authoring System" });
    const editor = resolveAccess(database.sqlite, "design-editor@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'design_editor' WHERE organization_id = ? AND principal_id = ?",
    ).run(editor.organizationId, editor.principalId);
    const viewer = resolveAccess(database.sqlite, "component-viewer@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);

    const draftDefinition = {
      ...component(1, { status: "draft" }),
      properties_schema: [
        { key: "label", label: "Label", required: true, type: "text" as const, default: "Continue", max_length: 80 },
        { key: "emphasis", label: "Emphasis", required: false, type: "enum" as const, values: ["high", "low"], default: "high" },
        { key: "loading", label: "Loading", required: false, type: "boolean" as const, default: false },
      ],
      slots: [{
        key: "leading",
        name: "Leading content",
        required: false,
        min_items: 0,
        max_items: 1,
        allowed_node_types: ["icon" as const, "image" as const],
      }],
      states: [
        { key: "default" as const, name: "Default", node_id: "node_primarybuttonroot001" },
        { key: "focused" as const, name: "Focused", node_id: "node_primarybuttonfocus001" },
        { key: "loading" as const, name: "Loading", node_id: "node_primarybuttonload0001" },
      ],
    };
    const draft = systems.createComponentVersion("design-editor@example.com", system.id, {
      expectedLatestVersion: 0,
      definition: draftDefinition,
    });
    expect(draft).toMatchObject({ version: 1, status: "draft" });

    const visibleDraft = systems.listComponentDefinitions("component-viewer@example.com", system.id);
    expect(visibleDraft).toEqual([
      expect.objectContaining({
        componentId: draft.componentId,
        version: 1,
        isLatest: true,
        versionCount: 1,
        diagnostics: [expect.objectContaining({ code: "COMPONENT_DRAFT_REVIEW_REQUIRED" })],
      }),
    ]);

    const published = systems.transitionComponentLifecycle("design-editor@example.com", system.id, draft.componentId, {
      expectedLatestVersion: 1,
      targetStatus: "published",
    });
    expect(published).toMatchObject({ version: 2, status: "published" });
    expect(published.definition.properties_schema).toEqual(draft.definition.properties_schema);
    expect(published.definition.slots).toEqual(draft.definition.slots);
    expect(published.definition.states).toEqual(draft.definition.states);

    const replacementDraft = systems.createComponentVersion("design-editor@example.com", system.id, {
      expectedLatestVersion: 0,
      definition: component(1, {
        id: "component_actionbuttonnew001",
        key: "button.action",
        name: "Action button",
        rootNodeId: "node_actionbuttonroot0001",
        status: "draft",
      }),
    });
    const replacement = systems.transitionComponentLifecycle("design-editor@example.com", system.id, replacementDraft.componentId, {
      expectedLatestVersion: 1,
      targetStatus: "published",
    });
    const deprecated = systems.transitionComponentLifecycle("design-editor@example.com", system.id, draft.componentId, {
      expectedLatestVersion: 2,
      targetStatus: "deprecated",
      replacementComponentId: replacement.componentId,
    });
    expect(deprecated).toMatchObject({ version: 3, status: "deprecated" });

    const latest = systems.listComponentDefinitions("component-viewer@example.com", system.id);
    expect(latest.find((item) => item.componentId === draft.componentId)).toMatchObject({
      version: 3,
      versionCount: 3,
      replacement: {
        componentId: replacement.componentId,
        version: 2,
        status: "published",
        name: "Action button",
      },
      diagnostics: [],
    });
    const history = systems.listComponentDefinitions("component-viewer@example.com", system.id, true)
      .filter((item) => item.componentId === draft.componentId);
    expect(history.map((item) => [item.version, item.status, item.isLatest])).toEqual([
      [3, "deprecated", true],
      [2, "published", false],
      [1, "draft", false],
    ]);
    expect(history[1]?.diagnostics[0]?.code).toBe("COMPONENT_VERSION_IMMUTABLE");
    expect(() => systems.transitionComponentLifecycle("component-viewer@example.com", system.id, replacement.componentId, {
      expectedLatestVersion: 2,
      targetStatus: "deprecated",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    const persisted = database.sqlite.prepare(
      "SELECT version, status FROM component_definitions WHERE design_system_id = ? AND component_id = ? ORDER BY version",
    ).all(system.id, draft.componentId) as Array<{ version: number; status: string }>;
    expect(persisted).toEqual([
      { version: 1, status: "draft" },
      { version: 2, status: "published" },
      { version: 3, status: "deprecated" },
    ]);
  });

  it("reports component-authoring permission explicitly for every human organization role", () => {
    const { database, systems } = setup();
    const system = systems.createDesignSystem("local", { name: "Role Capability System" });
    expect(systems.readComponentAuthoringPermission("local", system.id)).toEqual({
      designSystemId: system.id,
      canAuthorComponents: true,
    });

    const roles = [
      ["design-editor-capability@example.com", "design_editor", true],
      ["product-manager-capability@example.com", "product_manager", false],
      ["engineer-capability@example.com", "engineer", false],
      ["viewer-capability@example.com", "viewer", false],
    ] as const;
    for (const [actorId, role, expected] of roles) {
      const access = resolveAccess(database.sqlite, actorId);
      database.sqlite.prepare(
        "UPDATE memberships SET role = ? WHERE organization_id = ? AND principal_id = ?",
      ).run(role, access.organizationId, access.principalId);
      expect(systems.readComponentAuthoringPermission(actorId, system.id)).toEqual({
        designSystemId: system.id,
        canAuthorComponents: expected,
      });
      expect(systems.listComponentDefinitions(actorId, system.id)).toEqual([]);
      if (!expected) {
        expect(() => systems.createComponentVersion(actorId, system.id, {
          expectedLatestVersion: 0,
          definition: component(1, { status: "draft" }),
        })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
      }
    }
  });

  it("reopens immutable releases, pins, and upgrade previews from a migrated database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-design-system-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "designer.sqlite");
    const first = setup(filename);
    const system = first.systems.createDesignSystem("local", { name: "Persistent System" });
    first.systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    first.systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(first.systems, system.id, 1, 1, 1);
    first.systems.pinProject("local", {
      designId: first.design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    first.systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    first.systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(first.systems, system.id, 2, 2, 2);
    const preview = first.systems.previewProjectUpgrade("local", {
      designId: first.design.design.id,
      targetReleaseId: release2.id,
    });

    first.database.close();
    databases.splice(databases.indexOf(first.database), 1);
    const reopened = new DesignerDatabase(filename);
    databases.push(reopened);
    const service = new DesignSystemService(reopened, {
      now: () => new Date("2026-07-19T10:10:00.000Z"),
      upgradePreviewTtlSeconds: 900,
    });
    expect(service.readDesignSystem("local", system.id).name).toBe("Persistent System");
    expect(service.readRelease("local", release2.id).tokenVersions).toEqual([
      { tokenId: "token_primaryaction0001", version: 2 },
    ]);
    expect(service.readProjectPin("local", first.design.design.id).releaseId).toBe(release1.id);
    expect(service.readUpgradePreview("local", preview.id)).toMatchObject({
      id: preview.id,
      status: "ready",
      previewHash: preview.previewHash,
    });
  });
});

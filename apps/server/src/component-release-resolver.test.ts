import { createHash } from "node:crypto";

import {
  ComponentDefinitionSchema,
  ComponentInstanceNodeV2Schema,
  ComponentSourceBundleSchema,
  ContainerNodeV2Schema,
  DesignSystemReleaseSchema,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM,
  canonicalComponentSourceBundleBytes,
  canonicalComponentSourceBundleJson,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type DesignDocumentV2,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { listPinnedComponentRelease, resolvePinnedComponentRelease } from "./component-release-resolver.js";
import { DesignerDatabase } from "./db/database.js";
import { canonicalJson } from "./ids.js";

const databases: DesignerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function componentDefinition(id: string, key: string, name: string, rootNodeId: string): ComponentDefinition {
  return ComponentDefinitionSchema.parse({
    id,
    key,
    name,
    version: 1,
    status: "published",
    root_node_id: rootNodeId,
    properties_schema: [],
    property_bindings: [],
    slots: [],
    slot_anchors: [],
    states: [{ key: "default", name: "Default", node_id: rootNodeId }],
    allowed_overrides: {
      allow_text: false,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: [],
      allowed_style_paths: [],
    },
    platform_mappings: [],
    documentation: { summary: "Nested resolver fixture.", usage: [], accessibility: [], do_list: [], dont_list: [] },
  });
}

function nestedReleaseFixture(database: DesignerDatabase, options: { selectNested: boolean }): {
  document: DesignDocumentV2;
  parentComponentId: string;
  nestedComponentId: string;
} {
  const document = migrateDesignDocumentV1ToV2(createStarterDocument({
    now: "2026-07-25T06:00:00.000Z",
    idFactory: createSequentialIdFactory(options.selectNested ? "nestedreleased" : "nestedblocked"),
  }), { migratedAt: "2026-07-25T06:01:00.000Z" });
  const template = Object.values(document.nodes).find((node) => node.type === "frame");
  if (!template || template.type !== "frame") throw new Error("Nested release fixture requires a frame template.");
  const parentComponentId = options.selectNested
    ? "component_nested_parent_release_01"
    : "component_nested_parent_blocked_01";
  const nestedComponentId = options.selectNested
    ? "component_nested_child_release_01"
    : "component_nested_child_blocked_01";
  const parentRootId = options.selectNested
    ? "node_nested_parent_release_root_01"
    : "node_nested_parent_blocked_root_01";
  const nestedRootId = options.selectNested
    ? "node_nested_child_release_root_01"
    : "node_nested_child_blocked_root_01";
  const nestedInstanceId = options.selectNested
    ? "node_nested_child_release_instance_01"
    : "node_nested_child_blocked_instance_01";
  const {
    locale: _locale,
    text_direction: _textDirection,
    user_story: _userStory,
    screen_purpose: _screenPurpose,
    screen_state: _screenState,
    primary_action: _primaryAction,
    ...containerTemplate
  } = structuredClone(template);
  const nestedRoot = ContainerNodeV2Schema.parse({
    ...containerTemplate,
    type: "container",
    id: nestedRootId,
    name: "Nested child",
    children: [],
    layout: { ...template.layout, x: 0, y: 0 },
    semantics: { ...template.semantics, business_rule_ids: [], acceptance_criterion_ids: [] },
    metadata: {},
  });
  const parentRoot = ContainerNodeV2Schema.parse({
    ...containerTemplate,
    type: "container",
    id: parentRootId,
    name: "Nested parent",
    children: [nestedInstanceId],
    layout: { ...template.layout, x: 0, y: 0 },
    semantics: { ...template.semantics, business_rule_ids: [], acceptance_criterion_ids: [] },
    metadata: {},
  });
  const { children: _children, clip_content: _clipContent, ...commonInstance } = structuredClone(nestedRoot);
  const nestedInstance = ComponentInstanceNodeV2Schema.parse({
    ...commonInstance,
    id: nestedInstanceId,
    name: "Nested child instance",
    type: "component_instance",
    component_definition_id: nestedComponentId,
    component_version: 1,
    properties: {},
    slots: {},
    visual_overrides: {},
    active_state: "default",
  });
  const parentDefinition = componentDefinition(parentComponentId, "fixture.nested.parent", "Nested parent", parentRootId);
  const nestedDefinition = componentDefinition(nestedComponentId, "fixture.nested.child", "Nested child", nestedRootId);
  const source = (
    definition: ComponentDefinition,
    nodes: unknown,
  ): ComponentSourceBundle => ComponentSourceBundleSchema.parse({
    format: "formaspec-component-source",
    format_version: 1,
    schema_version: 2,
    component_definition_id: definition.id,
    component_version: definition.version,
    root_node_id: definition.root_node_id,
    states: [{ key: "default", name: "Default", root_node_id: definition.root_node_id }],
    nodes,
    prototype_links: [],
    dependencies: { token_ids: [], asset_ids: [] },
  });
  const parentSource = source(parentDefinition, [parentRoot, nestedInstance]);
  const nestedSource = source(nestedDefinition, [nestedRoot]);
  const designSystemId = options.selectNested ? "system_nested_release_fixture_01" : "system_nested_blocked_fixture_01";
  const releaseId = options.selectNested ? "release_nested_release_fixture_01" : "release_nested_blocked_fixture_01";
  const createdAt = "2026-07-25T06:02:00.000Z";
  database.sqlite.prepare(
    `INSERT INTO design_systems (id, organization_id, name, description, status, created_by, created_at, updated_at)
     VALUES (?, 'organization_legacy', 'Nested fixture', '', 'active', 'principal_local', ?, ?)`,
  ).run(designSystemId, createdAt, createdAt);
  for (const [definition, componentSource] of [
    [parentDefinition, parentSource],
    [nestedDefinition, nestedSource],
  ] as const) {
    const sourceJson = canonicalComponentSourceBundleJson(componentSource);
    const sourceHash = createHash("sha256").update(canonicalComponentSourceBundleBytes(componentSource)).digest("hex");
    database.sqlite.prepare(
      `INSERT INTO component_definitions
       (design_system_id, component_id, version, status, definition_json, replacement_component_id,
        source_json, source_hash, created_by, created_at)
       VALUES (?, ?, 1, 'published', ?, NULL, ?, ?, 'principal_local', ?)`,
    ).run(designSystemId, definition.id, canonicalJson(definition), sourceJson, sourceHash, createdAt);
  }
  const componentVersions = [
    { component_definition_id: parentDefinition.id, version: 1 },
    ...(options.selectNested ? [{ component_definition_id: nestedDefinition.id, version: 1 }] : []),
  ];
  const release = DesignSystemReleaseSchema.parse({
    id: releaseId,
    design_system_id: designSystemId,
    version: 1,
    name: "Nested fixture release",
    status: "published",
    token_ids: [],
    component_versions: componentVersions,
    created_at: createdAt,
    published_at: createdAt,
  });
  const envelope = {
    format: "formaspec-design-system-release" as const,
    format_version: 1 as const,
    release,
    token_versions: [],
    component_versions: componentVersions,
    diagnostics: [],
  };
  database.sqlite.prepare(
    `INSERT INTO design_system_releases
     (id, design_system_id, version, name, status, release_json, created_by, created_at, published_at)
     VALUES (?, ?, 1, ?, 'published', ?, 'principal_local', ?, ?)`,
  ).run(releaseId, designSystemId, release.name, canonicalJson(envelope), createdAt, createdAt);
  return {
    document: { ...document, design_system: {
      design_system_id: designSystemId,
      release_id: releaseId,
      release_version: 1,
    } },
    parentComponentId,
    nestedComponentId,
  };
}

describe("pinned component release resolution", () => {
  it("resolves every FormaSpec Foundation component to a verified bounded source", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const document = migrateDesignDocumentV1ToV2(createStarterDocument({
      now: "2026-07-21T09:00:00.000Z",
      idFactory: createSequentialIdFactory("foundationresolver"),
    }), { migratedAt: "2026-07-21T09:01:00.000Z" });

    expect(document.design_system.release_id).toBe(FORMASPEC_FOUNDATION_RELEASE_ID);
    for (const selection of FORMASPEC_FOUNDATION_SYSTEM.release.component_versions) {
      const resolved = resolvePinnedComponentRelease(
        database,
        "organization_legacy",
        document,
        selection.component_definition_id,
      );
      expect(resolved).toMatchObject({
        designSystemId: FORMASPEC_FOUNDATION_SYSTEM.id,
        releaseId: FORMASPEC_FOUNDATION_RELEASE_ID,
        releaseVersion: FORMASPEC_FOUNDATION_SYSTEM.release.version,
        definition: { id: selection.component_definition_id, version: selection.version },
        source: {
          component_definition_id: selection.component_definition_id,
          component_version: selection.version,
        },
      });
      expect(resolved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(resolved.source.nodes.length).toBeGreaterThan(0);
    }

    const catalog = listPinnedComponentRelease(database, "organization_legacy", document);
    expect(catalog).toMatchObject({
      designSystemId: FORMASPEC_FOUNDATION_SYSTEM.id,
      releaseId: FORMASPEC_FOUNDATION_RELEASE_ID,
      releaseVersion: FORMASPEC_FOUNDATION_SYSTEM.release.version,
      releaseName: FORMASPEC_FOUNDATION_SYSTEM.release.name,
    });
    expect(catalog.components).toHaveLength(FORMASPEC_FOUNDATION_SYSTEM.release.component_versions.length);
    expect(catalog.components.every((component) => component.insertable
      && component.sourceHash?.match(/^[a-f0-9]{64}$/)
      && component.sourceNodeCount > 0
      && component.blockers.length === 0)).toBe(true);
    expect(catalog.components.map((component) => component.definition.name)).toEqual(
      [...catalog.components.map((component) => component.definition.name)].sort((left, right) => left.localeCompare(right)),
    );
  });

  it("resolves nested component graphs from a persisted published release", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const fixture = nestedReleaseFixture(database, { selectNested: true });

    const resolved = resolvePinnedComponentRelease(
      database,
      "organization_legacy",
      fixture.document,
      fixture.parentComponentId,
    );
    expect(resolved.nestedComponents).toHaveLength(1);
    expect(resolved.nestedComponents[0]).toMatchObject({
      definition: { id: fixture.nestedComponentId, version: 1 },
      source: { component_definition_id: fixture.nestedComponentId, component_version: 1 },
    });

    const catalog = listPinnedComponentRelease(database, "organization_legacy", fixture.document);
    const parent = catalog.components.find((component) => component.definition.id === fixture.parentComponentId);
    expect(parent).toMatchObject({
      insertable: true,
      sourceNodeCount: 3,
      blockers: [],
    });
  });

  it("marks a persisted catalog component blocked when its nested version is absent from the release", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const fixture = nestedReleaseFixture(database, { selectNested: false });

    const catalog = listPinnedComponentRelease(database, "organization_legacy", fixture.document);
    const parent = catalog.components.find((component) => component.definition.id === fixture.parentComponentId);
    expect(parent).toMatchObject({
      insertable: false,
      blockers: [{ code: "NESTED_COMPONENT_UNAVAILABLE" }],
    });
    expect(parent?.blockers[0]?.message).toMatch(/nested released component dependency/i);
  });
});

import { describe, expect, it } from "vitest";

import {
  applyOperations,
  createComponentNode,
  createIconNode,
  createImageNode,
  createInstanceNode,
  createSequentialIdFactory,
  createStarterDocument,
  lintDesignDocumentV2,
  mergeV1CompatibilityDocument,
  toV1CompatibleDesignDocument,
  validateDesignDocument,
  V2CompatibilityError,
} from "./index.js";
import { DesignDocumentSchema } from "./model.js";
import { DesignDocumentV2Schema } from "./model-v2.js";
import { migrateV1ToV2 } from "./migration-v2.js";
import { PLANNING_SECTIONS, ProductSpecificationSchema } from "./product-spec.js";
import { resolveDesignToken, type DesignSystemToken } from "./design-system.js";
import { FORMASPEC_FOUNDATION_PATTERNS, FORMASPEC_FOUNDATION_SYSTEM } from "./foundation-system.js";

describe("FormaSpec V2", () => {
  it("keeps the guided planning workflow at exactly 22 sections", () => {
    expect(PLANNING_SECTIONS).toHaveLength(22);
    expect(PLANNING_SECTIONS[0]).toBe("product_purpose");
    expect(PLANNING_SECTIONS.at(-1)).toBe("open_questions");
  });

  it("rejects unknown product-specification properties", () => {
    expect(() => ProductSpecificationSchema.parse({
      id: "spec_fixture_00000001",
      version: 1,
      natural_language_brief: "",
      summary: "",
      goals: [],
      non_goals: [],
      audiences: [],
      roles: [],
      entities: [],
      flows: [],
      business_rules: [],
      permissions: [],
      validations: [],
      screen_states: [],
      integrations: [],
      analytics_events: [],
      accessibility_requirements: [],
      non_functional_requirements: [],
      acceptance_criteria: [],
      assumptions: [],
      open_questions: [],
      raw_html: "<script />",
    })).toThrow();
  });

  it("detects typed token cycles", () => {
    const one = "token_fixture_00000001";
    const two = "token_fixture_00000002";
    const tokens: Record<string, DesignSystemToken> = {
      [one]: {
        id: one as DesignSystemToken["id"],
        path: "color.one",
        name: "One",
        family: "color",
        layer: "semantic",
        value: { token_id: two as DesignSystemToken["id"] },
        deprecated: false,
      },
      [two]: {
        id: two as DesignSystemToken["id"],
        path: "color.two",
        name: "Two",
        family: "color",
        layer: "semantic",
        value: { token_id: one as DesignSystemToken["id"] },
        deprecated: false,
      },
    };
    expect(() => resolveDesignToken(tokens, one)).toThrow(/Token cycle/);
  });

  it("migrates V1 deterministically while preserving stable IDs", () => {
    const ids = createSequentialIdFactory("v2fixture");
    const source = createStarterDocument({ name: "Legacy", now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const frame = Object.values(source.nodes)[0]!;
    const component = createComponentNode({ name: "Legacy button", component_key: "button.primary" }, ids);
    const instance = createInstanceNode({ component_id: component.id, overrides: { label: "Continue" } }, ids);
    if (frame.type !== "frame") throw new Error("fixture frame missing");
    frame.children.push(component.id, instance.id);
    source.nodes[component.id] = component;
    source.nodes[instance.id] = instance;
    const tokenId = ids("token");
    source.tokens[tokenId] = {
      id: tokenId,
      name: "Primary",
      path: "color.primary",
      kind: "color",
      value: "#2457ff",
      archived: false,
      metadata: {},
    };
    const validSource = DesignDocumentSchema.parse(source);

    const first = migrateV1ToV2(validSource, { migratedAt: "2026-02-01T00:00:00.000Z" });
    const second = migrateV1ToV2(validSource, { migratedAt: "2026-02-01T00:00:00.000Z" });

    expect(first).toEqual(second);
    expect(first.id).toBe(validSource.id);
    expect(first.pages[0]?.id).toBe(validSource.pages[0]?.id);
    expect(first.nodes[component.id]?.type).toBe("container");
    expect(first.nodes[instance.id]?.type).toBe("component_instance");
    expect(first.tokens[tokenId]?.layer).toBe("primitive");
    expect(first.migration?.legacy_component_overrides[instance.id]).toEqual({ label: "Continue" });
    expect(first.migration?.diagnostics.some((item) => item.code === "LEGACY_COMPONENT_OVERRIDES_QUARANTINED")).toBe(true);
    expect(toV1CompatibleDesignDocument(first)).toEqual(validSource);
  });

  it("projects a component instance to its exact active-state source root", () => {
    const ids = createSequentialIdFactory("v2activecomponentstate");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const frame = Object.values(source.nodes)[0]!;
    const component = createComponentNode({ name: "Stateful button", component_key: "button.stateful" }, ids);
    const instance = createInstanceNode({ component_id: component.id }, ids);
    if (frame.type !== "frame") throw new Error("fixture frame missing");
    frame.children.push(component.id, instance.id);
    source.nodes[component.id] = component;
    source.nodes[instance.id] = instance;

    const migrated = migrateV1ToV2(DesignDocumentSchema.parse(source), {
      migratedAt: "2026-02-01T00:00:00.000Z",
    });
    const migratedInstance = migrated.nodes[instance.id];
    if (!migratedInstance || migratedInstance.type !== "component_instance") {
      throw new Error("fixture component instance missing");
    }
    const definition = migrated.component_definitions[migratedInstance.component_definition_id];
    if (!definition) throw new Error("fixture component definition missing");
    const defaultRoot = migrated.nodes[definition.root_node_id];
    if (!defaultRoot || defaultRoot.type !== "container") throw new Error("fixture component root missing");
    const hoverRootId = ids("node");
    const hoverRoot = structuredClone(defaultRoot);
    hoverRoot.id = hoverRootId;
    hoverRoot.name = "Stateful button / Hover";
    hoverRoot.children = [];
    migrated.nodes[hoverRootId] = hoverRoot;
    const migratedFrame = migrated.nodes[frame.id];
    if (!migratedFrame || migratedFrame.type !== "frame") throw new Error("migrated frame missing");
    migratedFrame.children.push(hoverRootId);
    definition.states.push({ key: "hover", name: "Hover", node_id: hoverRootId });
    migratedInstance.active_state = "hover";

    const strict = DesignDocumentV2Schema.parse(migrated);
    const projected = toV1CompatibleDesignDocument(strict);
    const projectedInstance = projected.nodes[instance.id];
    expect(projectedInstance?.type).toBe("instance");
    if (!projectedInstance || projectedInstance.type !== "instance") throw new Error("projected instance missing");
    expect(projectedInstance.component_id).toBe(hoverRootId);

    const invalid = structuredClone(strict);
    const invalidInstance = invalid.nodes[instance.id];
    if (!invalidInstance || invalidInstance.type !== "component_instance") throw new Error("invalid fixture instance missing");
    invalidInstance.active_state = "pressed";
    expect(() => toV1CompatibleDesignDocument(invalid)).toThrowError(V2CompatibilityError);
  });

  it("treats archived detached component masters as valid reusable source trees", () => {
    const ids = createSequentialIdFactory("v2archivedcomponentmaster");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const frame = Object.values(source.nodes)[0]!;
    const component = createComponentNode({ name: "Archived master", component_key: "button.archived" }, ids);
    const instance = createInstanceNode({ component_id: component.id }, ids);
    if (frame.type !== "frame") throw new Error("fixture frame missing");
    frame.children.push(component.id, instance.id);
    source.nodes[component.id] = component;
    source.nodes[instance.id] = instance;
    const migrated = migrateV1ToV2(DesignDocumentSchema.parse(source), {
      migratedAt: "2026-02-01T00:00:00.000Z",
    });
    const definition = Object.values(migrated.component_definitions)[0]!;
    const master = migrated.nodes[definition.root_node_id];
    const migratedFrame = migrated.nodes[frame.id];
    if (!master || !migratedFrame || migratedFrame.type !== "frame") throw new Error("migrated master missing");
    migratedFrame.children = migratedFrame.children.filter((nodeId) => nodeId !== master.id);
    master.archived = true;
    master.locked = true;

    const strict = DesignDocumentV2Schema.parse(migrated);
    const v2Codes = new Set(lintDesignDocumentV2(strict).map((diagnostic) => diagnostic.code));
    expect(v2Codes).not.toContain("component_definition_detached");
    expect(v2Codes).not.toContain("component_state_node_missing");
    const projected = toV1CompatibleDesignDocument(strict);
    expect(projected.nodes[master.id]).toMatchObject({ type: "component", archived: false });
    const validationCodes = new Set(validateDesignDocument(projected).diagnostics.map((diagnostic) => diagnostic.code));
    expect(validationCodes).not.toContain("orphan_active_node");
    expect(validationCodes).not.toContain("invalid_component_reference");
    const edited = structuredClone(projected);
    const editedFrame = edited.nodes[frame.id];
    if (!editedFrame) throw new Error("projected frame missing");
    editedFrame.name = "Unrelated page edit";
    edited.revision += 1;
    edited.updated_at = "2026-03-01T00:00:00.000Z";
    const merged = mergeV1CompatibilityDocument(strict, edited);
    expect(merged.nodes[master.id]).toMatchObject({ archived: true, locked: true });
    const illegalSourceEdit = structuredClone(projected);
    illegalSourceEdit.nodes[master.id]!.name = "Illegal source edit";
    illegalSourceEdit.revision += 1;
    illegalSourceEdit.updated_at = "2026-03-01T00:00:00.000Z";
    expect(() => mergeV1CompatibilityDocument(strict, illegalSourceEdit)).toThrowError(V2CompatibilityError);
  });

  it("merges V1-compatible edits into a V2 snapshot without discarding V2-only fields", () => {
    const ids = createSequentialIdFactory("v2merge");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const migrated = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    const projected = toV1CompatibleDesignDocument(migrated);
    const frameId = projected.pages[0]!.children[0]!;
    const frame = projected.nodes[frameId]!;
    frame.name = "Edited through compatibility";
    frame.layout.x = 12.25;
    projected.revision += 1;
    projected.updated_at = "2026-03-01T00:00:00.000Z";

    const merged = mergeV1CompatibilityDocument(migrated, projected);

    expect(merged.schema_version).toBe(2);
    expect(merged.nodes[frameId]?.name).toBe("Edited through compatibility");
    expect(merged.nodes[frameId]?.layout.x).toBe(12.25);
    expect(merged.design_system).toEqual(migrated.design_system);
    expect(merged.product_specification).toEqual(migrated.product_specification);
    expect(merged.migration?.migrated_at).toBe("2026-02-01T00:00:00.000Z");
    expect(toV1CompatibleDesignDocument(merged).nodes[frameId]?.name).toBe("Edited through compatibility");
  });

  it("promotes the V1 accessibility compatibility field during deterministic migration", () => {
    const source = createStarterDocument({
      now: "2026-01-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("v1a11ylabel"),
    });
    const frameId = source.pages[0]!.children[0]!;
    const frame = source.nodes[frameId]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    frame.role = "button";
    frame.metadata.accessible_label = "Continue to payment";
    const image = createImageNode({ alt: "Receipt preview" }, createSequentialIdFactory("v1a11yimage"));
    const explicitImage = createImageNode({
      alt: "Decorative fallback",
      metadata: { accessible_label: "Explicit image label" },
    }, createSequentialIdFactory("v1a11yexplicitimage"));
    const icon = createIconNode({
      icon_name: "arrow-right",
      label: "Continue icon",
    }, createSequentialIdFactory("v1a11yicon"));
    frame.children.push(image.id, explicitImage.id, icon.id);
    source.nodes[image.id] = image;
    source.nodes[explicitImage.id] = explicitImage;
    source.nodes[icon.id] = icon;

    const migrated = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    expect(migrated.nodes[frameId]?.semantics.accessibility_label).toBe("Continue to payment");
    expect(migrated.nodes[image.id]?.semantics.accessibility_label).toBe("Receipt preview");
    expect(migrated.nodes[explicitImage.id]?.semantics.accessibility_label).toBe("Explicit image label");
    expect(migrated.nodes[icon.id]?.semantics.accessibility_label).toBe("Continue icon");
    expect(toV1CompatibleDesignDocument(migrated)).toEqual(source);
  });

  it("round-trips typed accessibility labels without losing V2 semantics or metadata", () => {
    const ids = createSequentialIdFactory("v2a11ylabel");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    source.revision = 1;
    const frameId = source.pages[0]!.children[0]!;
    const sourceFrame = source.nodes[frameId]!;
    if (sourceFrame.type !== "frame") throw new Error("Expected starter frame");
    sourceFrame.role = "button";

    const migrated = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    const migratedFrame = migrated.nodes[frameId]!;
    migratedFrame.semantics.accessibility_label = "Existing checkout label";
    migratedFrame.semantics.description = "Preserve this V2-only description.";
    migratedFrame.metadata.accessible_label = "Preserve this unrelated legacy metadata value.";
    migratedFrame.metadata.nested = { source: "enterprise" };
    expect(lintDesignDocumentV2(migrated).some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);

    const projected = toV1CompatibleDesignDocument(migrated);
    expect(projected.nodes[frameId]?.metadata.accessible_label).toBe("Existing checkout label");
    const edited = applyOperations(projected, [{
      type: "update_node",
      node_id: frameId,
      patch: { accessibility_label: "Review and pay" },
    }], {
      expectedRevision: projected.revision,
      now: "2026-03-01T00:00:00.000Z",
    }).document;
    const merged = mergeV1CompatibilityDocument(migrated, edited, {
      accessibilityLabelEdits: new Map([[frameId, "Review and pay"]]),
    });

    expect(merged.nodes[frameId]?.semantics).toMatchObject({
      role: "button",
      accessibility_label: "Review and pay",
      description: "Preserve this V2-only description.",
    });
    expect(merged.nodes[frameId]?.metadata).toEqual({
      preset: "web",
      accessible_label: "Preserve this unrelated legacy metadata value.",
      nested: { source: "enterprise" },
    });
    expect(toV1CompatibleDesignDocument(merged).nodes[frameId]?.metadata.accessible_label).toBe("Review and pay");
    expect(lintDesignDocumentV2(merged).some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);

    const untypedMetadataEdit = structuredClone(projected);
    untypedMetadataEdit.nodes[frameId]!.metadata.accessible_label = "Do not reinterpret generic metadata";
    untypedMetadataEdit.revision += 1;
    untypedMetadataEdit.updated_at = "2026-03-01T12:00:00.000Z";
    const untypedMerged = mergeV1CompatibilityDocument(migrated, untypedMetadataEdit);
    expect(untypedMerged.nodes[frameId]?.semantics.accessibility_label).toBe("Existing checkout label");
    expect(untypedMerged.nodes[frameId]?.metadata.accessible_label).toBe("Preserve this unrelated legacy metadata value.");

    const missingLabel = structuredClone(migrated);
    delete missingLabel.nodes[frameId]!.semantics.accessibility_label;
    delete missingLabel.nodes[frameId]!.metadata.accessible_label;
    expect(lintDesignDocumentV2(missingLabel).some((item) => item.code === "interactive_accessible_name_missing")).toBe(true);
    const missingProjection = toV1CompatibleDesignDocument(missingLabel);
    const directPromotion = mergeV1CompatibilityDocument(missingLabel, missingProjection, {
      accessibilityLabelEdits: new Map([[frameId, "Direct typed promotion"]]),
    });
    expect(directPromotion.nodes[frameId]?.semantics.accessibility_label).toBe("Direct typed promotion");
    const labeledProjection = applyOperations(missingProjection, [{
      type: "update_node",
      node_id: frameId,
      patch: { accessibility_label: "Review and pay" },
    }], {
      expectedRevision: missingProjection.revision,
      now: "2026-03-02T00:00:00.000Z",
    }).document;
    const labeled = mergeV1CompatibilityDocument(missingLabel, labeledProjection, {
      accessibilityLabelEdits: new Map([[frameId, "Review and pay"]]),
    });
    expect(labeled.nodes[frameId]?.semantics).toMatchObject({
      role: "button",
      accessibility_label: "Review and pay",
      description: "Preserve this V2-only description.",
    });
    expect(labeled.nodes[frameId]?.metadata).toEqual({ preset: "web", nested: { source: "enterprise" } });
    expect(lintDesignDocumentV2(labeled).some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);
  });

  it("rejects edits that would silently flatten V2-native token modes", () => {
    const ids = createSequentialIdFactory("v2native");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const tokenId = ids("token");
    source.tokens[tokenId] = {
      id: tokenId,
      name: "Surface",
      path: "color.surface",
      kind: "color",
      value: "#ffffff",
      archived: false,
      metadata: {},
    };
    const migrated = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    migrated.tokens[tokenId]!.modes = { dark: "#111111" };
    const strictV2 = DesignDocumentV2Schema.parse(migrated);
    const projected = toV1CompatibleDesignDocument(strictV2);
    projected.tokens[tokenId]!.value = "#eeeeee";
    projected.revision += 1;
    projected.updated_at = "2026-03-01T00:00:00.000Z";

    expect(() => mergeV1CompatibilityDocument(strictV2, projected)).toThrow(V2CompatibilityError);
    try {
      mergeV1CompatibilityDocument(strictV2, projected);
    } catch (error) {
      expect((error as V2CompatibilityError).issues[0]?.code).toBe("V2_TOKEN_EDIT_UNSUPPORTED");
    }
  });

  it("rejects a V2 active node with multiple parents", () => {
    const ids = createSequentialIdFactory("v2parents");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const migrated = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    const frameId = migrated.pages[0]!.children[0]!;
    migrated.pages[0]!.children.push(frameId);
    expect(() => DesignDocumentV2Schema.parse(migrated)).toThrow(/exactly one parent/);
  });

  it("ships the complete licensed FormaSpec Foundation catalog", () => {
    expect(Object.keys(FORMASPEC_FOUNDATION_SYSTEM.components)).toHaveLength(26);
    expect(FORMASPEC_FOUNDATION_PATTERNS).toHaveLength(15);
    expect(FORMASPEC_FOUNDATION_SYSTEM.fonts).toEqual([
      { family: "Inter", license: "OFL-1.1" },
      { family: "Vazirmatn", license: "OFL-1.1" },
    ]);
    expect(FORMASPEC_FOUNDATION_SYSTEM.release.component_versions).toHaveLength(26);
    expect(Object.values(FORMASPEC_FOUNDATION_SYSTEM.components).every((component) => component.status === "published")).toBe(true);
  });
});

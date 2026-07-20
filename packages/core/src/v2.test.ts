import { describe, expect, it } from "vitest";

import {
  createComponentNode,
  createInstanceNode,
  createSequentialIdFactory,
  createStarterDocument,
  mergeV1CompatibilityDocument,
  toV1CompatibleDesignDocument,
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

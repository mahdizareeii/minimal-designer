import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COMPONENT_SOURCE_MAX_CANONICAL_BYTES,
  COMPONENT_SOURCE_MAX_DEPTH,
  ComponentSourceBundleSchema,
  LegacyNullComponentSourceSchema,
  canonicalComponentSourceBundleBytes,
  canonicalComponentSourceBundleJson,
  componentSourceBundleSha256,
  parseComponentSourceBundle,
  parseLegacyNullComponentSource,
} from "./component-source.js";

const componentId = "component_source_button_0001";
const defaultRootId = "node_component_source_default_root";
const defaultLabelId = "node_component_source_default_label";
const defaultImageId = "node_component_source_default_image";
const hoverRootId = "node_component_source_hover_root";
const hoverLabelId = "node_component_source_hover_label";
const colorTokenId = "token_component_source_color_01";
const spacingTokenId = "token_component_source_spacing_01";
const imageAssetId = "asset_component_source_image_01";

function semantics(role: "button" | "image" | "generic" = "generic") {
  return {
    role,
    business_rule_ids: [],
    acceptance_criterion_ids: [],
  };
}

function layout(input: { width?: number; height?: number; mode?: "absolute" | "horizontal" | "vertical" } = {}) {
  return {
    x: 0,
    y: 0,
    width: input.width ?? 200,
    height: input.height ?? 48,
    mode: input.mode ?? "absolute",
    width_sizing: "fixed",
    height_sizing: "fixed",
  };
}

function validBundle(): Record<string, unknown> {
  return {
    format: "formaspec-component-source",
    format_version: 1,
    schema_version: 2,
    component_definition_id: componentId,
    component_version: 3,
    root_node_id: defaultRootId,
    states: [
      { key: "hover", name: "Hover", root_node_id: hoverRootId },
      { key: "default", name: "Default", root_node_id: defaultRootId },
    ],
    nodes: [
      {
        id: hoverLabelId,
        name: "Hover label",
        type: "text",
        content: "Continue",
        direction: "auto",
        layout: layout({ width: 160, height: 24 }),
        style: { color: { token_id: colorTokenId } },
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics(),
        metadata: { z: "last", a: "first" },
      },
      {
        id: defaultRootId,
        name: "Button default",
        type: "container",
        children: [defaultLabelId, defaultImageId],
        clip_content: true,
        layout: { ...layout({ mode: "horizontal" }), gap: { token_id: spacingTokenId } },
        style: { fill: { token_id: colorTokenId } },
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics("button"),
        metadata: {},
      },
      {
        id: defaultImageId,
        name: "Button icon",
        type: "image",
        asset_id: imageAssetId,
        alt: "Continue",
        object_fit: "contain",
        layout: layout({ width: 24, height: 24 }),
        style: {},
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics("image"),
        metadata: {},
      },
      {
        id: hoverRootId,
        name: "Button hover",
        type: "container",
        children: [hoverLabelId],
        clip_content: true,
        layout: { ...layout({ mode: "horizontal" }), gap: { token_id: spacingTokenId } },
        style: { fill: { token_id: colorTokenId } },
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics("button"),
        metadata: {},
      },
      {
        id: defaultLabelId,
        name: "Default label",
        type: "text",
        content: "Continue",
        direction: "auto",
        layout: layout({ width: 160, height: 24 }),
        style: { color: { token_id: colorTokenId } },
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics(),
        metadata: { a: "first", z: "last" },
      },
    ],
    prototype_links: [{
      id: "link_component_source_back_01",
      source_node_id: defaultRootId,
      trigger: { type: "click" },
      action: { type: "back" },
      metadata: {},
    }],
    dependencies: {
      token_ids: [spacingTokenId, colorTokenId],
      asset_ids: [imageAssetId],
    },
  };
}

function mutableBundle(): Record<string, any> {
  return structuredClone(validBundle()) as Record<string, any>;
}

describe("component source bundles", () => {
  it("parses one immutable canonical V2 bundle and hashes equivalent ordering identically", async () => {
    const first = validBundle();
    const reordered = mutableBundle();
    reordered.states.reverse();
    reordered.nodes.reverse();
    reordered.prototype_links.reverse();
    reordered.dependencies.token_ids.reverse();
    const label = reordered.nodes.find((node: { id: string }) => node.id === defaultLabelId);
    label.metadata = { z: "last", a: "first" };

    const parsed = parseComponentSourceBundle(first);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.component_definition_id).toBe(componentId);
    expect(parsed.component_version).toBe(3);
    expect(parsed.states.map((state) => state.key)).toEqual(["default", "hover"]);
    expect(parsed.nodes.map((node) => node.id)).toEqual([...parsed.nodes.map((node) => node.id)].sort());
    expect(parsed.dependencies.token_ids).toEqual([colorTokenId, spacingTokenId]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.nodes)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0])).toBe(true);
    expect(Object.isFrozen(parsed.dependencies)).toBe(true);
    expect(() => (parsed.nodes as unknown as unknown[]).push({})).toThrow();

    const firstJson = canonicalComponentSourceBundleJson(first);
    const reorderedJson = canonicalComponentSourceBundleJson(reordered);
    expect(reorderedJson).toBe(firstJson);
    expect([...canonicalComponentSourceBundleBytes(first)]).toEqual([...new TextEncoder().encode(firstJson)]);
    const expectedHash = createHash("sha256").update(canonicalComponentSourceBundleBytes(first)).digest("hex");
    expect(await componentSourceBundleSha256(first)).toBe(expectedHash);
    expect(await componentSourceBundleSha256(reordered)).toBe(expectedHash);
  });

  it("rejects V1 input, unstable state metadata, duplicate IDs, and archived roots", () => {
    const v1 = mutableBundle();
    v1.schema_version = 1;
    expect(ComponentSourceBundleSchema.safeParse(v1).success).toBe(false);

    const mismatchedRoot = mutableBundle();
    mismatchedRoot.root_node_id = hoverRootId;
    expect(() => parseComponentSourceBundle(mismatchedRoot)).toThrow(/default state root/);

    const duplicateState = mutableBundle();
    duplicateState.states.push({ key: "default", name: "Default duplicate", root_node_id: "node_duplicate_state_root_01" });
    expect(() => parseComponentSourceBundle(duplicateState)).toThrow(/Duplicate component source state key/);

    const duplicateNode = mutableBundle();
    duplicateNode.nodes.push(structuredClone(duplicateNode.nodes[0]));
    expect(() => parseComponentSourceBundle(duplicateNode)).toThrow(/Duplicate component source node id/);

    const archived = mutableBundle();
    archived.nodes.find((node: { id: string }) => node.id === defaultRootId).archived = true;
    expect(() => parseComponentSourceBundle(archived)).toThrow(/cannot be archived/);
  });

  it("requires detached, bounded, disjoint, renderable V2 state trees", () => {
    const frameRoot = mutableBundle();
    const frame = frameRoot.nodes.find((node: { id: string }) => node.id === defaultRootId);
    frame.type = "frame";
    frame.locale = "en";
    frame.text_direction = "ltr";
    expect(() => parseComponentSourceBundle(frameRoot)).toThrow(/V1-compatible container/);

    const externalChild = mutableBundle();
    externalChild.nodes.find((node: { id: string }) => node.id === defaultRootId).children.push("node_external_child_0001");
    expect(() => parseComponentSourceBundle(externalChild)).toThrow(/outside the bundle/);

    const attachedRoot = mutableBundle();
    attachedRoot.nodes.find((node: { id: string }) => node.id === defaultRootId).children.push(hoverRootId);
    expect(() => parseComponentSourceBundle(attachedRoot)).toThrow(/must be detached/);

    const cycle = mutableBundle();
    cycle.nodes.find((node: { id: string }) => node.id === defaultRootId).children.push(defaultRootId);
    expect(() => parseComponentSourceBundle(cycle)).toThrow(/cycle/);

    const nestedInstance = mutableBundle();
    const imageIndex = nestedInstance.nodes.findIndex((node: { id: string }) => node.id === defaultImageId);
    nestedInstance.nodes[imageIndex] = {
      id: defaultImageId,
      name: "Nested instance",
      type: "component_instance",
      component_definition_id: "component_nested_source_0001",
      component_version: 1,
      properties: {},
      slots: {},
      active_state: "default",
      layout: layout({ width: 24, height: 24 }),
      style: {},
      visible: true,
      locked: false,
      archived: false,
      semantics: semantics(),
      metadata: {},
    };
    nestedInstance.dependencies.asset_ids = [];
    expect(() => parseComponentSourceBundle(nestedInstance)).toThrow(/Nested component instances/);

    const externalRule = mutableBundle();
    externalRule.nodes[0].semantics.business_rule_ids = ["rule_component_external_01"];
    expect(() => parseComponentSourceBundle(externalRule)).toThrow(/external product rules/);
  });

  it("rejects source trees deeper than the explicit depth bound", () => {
    const nodes: Array<Record<string, unknown>> = [];
    for (let index = 0; index <= COMPONENT_SOURCE_MAX_DEPTH; index += 1) {
      const id = `node_component_depth_${String(index).padStart(8, "0")}`;
      const childId = index === COMPONENT_SOURCE_MAX_DEPTH
        ? null
        : `node_component_depth_${String(index + 1).padStart(8, "0")}`;
      nodes.push({
        id,
        name: `Depth ${index}`,
        type: "container",
        children: childId ? [childId] : [],
        clip_content: false,
        layout: layout(),
        style: {},
        visible: true,
        locked: false,
        archived: false,
        semantics: semantics(),
        metadata: {},
      });
    }
    const bundle = {
      ...validBundle(),
      root_node_id: nodes[0]!.id,
      states: [{ key: "default", name: "Default", root_node_id: nodes[0]!.id }],
      nodes,
      prototype_links: [],
      dependencies: { token_ids: [], asset_ids: [] },
    };
    expect(() => parseComponentSourceBundle(bundle)).toThrow(new RegExp(`depth exceeds ${COMPONENT_SOURCE_MAX_DEPTH}`));
  });

  it("requires exact declared token and asset dependencies", () => {
    const missingToken = mutableBundle();
    missingToken.dependencies.token_ids = [colorTokenId];
    expect(() => parseComponentSourceBundle(missingToken)).toThrow(/not declared as a component source dependency/);

    const missingAsset = mutableBundle();
    missingAsset.dependencies.asset_ids = [];
    expect(() => parseComponentSourceBundle(missingAsset)).toThrow(/Asset reference .* is not declared/);

    const unusedToken = mutableBundle();
    unusedToken.dependencies.token_ids.push("token_component_source_unused_01");
    expect(() => parseComponentSourceBundle(unusedToken)).toThrow(/unused by the component source bundle/);

    const duplicateAsset = mutableBundle();
    duplicateAsset.dependencies.asset_ids.push(imageAssetId);
    expect(() => parseComponentSourceBundle(duplicateAsset)).toThrow(/Duplicate asset dependency/);
  });

  it("rejects prototype links that leave the source bundle", () => {
    const outsideSource = mutableBundle();
    outsideSource.prototype_links[0].source_node_id = "node_component_source_outside_01";
    expect(() => parseComponentSourceBundle(outsideSource)).toThrow(/source must be inside/);

    const outsideTarget = mutableBundle();
    outsideTarget.prototype_links[0].action = {
      type: "navigate",
      page_id: "page_component_source_outside_01",
      node_id: defaultRootId,
    };
    expect(() => parseComponentSourceBundle(outsideTarget)).toThrow(/outside the component source bundle/);
  });

  it("rejects canonical payloads larger than one MiB", () => {
    const oversized = mutableBundle();
    oversized.nodes.find((node: { id: string }) => node.id === defaultRootId).metadata = {
      blob: "x".repeat(COMPONENT_SOURCE_MAX_CANONICAL_BYTES),
    };
    expect(() => parseComponentSourceBundle(oversized)).toThrow(/canonical bytes exceed/);
  });

  it("keeps legacy null compatibility separate and permanently non-publishable", () => {
    const legacy = parseLegacyNullComponentSource(null);
    expect(legacy).toEqual({ kind: "legacy_null", source: null, publishable: false });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(LegacyNullComponentSourceSchema.safeParse(validBundle()).success).toBe(false);
    expect(ComponentSourceBundleSchema.safeParse(null).success).toBe(false);
  });
});

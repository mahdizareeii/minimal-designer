import { z } from "zod";

import { AssetIdSchema, NodeIdSchema, TokenIdSchema } from "./ids.js";
import { isTokenReference } from "./model.js";
import {
  DesignNodeV2Schema,
  PrototypeLinkV2Schema,
  type DesignNodeV2,
} from "./model-v2.js";
import { ComponentDefinitionIdSchema } from "./product-spec.js";

export const COMPONENT_SOURCE_FORMAT_VERSION = 1 as const;
export const COMPONENT_SOURCE_SCHEMA_VERSION = 2 as const;
export const COMPONENT_SOURCE_MAX_STATES = 8 as const;
export const COMPONENT_SOURCE_MAX_NODES = 5_000 as const;
export const COMPONENT_SOURCE_MAX_PROTOTYPE_LINKS = 1_000 as const;
export const COMPONENT_SOURCE_MAX_TOKEN_DEPENDENCIES = 5_000 as const;
export const COMPONENT_SOURCE_MAX_ASSET_DEPENDENCIES = 1_000 as const;
export const COMPONENT_SOURCE_MAX_DEPTH = 256 as const;
export const COMPONENT_SOURCE_MAX_CANONICAL_BYTES = 1_048_576 as const;

export const ComponentSourceStateKeySchema = z.enum([
  "default",
  "hover",
  "pressed",
  "focused",
  "disabled",
  "loading",
  "error",
  "selected",
]);
export type ComponentSourceStateKey = z.infer<typeof ComponentSourceStateKeySchema>;

export const ComponentSourceStateSchema = z.object({
  key: ComponentSourceStateKeySchema,
  name: z.string().trim().min(1).max(240),
  root_node_id: NodeIdSchema,
}).strict();

export const ComponentSourceDependenciesSchema = z.object({
  token_ids: z.array(TokenIdSchema).max(COMPONENT_SOURCE_MAX_TOKEN_DEPENDENCIES),
  asset_ids: z.array(AssetIdSchema).max(COMPONENT_SOURCE_MAX_ASSET_DEPENDENCIES),
}).strict();

const ComponentSourceBundleObjectSchema = z.object({
  format: z.literal("formaspec-component-source"),
  format_version: z.literal(COMPONENT_SOURCE_FORMAT_VERSION),
  schema_version: z.literal(COMPONENT_SOURCE_SCHEMA_VERSION),
  component_definition_id: ComponentDefinitionIdSchema,
  component_version: z.number().int().positive(),
  root_node_id: NodeIdSchema,
  states: z.array(ComponentSourceStateSchema).min(1).max(COMPONENT_SOURCE_MAX_STATES),
  nodes: z.array(DesignNodeV2Schema).min(1).max(COMPONENT_SOURCE_MAX_NODES),
  prototype_links: z.array(PrototypeLinkV2Schema).max(COMPONENT_SOURCE_MAX_PROTOTYPE_LINKS),
  dependencies: ComponentSourceDependenciesSchema,
}).strict();

type ComponentSourceBundleData = z.infer<typeof ComponentSourceBundleObjectSchema>;
type ComponentSourcePrototypeLink = ComponentSourceBundleData["prototype_links"][number];

// Keep the schema-inferred data shape assignable to the command and renderer
// contracts that consume its nodes. Deep immutability is enforced at runtime;
// recursively mapping this type would turn Zod-branded strings and arrays into
// incompatible structural types at package boundaries.
export type ComponentSourceBundle = Readonly<ComponentSourceBundleData>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedBundle(bundle: ComponentSourceBundleData): ComponentSourceBundleData {
  return {
    ...bundle,
    states: [...bundle.states].sort((left, right) => compareCanonicalStrings(left.key, right.key)),
    nodes: [...bundle.nodes].sort((left, right) => compareCanonicalStrings(left.id, right.id)),
    prototype_links: [...bundle.prototype_links].sort((left, right) => compareCanonicalStrings(left.id, right.id)),
    dependencies: {
      token_ids: [...bundle.dependencies.token_ids].sort(compareCanonicalStrings),
      asset_ids: [...bundle.dependencies.asset_ids].sort(compareCanonicalStrings),
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCanonicalStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Component source contains a non-JSON value.");
}

function duplicateIndexes(values: readonly string[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) duplicates.push(index);
    else seen.add(value);
  }
  return duplicates;
}

function isContainer(node: DesignNodeV2): node is Extract<DesignNodeV2, { type: "frame" | "container" }> {
  return node.type === "frame" || node.type === "container";
}

function collectTokenReferences(
  value: unknown,
  path: Array<string | number>,
  references: Map<string, Array<string | number>>,
): void {
  if (isTokenReference(value)) {
    if (!references.has(value.token_id)) references.set(value.token_id, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTokenReferences(item, [...path, index], references));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectTokenReferences(child, [...path, key], references);
    }
  }
}

function validatePrototypeLinks(
  links: readonly ComponentSourcePrototypeLink[],
  nodeIds: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (const index of duplicateIndexes(links.map((link) => link.id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prototype_links", index, "id"],
      message: `Duplicate prototype link id: ${links[index]!.id}`,
    });
  }
  for (const [index, link] of links.entries()) {
    if (!nodeIds.has(link.source_node_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prototype_links", index, "source_node_id"],
        message: "Prototype link source must be inside the component source bundle.",
      });
    }
    if (link.action.type !== "back") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prototype_links", index, "action"],
        message: "Prototype actions may not target a page, node, or URL outside the component source bundle.",
      });
    }
  }
}

function validateDependencies(
  bundle: ComponentSourceBundleData,
  context: z.RefinementCtx,
): void {
  const declaredTokenIds = bundle.dependencies.token_ids;
  const declaredAssetIds = bundle.dependencies.asset_ids;
  for (const index of duplicateIndexes(declaredTokenIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependencies", "token_ids", index],
      message: `Duplicate token dependency: ${declaredTokenIds[index]}`,
    });
  }
  for (const index of duplicateIndexes(declaredAssetIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependencies", "asset_ids", index],
      message: `Duplicate asset dependency: ${declaredAssetIds[index]}`,
    });
  }

  const tokenReferences = new Map<string, Array<string | number>>();
  const assetReferences = new Map<string, Array<string | number>>();
  for (const [index, node] of bundle.nodes.entries()) {
    collectTokenReferences(node.layout, ["nodes", index, "layout"], tokenReferences);
    collectTokenReferences(node.style, ["nodes", index, "style"], tokenReferences);
    if (node.type === "component_instance") {
      collectTokenReferences(node.visual_overrides, ["nodes", index, "visual_overrides"], tokenReferences);
      for (const [propertyKey, value] of Object.entries(node.properties)) {
        if (value && typeof value === "object" && "asset_id" in value && typeof value.asset_id === "string"
          && !assetReferences.has(value.asset_id)) {
          assetReferences.set(value.asset_id, ["nodes", index, "properties", propertyKey, "asset_id"]);
        }
      }
    }
    if (node.type === "image" && node.asset_id !== undefined && !assetReferences.has(node.asset_id)) {
      assetReferences.set(node.asset_id, ["nodes", index, "asset_id"]);
    }
  }

  const tokenSet = new Set<string>(declaredTokenIds);
  const assetSet = new Set<string>(declaredAssetIds);
  for (const [tokenId, path] of tokenReferences) {
    if (!tokenSet.has(tokenId)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Token reference ${tokenId} is not declared as a component source dependency.`,
    });
  }
  for (const [assetId, path] of assetReferences) {
    if (!assetSet.has(assetId)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Asset reference ${assetId} is not declared as a component source dependency.`,
    });
  }
  for (const [index, tokenId] of declaredTokenIds.entries()) {
    if (!tokenReferences.has(tokenId)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependencies", "token_ids", index],
      message: `Token dependency ${tokenId} is unused by the component source bundle.`,
    });
  }
  for (const [index, assetId] of declaredAssetIds.entries()) {
    if (!assetReferences.has(assetId)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependencies", "asset_ids", index],
      message: `Asset dependency ${assetId} is unused by the component source bundle.`,
    });
  }
}

function validateSourceTrees(bundle: ComponentSourceBundleData, context: z.RefinementCtx): void {
  const nodeById = new Map<string, DesignNodeV2>();
  const nodeIndex = new Map<string, number>();
  for (const [index, node] of bundle.nodes.entries()) {
    if (nodeById.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "id"],
        message: `Duplicate component source node id: ${node.id}`,
      });
      continue;
    }
    nodeById.set(node.id, node);
    nodeIndex.set(node.id, index);
    if (node.archived) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes", index, "archived"],
      message: "Component source nodes cannot be archived.",
    });
    if (node.semantics.business_rule_ids.length > 0 || node.semantics.acceptance_criterion_ids.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "semantics"],
        message: "Detached component source nodes cannot reference external product rules or acceptance criteria.",
      });
    }
  }

  for (const index of duplicateIndexes(bundle.states.map((state) => state.key))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states", index, "key"],
      message: `Duplicate component source state key: ${bundle.states[index]!.key}`,
    });
  }
  for (const index of duplicateIndexes(bundle.states.map((state) => state.root_node_id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states", index, "root_node_id"],
      message: `Component states require distinct source roots: ${bundle.states[index]!.root_node_id}`,
    });
  }
  const defaultStates = bundle.states.filter((state) => state.key === "default");
  if (defaultStates.length !== 1) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["states"],
    message: "A component source bundle requires exactly one default state.",
  });
  if (defaultStates[0]?.root_node_id !== bundle.root_node_id) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["root_node_id"],
    message: "root_node_id must equal the default state root.",
  });

  const rootIds = new Set<string>(bundle.states.map((state) => state.root_node_id));
  for (const [stateIndex, state] of bundle.states.entries()) {
    const root = nodeById.get(state.root_node_id);
    if (!root) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states", stateIndex, "root_node_id"],
        message: "Component state root is missing from the source bundle.",
      });
      continue;
    }
    if (root.type !== "container") context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states", stateIndex, "root_node_id"],
      message: "Component state roots must be V1-compatible container nodes.",
    });
    if (root.archived) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states", stateIndex, "root_node_id"],
      message: "Component state roots cannot be archived.",
    });
    if (!root.visible) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states", stateIndex, "root_node_id"],
      message: "Component state roots must be visible.",
    });
  }

  const parentCounts = new Map<string, number>();
  for (const [index, node] of bundle.nodes.entries()) {
    if (!isContainer(node)) continue;
    const seenChildren = new Set<string>();
    for (const [childIndex, childId] of node.children.entries()) {
      if (seenChildren.has(childId)) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "children", childIndex],
        message: `Duplicate child reference: ${childId}`,
      });
      seenChildren.add(childId);
      if (!nodeById.has(childId)) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "children", childIndex],
        message: `Component source child ${childId} is outside the bundle.`,
      });
      parentCounts.set(childId, (parentCounts.get(childId) ?? 0) + 1);
    }
  }

  for (const [id, index] of nodeIndex) {
    const count = parentCounts.get(id) ?? 0;
    if (rootIds.has(id) && count !== 0) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes", index],
      message: `Component state root ${id} must be detached from every parent.`,
    });
    if (!rootIds.has(id) && count !== 1) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes", index],
      message: `Non-root component source node ${id} must have exactly one parent; found ${count}.`,
    });
  }

  const visiting = new Set<string>();
  const ownerByNode = new Map<string, string>();
  const visit = (nodeId: string, ownerRootId: string, depth: number): void => {
    if (depth > COMPONENT_SOURCE_MAX_DEPTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", nodeIndex.get(nodeId) ?? 0],
        message: `Component source depth exceeds ${COMPONENT_SOURCE_MAX_DEPTH}.`,
      });
      return;
    }
    if (visiting.has(nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", nodeIndex.get(nodeId) ?? 0],
        message: "Component source tree contains a cycle.",
      });
      return;
    }
    const existingOwner = ownerByNode.get(nodeId);
    if (existingOwner !== undefined) {
      if (existingOwner !== ownerRootId) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", nodeIndex.get(nodeId) ?? 0],
        message: "Component state trees must not share nodes.",
      });
      return;
    }
    const node = nodeById.get(nodeId);
    if (!node) return;
    ownerByNode.set(nodeId, ownerRootId);
    visiting.add(nodeId);
    if (isContainer(node)) {
      for (const childId of node.children) visit(childId, ownerRootId, depth + 1);
    }
    visiting.delete(nodeId);
  };
  for (const state of bundle.states) visit(state.root_node_id, state.root_node_id, 1);
  for (const [id, index] of nodeIndex) {
    if (!ownerByNode.has(id)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes", index],
      message: `Component source node ${id} is unreachable from every state root.`,
    });
  }
}

const ValidatedComponentSourceBundleSchema = ComponentSourceBundleObjectSchema.superRefine((bundle, context) => {
  validateSourceTrees(bundle, context);
  validatePrototypeLinks(bundle.prototype_links, new Set(bundle.nodes.map((node) => node.id)), context);
  validateDependencies(bundle, context);
  const canonicalByteLength = new TextEncoder().encode(canonicalJson(normalizedBundle(bundle))).byteLength;
  if (canonicalByteLength > COMPONENT_SOURCE_MAX_CANONICAL_BYTES) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [],
    message: `Component source canonical bytes exceed ${COMPONENT_SOURCE_MAX_CANONICAL_BYTES}.`,
  });
});

export const ComponentSourceBundleSchema: z.ZodType<ComponentSourceBundle, z.ZodTypeDef, unknown> =
  ValidatedComponentSourceBundleSchema.transform((bundle) => deepFreeze(normalizedBundle(bundle)));

export function parseComponentSourceBundle(value: unknown): ComponentSourceBundle {
  return ComponentSourceBundleSchema.parse(value);
}

export function canonicalComponentSourceBundleJson(value: unknown): string {
  return canonicalJson(parseComponentSourceBundle(value));
}

export function canonicalComponentSourceBundleBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalComponentSourceBundleJson(value)) as Uint8Array<ArrayBuffer>;
}

export async function componentSourceBundleSha256(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", canonicalComponentSourceBundleBytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LEGACY_NULL_COMPONENT_SOURCE = deepFreeze({
  kind: "legacy_null" as const,
  source: null,
  publishable: false as const,
});

export const LegacyNullComponentSourceSchema = z.null().transform(() => LEGACY_NULL_COMPONENT_SOURCE);
export type LegacyNullComponentSource = z.output<typeof LegacyNullComponentSourceSchema>;

export function parseLegacyNullComponentSource(value: unknown): LegacyNullComponentSource {
  return LegacyNullComponentSourceSchema.parse(value);
}

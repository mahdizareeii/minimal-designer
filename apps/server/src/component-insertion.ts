import { createHash } from "node:crypto";

import {
  AssetIdSchema,
  ComponentDefinitionSchema,
  ComponentInstanceNodeV2Schema,
  DesignAssetV2Schema,
  DesignDocumentV2Schema,
  DesignSystemTokenSchema,
  ParentReferenceSchema,
  TokenIdSchema,
  canonicalComponentSourceBundleBytes,
  parseComponentSourceBundle,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type ComponentSourceStateKey,
  type ComponentPropertyValue,
  type DesignDocumentV2,
  type DesignSystemToken,
  type InsertComponentInstanceOperation,
  type NodeId,
  type NodeStyle,
  type ParentReference,
} from "@designer/core";

import { materializeComponentSource } from "./component-materialization.js";
import { DomainError } from "./errors.js";

export interface PrepareComponentInsertionInput {
  document: DesignDocumentV2;
  designSystemId: string;
  definition: ComponentDefinition;
  source: ComponentSourceBundle;
  sourceHash: string;
  releaseTokens: Readonly<Record<string, DesignSystemToken>>;
  parent: ParentReference;
  instanceId: NodeId;
  activeState?: ComponentSourceStateKey;
  index?: number;
  position?: { x: number; y: number };
  name?: string;
  properties?: Record<string, ComponentPropertyValue>;
  slots?: Record<string, NodeId[]>;
  visualOverrides?: Partial<Record<NodeId, NodeStyle>>;
  assetCopies?: Array<{
    sourceAssetId: string;
    asset: DesignDocumentV2["assets"][string];
  }>;
  componentDependencies?: Array<{
    definition: ComponentDefinition;
    source: ComponentSourceBundle;
    sourceHash: string;
  }>;
}

export interface PreparedComponentInsertion {
  document: DesignDocumentV2;
  operation: InsertComponentInstanceOperation;
  createdNodeIds: NodeId[];
  hydratedTokenIds: string[];
  hydratedAssetIds: string[];
  nodeIdMapping: Record<string, NodeId>;
}

function sourceHash(source: ComponentSourceBundle): string {
  return createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex");
}

function tokenAliasTarget(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.token_id === "string" ? record.token_id : null;
}

function hydrateRequiredTokens(
  document: DesignDocumentV2,
  source: ComponentSourceBundle,
  releaseTokens: Readonly<Record<string, DesignSystemToken>>,
): string[] {
  const pending = [...source.dependencies.token_ids];
  const hydrated = new Set<string>();
  while (pending.length > 0) {
    const tokenId = pending.pop()!;
    if (hydrated.has(tokenId)) continue;
    const raw = releaseTokens[tokenId];
    if (!raw) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Pinned release does not provide component token dependency ${tokenId}.`,
        422,
        { details: { tokenId } },
      );
    }
    const token = DesignSystemTokenSchema.parse(raw);
    if (token.id !== tokenId) {
      throw new DomainError("INTERNAL_ERROR", "Pinned release token identity is inconsistent.", 500);
    }
    document.tokens[tokenId] = token;
    hydrated.add(tokenId);
    const valueAlias = tokenAliasTarget(token.value);
    if (valueAlias) pending.push(TokenIdSchema.parse(valueAlias));
    for (const modeValue of Object.values(token.modes ?? {})) {
      const modeAlias = tokenAliasTarget(modeValue);
      if (modeAlias) pending.push(TokenIdSchema.parse(modeAlias));
    }
  }
  return [...hydrated].sort();
}

function insertIntoParent(
  document: DesignDocumentV2,
  parent: ParentReference,
  instanceId: NodeId,
  index: number | undefined,
): void {
  let children: NodeId[];
  if ("page_id" in parent) {
    const page = document.pages.find((candidate) => candidate.id === parent.page_id && !candidate.archived);
    if (!page) throw new DomainError("NOT_FOUND", "Component insertion page not found.", 404);
    children = page.children;
  } else {
    const node = document.nodes[parent.node_id];
    if (!node || node.archived || (node.type !== "frame" && node.type !== "container")) {
      throw new DomainError("NOT_FOUND", "Component insertion container not found.", 404);
    }
    if (node.locked) {
      throw new DomainError("VALIDATION_FAILED", "A component cannot be inserted into a locked container.", 422);
    }
    children = node.children;
  }
  const insertionIndex = index ?? children.length;
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > children.length) {
    throw new DomainError("VALIDATION_FAILED", "Component insertion index is outside the parent bounds.", 422);
  }
  children.splice(insertionIndex, 0, instanceId);
}

function remapComponentAssets(
  document: DesignDocumentV2,
  source: ComponentSourceBundle,
  rawCopies: PrepareComponentInsertionInput["assetCopies"],
): { source: ComponentSourceBundle; hydratedAssetIds: string[] } {
  const required = new Set(source.dependencies.asset_ids);
  const copies = new Map<string, DesignDocumentV2["assets"][string]>();
  for (const rawCopy of rawCopies ?? []) {
    const sourceAssetId = AssetIdSchema.parse(rawCopy.sourceAssetId);
    const asset = DesignAssetV2Schema.parse(rawCopy.asset);
    if (!required.has(sourceAssetId)) continue;
    if (copies.has(sourceAssetId)) {
      throw new DomainError("VALIDATION_FAILED", "Component asset copies must map each declared source dependency exactly once.", 422, {
        details: { sourceAssetId },
      });
    }
    copies.set(sourceAssetId, asset);
  }
  if (copies.size !== required.size) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Component insertion requires a verified content-addressed copy for every asset dependency.",
      422,
      { details: { requiredAssetIds: [...required].sort(), copiedAssetIds: [...copies.keys()].sort() } },
    );
  }
  if (required.size === 0) return { source, hydratedAssetIds: [] };

  const remapped = structuredClone(source);
  const targetIds = new Map<string, string>();
  const hydratedAssetIds: string[] = [];
  for (const [sourceAssetId, asset] of copies) {
    targetIds.set(sourceAssetId, asset.id);
    const existing = document.assets[asset.id];
    if (existing && (existing.sha256 !== asset.sha256 || existing.mime_type !== asset.mime_type)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "A copied component asset ID conflicts with project asset metadata.", 409, {
        details: { assetId: asset.id },
      });
    }
    if (!existing) hydratedAssetIds.push(asset.id);
    document.assets[asset.id] = structuredClone(asset);
  }
  for (const node of remapped.nodes) {
    if (node.type === "image" && node.asset_id !== undefined) {
      const targetId = targetIds.get(node.asset_id);
      if (!targetId) {
        throw new DomainError("VALIDATION_FAILED", "Component image dependency has no copied target asset.", 422, {
          details: { assetId: node.asset_id },
        });
      }
      node.asset_id = AssetIdSchema.parse(targetId);
    }
    if (node.type === "component_instance") {
      for (const [propertyKey, value] of Object.entries(node.properties)) {
        if (!value || typeof value !== "object" || !("asset_id" in value)) continue;
        const targetId = targetIds.get(value.asset_id);
        if (targetId) node.properties[propertyKey] = { asset_id: AssetIdSchema.parse(targetId) };
      }
    }
  }
  remapped.dependencies.asset_ids = [...targetIds.values()].map((id) => AssetIdSchema.parse(id)).sort();
  return {
    source: parseComponentSourceBundle(remapped),
    hydratedAssetIds: hydratedAssetIds.sort(),
  };
}

export function prepareComponentInstanceInsertion(
  rawInput: PrepareComponentInsertionInput,
): PreparedComponentInsertion {
  let document = DesignDocumentV2Schema.parse(structuredClone(rawInput.document));
  const definition = ComponentDefinitionSchema.parse(rawInput.definition);
  const source = parseComponentSourceBundle(rawInput.source);
  const parent = ParentReferenceSchema.parse(rawInput.parent);
  const activeState = rawInput.activeState ?? "default";
  if (sourceHash(source) !== rawInput.sourceHash) {
    throw new DomainError("INTERNAL_ERROR", "Component source hash verification failed before insertion.", 500);
  }
  if (document.nodes[rawInput.instanceId]) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "The generated component instance ID already exists.", 409, {
      details: { instanceId: rawInput.instanceId },
    });
  }

  const hydratedTokenIds = new Set<string>();
  const hydratedAssetIds = new Set<string>();
  const dependencyNodeMappings: Record<string, Record<string, NodeId>> = {};
  for (const dependencyInput of rawInput.componentDependencies ?? []) {
    const dependencyDefinition = ComponentDefinitionSchema.parse(dependencyInput.definition);
    const dependencySource = parseComponentSourceBundle(dependencyInput.source);
    if (sourceHash(dependencySource) !== dependencyInput.sourceHash) {
      throw new DomainError("INTERNAL_ERROR", "Nested component source hash verification failed before insertion.", 500);
    }
    for (const tokenId of hydrateRequiredTokens(document, dependencySource, rawInput.releaseTokens)) hydratedTokenIds.add(tokenId);
    const remappedDependencyAssets = remapComponentAssets(document, dependencySource, rawInput.assetCopies);
    for (const assetId of remappedDependencyAssets.hydratedAssetIds) hydratedAssetIds.add(assetId);
    const materializedDependencyDefinition = structuredClone(dependencyDefinition);
    for (const property of materializedDependencyDefinition.properties_schema) {
      if (property.type === "asset" && property.default_asset_id !== undefined) {
        const copied = rawInput.assetCopies?.find((entry) => entry.sourceAssetId === property.default_asset_id);
        if (copied) property.default_asset_id = copied.asset.id;
      }
    }
    const dependency = materializeComponentSource(document, {
      designSystemId: rawInput.designSystemId,
      sourceHash: dependencyInput.sourceHash,
      definition: materializedDependencyDefinition,
      source: remappedDependencyAssets.source,
      dependencyNodeMappings,
    });
    document = dependency.document;
    dependencyNodeMappings[dependencyDefinition.id] = dependency.nodeIdMapping;
  }
  for (const tokenId of hydrateRequiredTokens(document, source, rawInput.releaseTokens)) hydratedTokenIds.add(tokenId);
  const remappedAssets = remapComponentAssets(document, source, rawInput.assetCopies);
  for (const assetId of remappedAssets.hydratedAssetIds) hydratedAssetIds.add(assetId);
  const materializedDefinition = structuredClone(definition);
  for (const property of materializedDefinition.properties_schema) {
    if (property.type === "asset" && property.default_asset_id !== undefined) {
      const copied = rawInput.assetCopies?.find((entry) => entry.sourceAssetId === property.default_asset_id);
      if (copied) property.default_asset_id = copied.asset.id;
    }
  }
  const materialized = materializeComponentSource(document, {
    designSystemId: rawInput.designSystemId,
    sourceHash: rawInput.sourceHash,
    definition: materializedDefinition,
    source: remappedAssets.source,
    dependencyNodeMappings,
  });
  const state = definition.states.find((candidate) => candidate.key === activeState);
  if (!state) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Component ${definition.id}@${definition.version} does not provide state ${activeState}.`,
      422,
    );
  }
  const sourceRoot = source.nodes.find((node) => node.id === state.node_id);
  if (!sourceRoot || sourceRoot.type !== "container") {
    throw new DomainError("INTERNAL_ERROR", "Verified component state root is unavailable.", 500);
  }

  const position = rawInput.position ?? { x: sourceRoot.layout.x, y: sourceRoot.layout.y };
  const properties = structuredClone(rawInput.properties ?? {});
  for (const property of materializedDefinition.properties_schema) {
    if (property.type !== "asset") continue;
    const value = properties[property.key];
    if (!value || typeof value !== "object" || !("asset_id" in value)) continue;
    const copied = rawInput.assetCopies?.find((entry) => entry.sourceAssetId === value.asset_id);
    if (copied) properties[property.key] = { asset_id: copied.asset.id };
  }
  const visualOverrides = Object.fromEntries(Object.entries(rawInput.visualOverrides ?? {}).flatMap(([sourceNodeId, style]) => {
    if (style === undefined) return [];
    const targetNodeId = materialized.nodeIdMapping[sourceNodeId];
    if (!targetNodeId) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Visual override target ${sourceNodeId} is outside the verified component source.`,
        422,
      );
    }
    return [[targetNodeId, structuredClone(style)]];
  }));
  const instance = ComponentInstanceNodeV2Schema.parse({
    id: rawInput.instanceId,
    name: rawInput.name?.trim() || definition.name,
    type: "component_instance",
    component_definition_id: definition.id,
    component_version: definition.version,
    properties,
    slots: structuredClone(rawInput.slots ?? {}),
    visual_overrides: visualOverrides,
    active_state: activeState,
    layout: {
      x: position.x,
      y: position.y,
      width: sourceRoot.layout.width,
      height: sourceRoot.layout.height,
      mode: "absolute",
      width_sizing: sourceRoot.layout.width_sizing,
      height_sizing: sourceRoot.layout.height_sizing,
      ...(sourceRoot.layout.rotation === undefined ? {} : { rotation: sourceRoot.layout.rotation }),
      ...(sourceRoot.layout.min_width === undefined ? {} : { min_width: sourceRoot.layout.min_width }),
      ...(sourceRoot.layout.max_width === undefined ? {} : { max_width: sourceRoot.layout.max_width }),
      ...(sourceRoot.layout.min_height === undefined ? {} : { min_height: sourceRoot.layout.min_height }),
      ...(sourceRoot.layout.max_height === undefined ? {} : { max_height: sourceRoot.layout.max_height }),
    },
    style: {},
    visible: true,
    locked: false,
    archived: false,
    semantics: structuredClone(sourceRoot.semantics),
    metadata: {
      formaspec_component_instance: {
        design_system_id: rawInput.designSystemId,
        component_definition_id: definition.id,
        component_version: definition.version,
        source_hash: rawInput.sourceHash,
      },
    },
  });
  materialized.document.nodes[instance.id] = instance;
  insertIntoParent(materialized.document, parent, instance.id, rawInput.index);

  const operation: InsertComponentInstanceOperation = {
    type: "insert_component_instance",
    parent,
    component_definition_id: definition.id,
    component_version: definition.version,
    source_hash: rawInput.sourceHash,
    instance_id: instance.id,
    active_state: activeState,
    properties: structuredClone(instance.properties),
    slots: structuredClone(instance.slots),
    visual_overrides: structuredClone(instance.visual_overrides),
    ...(rawInput.index === undefined ? {} : { index: rawInput.index }),
    ...(rawInput.position === undefined ? {} : { position: rawInput.position }),
  };
  const existingNodeIds = new Set(Object.keys(rawInput.document.nodes));
  const createdNodeIds = Object.keys(materialized.document.nodes)
    .filter((nodeId) => !existingNodeIds.has(nodeId))
    .sort() as NodeId[];
  return {
    document: DesignDocumentV2Schema.parse(materialized.document),
    operation,
    createdNodeIds,
    hydratedTokenIds: [...hydratedTokenIds].sort(),
    hydratedAssetIds: [...hydratedAssetIds].sort(),
    nodeIdMapping: materialized.nodeIdMapping,
  };
}

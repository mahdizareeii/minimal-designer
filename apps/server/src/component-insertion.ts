import { createHash } from "node:crypto";

import {
  ComponentDefinitionSchema,
  DesignDocumentV2Schema,
  DesignNodeV2Schema,
  DesignSystemTokenSchema,
  ParentReferenceSchema,
  TokenIdSchema,
  canonicalComponentSourceBundleBytes,
  parseComponentSourceBundle,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type ComponentSourceStateKey,
  type DesignDocumentV2,
  type DesignSystemToken,
  type InsertComponentInstanceOperation,
  type NodeId,
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
}

export interface PreparedComponentInsertion {
  document: DesignDocumentV2;
  operation: InsertComponentInstanceOperation;
  createdNodeIds: NodeId[];
  hydratedTokenIds: string[];
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

export function prepareComponentInstanceInsertion(
  rawInput: PrepareComponentInsertionInput,
): PreparedComponentInsertion {
  const document = DesignDocumentV2Schema.parse(structuredClone(rawInput.document));
  const definition = ComponentDefinitionSchema.parse(rawInput.definition);
  const source = parseComponentSourceBundle(rawInput.source);
  const parent = ParentReferenceSchema.parse(rawInput.parent);
  const activeState = rawInput.activeState ?? "default";
  if (sourceHash(source) !== rawInput.sourceHash) {
    throw new DomainError("INTERNAL_ERROR", "Component source hash verification failed before insertion.", 500);
  }
  if (source.dependencies.asset_ids.length > 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Component insertion is blocked until every normalized asset dependency can be copied by content hash.",
      422,
      { details: { assetIds: [...source.dependencies.asset_ids] } },
    );
  }
  if (document.nodes[rawInput.instanceId]) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "The generated component instance ID already exists.", 409, {
      details: { instanceId: rawInput.instanceId },
    });
  }

  const hydratedTokenIds = hydrateRequiredTokens(document, source, rawInput.releaseTokens);
  const materialized = materializeComponentSource(document, {
    designSystemId: rawInput.designSystemId,
    sourceHash: rawInput.sourceHash,
    definition,
    source,
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
  const instance = DesignNodeV2Schema.parse({
    id: rawInput.instanceId,
    name: rawInput.name?.trim() || definition.name,
    type: "component_instance",
    component_definition_id: definition.id,
    component_version: definition.version,
    properties: {},
    slots: {},
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
    hydratedTokenIds,
    nodeIdMapping: materialized.nodeIdMapping,
  };
}

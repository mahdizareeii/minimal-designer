import { createHash } from "node:crypto";

import {
  ComponentDefinitionSchema,
  DesignDocumentV2Schema,
  parseComponentSourceBundle,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type DesignDocumentV2,
  type DesignNodeV2,
  type NodeId,
} from "@designer/core";

import { DomainError } from "./errors.js";

export const COMPONENT_SOURCE_METADATA_KEY = "formaspec_component_source" as const;

interface MaterializedSourceMarker {
  kind: "design_system_component_source";
  design_system_id: string;
  component_definition_id: string;
  component_version: number;
  source_hash: string;
  source_node_id: string;
}

export interface MaterializeComponentInput {
  designSystemId: string;
  sourceHash: string;
  definition: ComponentDefinition;
  source: ComponentSourceBundle;
  updateInstances?: boolean;
}

export interface MaterializedComponentResult {
  document: DesignDocumentV2;
  nodeIdMapping: Record<string, NodeId>;
  removedNodeIds: NodeId[];
  changedInstanceIds: NodeId[];
}

function sourceMarker(node: DesignNodeV2): MaterializedSourceMarker | null {
  const value = node.metadata[COMPONENT_SOURCE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (marker.kind !== "design_system_component_source"
    || typeof marker.design_system_id !== "string"
    || typeof marker.component_definition_id !== "string"
    || !Number.isInteger(marker.component_version)
    || typeof marker.source_hash !== "string"
    || typeof marker.source_node_id !== "string") return null;
  return marker as unknown as MaterializedSourceMarker;
}

function mappedNodeId(input: MaterializeComponentInput, sourceNodeId: string): NodeId {
  const digest = createHash("sha256").update([
    "formaspec-component-source-v1",
    input.designSystemId,
    input.definition.id,
    String(input.definition.version),
    input.sourceHash,
    sourceNodeId,
  ].join("\u0000"), "utf8").digest("hex");
  return `node_library_${digest.slice(0, 40)}` as NodeId;
}

function assertSourceMatchesDefinition(
  definition: ComponentDefinition,
  source: ComponentSourceBundle,
): void {
  if (source.component_definition_id !== definition.id
    || source.component_version !== definition.version
    || source.root_node_id !== definition.root_node_id) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Component source identity does not match its immutable definition version.",
      422,
    );
  }
  const definitionStates = new Map(definition.states.map((state) => [state.key, state.node_id]));
  const sourceStates = new Map(source.states.map((state) => [state.key, state.root_node_id]));
  if (definitionStates.size !== sourceStates.size
    || [...definitionStates].some(([key, nodeId]) => sourceStates.get(key) !== nodeId)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Component source state roots do not match the immutable definition contract.",
      422,
    );
  }
}

function cloneMaterializedNode(
  node: DesignNodeV2,
  input: MaterializeComponentInput,
  mapping: ReadonlyMap<string, NodeId>,
): DesignNodeV2 {
  const clone = structuredClone(node);
  clone.id = mapping.get(node.id)!;
  clone.archived = true;
  clone.locked = true;
  clone.metadata = {
    ...clone.metadata,
    [COMPONENT_SOURCE_METADATA_KEY]: {
      kind: "design_system_component_source",
      design_system_id: input.designSystemId,
      component_definition_id: input.definition.id,
      component_version: input.definition.version,
      source_hash: input.sourceHash,
      source_node_id: node.id,
    },
  };
  if (clone.type === "frame" || clone.type === "container") {
    clone.children = clone.children.map((childId) => mapping.get(childId)!);
  }
  if (clone.type === "component_instance") {
    throw new DomainError("VALIDATION_FAILED", "Nested component sources cannot be materialized.", 422);
  }
  return clone;
}

export function materializeComponentSource(
  inputDocument: DesignDocumentV2,
  rawInput: MaterializeComponentInput,
): MaterializedComponentResult {
  const document = DesignDocumentV2Schema.parse(structuredClone(inputDocument));
  const definition = ComponentDefinitionSchema.parse(rawInput.definition);
  const source = parseComponentSourceBundle(rawInput.source);
  const input: MaterializeComponentInput = { ...rawInput, definition, source };
  if (!/^[a-f0-9]{64}$/.test(input.sourceHash)) {
    throw new DomainError("VALIDATION_FAILED", "Component source hash must be a SHA-256 value.", 422);
  }
  assertSourceMatchesDefinition(definition, source);

  const removedNodeIds = Object.values(document.nodes)
    .filter((node) => sourceMarker(node)?.component_definition_id === definition.id)
    .map((node) => node.id)
    .sort();
  for (const nodeId of removedNodeIds) delete document.nodes[nodeId];

  const mapping = new Map(source.nodes.map((node) => [node.id, mappedNodeId(input, node.id)]));
  for (const node of source.nodes) {
    const targetId = mapping.get(node.id)!;
    const existing = document.nodes[targetId];
    if (existing && sourceMarker(existing)?.component_definition_id !== definition.id) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "A deterministic component source node ID collided with project data.", 409, {
        details: { targetId },
      });
    }
    document.nodes[targetId] = cloneMaterializedNode(node, input, mapping);
  }

  const materializedDefinition = structuredClone(definition);
  materializedDefinition.root_node_id = mapping.get(source.root_node_id)!;
  materializedDefinition.states = materializedDefinition.states.map((state) => ({
    ...state,
    node_id: mapping.get(state.node_id)!,
  }));
  document.component_definitions[definition.id] = materializedDefinition;

  const availableStates = new Set(materializedDefinition.states.map((state) => state.key));
  const changedInstanceIds: NodeId[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "component_instance" || node.component_definition_id !== definition.id) continue;
    if (node.component_version === definition.version) continue;
    if (!rawInput.updateInstances) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `Component instance ${node.id} is pinned to version ${node.component_version}.`,
        409,
        { details: { componentDefinitionId: definition.id, targetVersion: definition.version } },
      );
    }
    if (!availableStates.has(node.active_state)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Component ${definition.id}@${definition.version} does not provide active state ${node.active_state}.`,
        422,
        { details: { nodeId: node.id, activeState: node.active_state } },
      );
    }
    node.component_version = definition.version;
    changedInstanceIds.push(node.id);
  }

  return {
    document: DesignDocumentV2Schema.parse(document),
    nodeIdMapping: Object.fromEntries([...mapping].sort(([left], [right]) => left.localeCompare(right))),
    removedNodeIds,
    changedInstanceIds: changedInstanceIds.sort(),
  };
}

export function materializedComponentSourceNodeIds(
  document: DesignDocumentV2,
  componentDefinitionId: string,
): NodeId[] {
  return Object.values(document.nodes)
    .filter((node) => sourceMarker(node)?.component_definition_id === componentDefinitionId)
    .map((node) => node.id)
    .sort();
}

import { createHash } from "node:crypto";

import {
  ComponentDefinitionIdSchema,
  ComponentDefinitionSchema,
  ComponentSourceBundleSchema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM,
  canonicalComponentSourceBundleBytes,
  canonicalComponentSourceBundleJson,
  isTokenReference,
  parseComponentSourceBundle,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type DesignDocumentV2,
  type DesignNodeV2,
  type DesignSystemToken,
} from "@designer/core";
import { z } from "zod";

import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

const releaseEnvelopeSchema = z.object({
  format: z.literal("formaspec-design-system-release"),
  format_version: z.literal(1),
  release: DesignSystemReleaseSchema,
  token_versions: z.array(z.object({
    token_id: z.string().regex(/^token_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
    version: z.number().int().positive(),
  }).strict()).max(20_000),
  component_versions: z.array(z.object({
    component_definition_id: ComponentDefinitionIdSchema,
    version: z.number().int().positive(),
  }).strict()).max(5_000),
  diagnostics: z.array(z.unknown()).max(20_000),
}).strict();

export interface ResolvedPinnedComponentRelease {
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  definition: ComponentDefinition;
  source: ComponentSourceBundle;
  sourceHash: string;
  releaseTokens: Record<string, DesignSystemToken>;
}

function collectTokenReferences(value: unknown, tokenIds: Set<string>): void {
  if (isTokenReference(value)) {
    tokenIds.add(value.token_id);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectTokenReferences(child, tokenIds);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectTokenReferences(child, tokenIds);
  }
}

function foundationComponentSource(definition: ComponentDefinition): ComponentSourceBundle {
  const captured = new Set<string>();
  const nodes: DesignNodeV2[] = [];
  for (const state of definition.states) {
    const pending = [state.node_id];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (captured.has(nodeId)) continue;
      const node = FORMASPEC_FOUNDATION_SYSTEM.nodes[nodeId];
      if (!node) throw new DomainError("INTERNAL_ERROR", "FormaSpec Foundation component source is incomplete.", 500);
      captured.add(nodeId);
      nodes.push(node);
      if (node.type === "frame" || node.type === "container") {
        for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
      }
    }
  }
  const tokenIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const node of nodes) {
    collectTokenReferences(node.layout, tokenIds);
    collectTokenReferences(node.style, tokenIds);
    if (node.type === "image" && node.asset_id) assetIds.add(node.asset_id);
  }
  return ComponentSourceBundleSchema.parse({
    format: "formaspec-component-source",
    format_version: 1,
    schema_version: 2,
    component_definition_id: definition.id,
    component_version: definition.version,
    root_node_id: definition.root_node_id,
    states: definition.states.map((state) => ({
      key: state.key,
      name: state.name,
      root_node_id: state.node_id,
    })),
    nodes,
    prototype_links: [],
    dependencies: {
      token_ids: [...tokenIds].sort(),
      asset_ids: [...assetIds].sort(),
    },
  });
}

function verifiedSource(
  definition: ComponentDefinition,
  version: number,
  sourceJson: string | null,
  sourceHash: string | null,
): { source: ComponentSourceBundle; sourceHash: string } {
  if (sourceJson === null || sourceHash === null) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Component ${definition.id}@${version} has no verified source bundle.`,
      422,
    );
  }
  const source = parseComponentSourceBundle(JSON.parse(sourceJson) as unknown);
  const canonical = canonicalComponentSourceBundleJson(source);
  const hash = createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex");
  if (canonical !== sourceJson
    || hash !== sourceHash
    || source.component_definition_id !== definition.id
    || source.component_version !== version
    || source.root_node_id !== definition.root_node_id) {
    throw new DomainError("INTERNAL_ERROR", "Pinned component source integrity verification failed.", 500);
  }
  return { source, sourceHash: hash };
}

export function resolvePinnedComponentRelease(
  database: DesignerDatabase,
  organizationId: string,
  document: DesignDocumentV2,
  rawComponentDefinitionId: string,
): ResolvedPinnedComponentRelease {
  const componentDefinitionId = ComponentDefinitionIdSchema.parse(rawComponentDefinitionId);
  const pin = document.design_system;
  if (pin.release_id === FORMASPEC_FOUNDATION_RELEASE_ID) {
    if (pin.design_system_id !== FORMASPEC_FOUNDATION_SYSTEM.id
      || pin.release_version !== FORMASPEC_FOUNDATION_SYSTEM.release.version) {
      throw new DomainError("INTERNAL_ERROR", "FormaSpec Foundation pin metadata is inconsistent.", 500);
    }
    const selected = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions.find(
      (candidate) => candidate.component_definition_id === componentDefinitionId,
    );
    const definition = FORMASPEC_FOUNDATION_SYSTEM.components[componentDefinitionId];
    if (!selected || !definition || selected.version !== definition.version) {
      throw new DomainError("NOT_FOUND", "Component is not selected in the pinned FormaSpec Foundation release.", 404);
    }
    const source = foundationComponentSource(definition);
    const sourceHash = createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex");
    const releaseTokens = Object.fromEntries(FORMASPEC_FOUNDATION_SYSTEM.release.token_ids.map((tokenId) => {
      const token = FORMASPEC_FOUNDATION_SYSTEM.tokens[tokenId];
      if (!token) throw new DomainError("INTERNAL_ERROR", "FormaSpec Foundation token selection is incomplete.", 500);
      return [tokenId, token];
    }));
    return {
      designSystemId: pin.design_system_id,
      releaseId: pin.release_id,
      releaseVersion: pin.release_version,
      definition,
      source,
      sourceHash,
      releaseTokens,
    };
  }

  const releaseRow = database.sqlite.prepare(
    `SELECT release.id, release.design_system_id, release.version, release.status, release.release_json
     FROM design_system_releases release
     JOIN design_systems system ON system.id = release.design_system_id
     WHERE release.id = ? AND release.design_system_id = ? AND release.version = ?
       AND system.organization_id = ?`,
  ).get(pin.release_id, pin.design_system_id, pin.release_version, organizationId) as {
    id: string;
    design_system_id: string;
    version: number;
    status: "draft" | "published" | "deprecated";
    release_json: string;
  } | undefined;
  if (!releaseRow) throw new DomainError("NOT_FOUND", "Pinned design-system release not found.", 404);
  if (releaseRow.status === "draft") {
    throw new DomainError("VALIDATION_FAILED", "Draft design-system releases cannot supply project components.", 422);
  }
  const envelope = releaseEnvelopeSchema.parse(JSON.parse(releaseRow.release_json) as unknown);
  if (canonicalJson(envelope) !== releaseRow.release_json
    || envelope.release.id !== releaseRow.id
    || envelope.release.design_system_id !== releaseRow.design_system_id
    || envelope.release.version !== releaseRow.version
    || envelope.release.status !== releaseRow.status) {
    throw new DomainError("INTERNAL_ERROR", "Pinned design-system release integrity verification failed.", 500);
  }
  const selected = envelope.component_versions.find(
    (candidate) => candidate.component_definition_id === componentDefinitionId,
  );
  if (!selected) throw new DomainError("NOT_FOUND", "Component is not selected in the pinned release.", 404);
  const componentRow = database.sqlite.prepare(
    `SELECT definition_json, source_json, source_hash
     FROM component_definitions
     WHERE design_system_id = ? AND component_id = ? AND version = ?`,
  ).get(pin.design_system_id, componentDefinitionId, selected.version) as {
    definition_json: string;
    source_json: string | null;
    source_hash: string | null;
  } | undefined;
  if (!componentRow) throw new DomainError("INTERNAL_ERROR", "Pinned release component row is missing.", 500);
  const definition = ComponentDefinitionSchema.parse(JSON.parse(componentRow.definition_json) as unknown);
  if (canonicalJson(definition) !== componentRow.definition_json
    || definition.id !== componentDefinitionId
    || definition.version !== selected.version) {
    throw new DomainError("INTERNAL_ERROR", "Pinned component definition integrity verification failed.", 500);
  }
  const source = verifiedSource(definition, selected.version, componentRow.source_json, componentRow.source_hash);
  const releaseTokens: Record<string, DesignSystemToken> = {};
  for (const tokenSelection of envelope.token_versions) {
    const tokenRow = database.sqlite.prepare(
      `SELECT token_json FROM design_system_tokens
       WHERE design_system_id = ? AND token_id = ? AND version = ?`,
    ).get(pin.design_system_id, tokenSelection.token_id, tokenSelection.version) as { token_json: string } | undefined;
    if (!tokenRow) throw new DomainError("INTERNAL_ERROR", "Pinned release token row is missing.", 500);
    const token = DesignSystemTokenSchema.parse(JSON.parse(tokenRow.token_json) as unknown);
    if (canonicalJson(token) !== tokenRow.token_json || token.id !== tokenSelection.token_id) {
      throw new DomainError("INTERNAL_ERROR", "Pinned release token integrity verification failed.", 500);
    }
    releaseTokens[token.id] = token;
  }
  return {
    designSystemId: pin.design_system_id,
    releaseId: pin.release_id,
    releaseVersion: pin.release_version,
    definition,
    source: source.source,
    sourceHash: source.sourceHash,
    releaseTokens,
  };
}

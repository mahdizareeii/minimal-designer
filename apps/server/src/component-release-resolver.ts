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
  nestedComponents: ResolvedComponentSource[];
}

export interface ResolvedComponentSource {
  definition: ComponentDefinition;
  source: ComponentSourceBundle;
  sourceHash: string;
}

export interface PinnedComponentCatalogBlocker {
  code: "NO_VERIFIED_SOURCE" | "ASSET_COPY_UNAVAILABLE" | "NESTED_COMPONENT_UNAVAILABLE";
  message: string;
}

export interface PinnedComponentCatalogItem {
  definition: ComponentDefinition;
  sourceHash: string | null;
  sourceNodeCount: number;
  prototypeLinkCount: number;
  tokenDependencyIds: string[];
  assetDependencyIds: string[];
  insertable: boolean;
  blockers: PinnedComponentCatalogBlocker[];
}

export interface PinnedComponentReleaseCatalog {
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  releaseName: string;
  components: PinnedComponentCatalogItem[];
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

function nestedComponentReferences(source: ComponentSourceBundle): Array<{
  componentDefinitionId: string;
  componentVersion: number;
}> {
  const references = new Map<string, number>();
  for (const node of source.nodes) {
    if (node.type !== "component_instance") continue;
    const previous = references.get(node.component_definition_id);
    if (previous !== undefined && previous !== node.component_version) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Component source references ${node.component_definition_id} at conflicting versions.`,
        422,
      );
    }
    references.set(node.component_definition_id, node.component_version);
  }
  return [...references].sort(([left], [right]) => left.localeCompare(right)).map(([componentDefinitionId, componentVersion]) => ({
    componentDefinitionId,
    componentVersion,
  }));
}

function resolveComponentGraph(
  root: ResolvedComponentSource,
  load: (componentDefinitionId: string, componentVersion: number) => ResolvedComponentSource,
): ResolvedComponentSource[] {
  const resolved = new Map<string, ResolvedComponentSource>();
  const visiting = new Set<string>();
  const ordered: ResolvedComponentSource[] = [];
  const visit = (component: ResolvedComponentSource): void => {
    const key = `${component.definition.id}@${component.definition.version}`;
    if (resolved.has(key)) return;
    if (visiting.has(key)) {
      throw new DomainError("VALIDATION_FAILED", `Nested component dependency cycle detected at ${key}.`, 422);
    }
    if (resolved.size + visiting.size >= 100) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "A component may depend on at most 100 nested component versions.", 413);
    }
    visiting.add(key);
    for (const reference of nestedComponentReferences(component.source)) {
      visit(load(reference.componentDefinitionId, reference.componentVersion));
    }
    visiting.delete(key);
    resolved.set(key, component);
    ordered.push(component);
  };
  visit(root);
  return ordered;
}

function resolveCatalogComponentGraph(
  root: ResolvedComponentSource,
  load: (componentDefinitionId: string, componentVersion: number) => ResolvedComponentSource,
): { graph: ResolvedComponentSource[]; blockers: PinnedComponentCatalogBlocker[] } {
  try {
    return { graph: resolveComponentGraph(root, load), blockers: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      graph: [root],
      blockers: [{
        code: "NESTED_COMPONENT_UNAVAILABLE",
        message: `Insertion is blocked because a nested released component dependency is unavailable or invalid: ${error.message}`,
      }],
    };
  }
}

function foundationResolvedComponent(
  componentDefinitionId: string,
  componentVersion: number,
): ResolvedComponentSource {
  const selected = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions.find(
    (candidate) => candidate.component_definition_id === componentDefinitionId,
  );
  const definition = FORMASPEC_FOUNDATION_SYSTEM.components[componentDefinitionId];
  if (!selected || !definition || selected.version !== componentVersion || definition.version !== componentVersion) {
    throw new DomainError("VALIDATION_FAILED", "A nested component is not selected at the required version in the pinned FormaSpec Foundation release.", 422, {
      details: { componentDefinitionId, componentVersion },
    });
  }
  const source = foundationComponentSource(definition);
  return {
    definition,
    source,
    sourceHash: createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex"),
  };
}

function persistedResolvedComponent(
  database: DesignerDatabase,
  designSystemId: string,
  selectedVersions: ReadonlyMap<string, number>,
  componentDefinitionId: string,
  componentVersion: number,
): ResolvedComponentSource {
  if (selectedVersions.get(componentDefinitionId) !== componentVersion) {
    throw new DomainError("VALIDATION_FAILED", "A nested component is not selected at the required version in the pinned release.", 422, {
      details: { componentDefinitionId, componentVersion },
    });
  }
  const componentRow = database.sqlite.prepare(
    `SELECT definition_json, source_json, source_hash
     FROM component_definitions
     WHERE design_system_id = ? AND component_id = ? AND version = ?`,
  ).get(designSystemId, componentDefinitionId, componentVersion) as {
    definition_json: string;
    source_json: string | null;
    source_hash: string | null;
  } | undefined;
  if (!componentRow) throw new DomainError("INTERNAL_ERROR", "Pinned nested component row is missing.", 500);
  const definition = ComponentDefinitionSchema.parse(JSON.parse(componentRow.definition_json) as unknown);
  if (definition.id !== componentDefinitionId || definition.version !== componentVersion) {
    throw new DomainError("INTERNAL_ERROR", "Pinned nested component definition integrity verification failed.", 500);
  }
  const source = verifiedSource(definition, componentVersion, componentRow.source_json, componentRow.source_hash);
  return { definition, source: source.source, sourceHash: source.sourceHash };
}

function catalogItem(
  database: DesignerDatabase,
  organizationId: string,
  definition: ComponentDefinition,
  source: { source: ComponentSourceBundle; sourceHash: string } | null,
  componentGraph: readonly ResolvedComponentSource[] = [],
  dependencyBlockers: readonly PinnedComponentCatalogBlocker[] = [],
): PinnedComponentCatalogItem {
  if (!source) {
    const blockers: PinnedComponentCatalogBlocker[] = [{
      code: "NO_VERIFIED_SOURCE",
      message: "This historical component version has no verified immutable source bundle.",
    }];
    return {
      definition,
      sourceHash: null,
      sourceNodeCount: 0,
      prototypeLinkCount: 0,
      tokenDependencyIds: [],
      assetDependencyIds: [],
      insertable: false,
      blockers,
    };
  }
  const sources = componentGraph.length > 0
    ? componentGraph.map((component) => component.source)
    : [source.source];
  const assetDependencyIds = [...new Set(sources.flatMap((componentSource) => (
    componentSource.dependencies.asset_ids
  )))].sort();
  const tokenDependencyIds = [...new Set(sources.flatMap((componentSource) => (
    componentSource.dependencies.token_ids
  )))].sort();
  const availableAssetIds = assetDependencyIds.length === 0
    ? new Set<string>()
    : new Set((database.sqlite.prepare(
      `SELECT id FROM assets WHERE organization_id = ? AND id IN (${assetDependencyIds.map(() => "?").join(", ")})`,
    ).all(organizationId, ...assetDependencyIds) as Array<{ id: string }>).map((row) => row.id));
  const missingAssetIds = assetDependencyIds.filter((assetId) => !availableAssetIds.has(assetId));
  const blockers: PinnedComponentCatalogBlocker[] = [
    ...dependencyBlockers,
    ...(missingAssetIds.length > 0 ? [{
      code: "ASSET_COPY_UNAVAILABLE" as const,
      message: `Insertion is blocked because ${missingAssetIds.length} released asset dependency or dependencies are unavailable for verified content-hash copying.`,
    }] : []),
  ];
  return {
    definition,
    sourceHash: source.sourceHash,
    sourceNodeCount: sources.reduce((total, componentSource) => total + componentSource.nodes.length, 0),
    prototypeLinkCount: sources.reduce((total, componentSource) => total + componentSource.prototype_links.length, 0),
    tokenDependencyIds,
    assetDependencyIds,
    insertable: blockers.length === 0,
    blockers,
  };
}

export function listPinnedComponentRelease(
  database: DesignerDatabase,
  organizationId: string,
  document: DesignDocumentV2,
): PinnedComponentReleaseCatalog {
  const pin = document.design_system;
  if (pin.release_id === FORMASPEC_FOUNDATION_RELEASE_ID) {
    if (pin.design_system_id !== FORMASPEC_FOUNDATION_SYSTEM.id
      || pin.release_version !== FORMASPEC_FOUNDATION_SYSTEM.release.version) {
      throw new DomainError("INTERNAL_ERROR", "FormaSpec Foundation pin metadata is inconsistent.", 500);
    }
    const components = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions.map((selection) => {
      const definition = FORMASPEC_FOUNDATION_SYSTEM.components[selection.component_definition_id];
      if (!definition || definition.version !== selection.version) {
        throw new DomainError("INTERNAL_ERROR", "FormaSpec Foundation component selection is incomplete.", 500);
      }
      const source = foundationComponentSource(definition);
      const sourceHash = createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex");
      const resolved = { definition, source, sourceHash };
      const dependencies = resolveCatalogComponentGraph(resolved, foundationResolvedComponent);
      return catalogItem(
        database,
        organizationId,
        definition,
        { source, sourceHash },
        dependencies.graph,
        dependencies.blockers,
      );
    }).sort((left, right) => left.definition.name.localeCompare(right.definition.name)
      || left.definition.id.localeCompare(right.definition.id));
    return {
      designSystemId: pin.design_system_id,
      releaseId: pin.release_id,
      releaseVersion: pin.release_version,
      releaseName: FORMASPEC_FOUNDATION_SYSTEM.release.name,
      components,
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
  const selectedVersions = new Map(envelope.component_versions.map((selection) => [
    selection.component_definition_id,
    selection.version,
  ]));
  const components = envelope.component_versions.map((selection) => {
    const componentRow = database.sqlite.prepare(
      `SELECT definition_json, source_json, source_hash
       FROM component_definitions
       WHERE design_system_id = ? AND component_id = ? AND version = ?`,
    ).get(pin.design_system_id, selection.component_definition_id, selection.version) as {
      definition_json: string;
      source_json: string | null;
      source_hash: string | null;
    } | undefined;
    if (!componentRow) throw new DomainError("INTERNAL_ERROR", "Pinned release component row is missing.", 500);
    const definition = ComponentDefinitionSchema.parse(JSON.parse(componentRow.definition_json) as unknown);
    if (canonicalJson(definition) !== componentRow.definition_json
      || definition.id !== selection.component_definition_id
      || definition.version !== selection.version) {
      throw new DomainError("INTERNAL_ERROR", "Pinned component definition integrity verification failed.", 500);
    }
    if (componentRow.source_json === null && componentRow.source_hash === null) return catalogItem(database, organizationId, definition, null);
    const source = verifiedSource(
      definition,
      selection.version,
      componentRow.source_json,
      componentRow.source_hash,
    );
    const dependencies = resolveCatalogComponentGraph(
      { definition, source: source.source, sourceHash: source.sourceHash },
      (nestedId, nestedVersion) => persistedResolvedComponent(
        database,
        pin.design_system_id,
        selectedVersions,
        nestedId,
        nestedVersion,
      ),
    );
    return catalogItem(
      database,
      organizationId,
      definition,
      source,
      dependencies.graph,
      dependencies.blockers,
    );
  }).sort((left, right) => left.definition.name.localeCompare(right.definition.name)
    || left.definition.id.localeCompare(right.definition.id));
  return {
    designSystemId: pin.design_system_id,
    releaseId: pin.release_id,
    releaseVersion: pin.release_version,
    releaseName: envelope.release.name,
    components,
  };
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
    const graph = resolveComponentGraph(
      foundationResolvedComponent(definition.id, definition.version),
      foundationResolvedComponent,
    );
    const resolved = graph.at(-1)!;
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
      source: resolved.source,
      sourceHash: resolved.sourceHash,
      releaseTokens,
      nestedComponents: graph.slice(0, -1),
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
  const selectedVersions = new Map(envelope.component_versions.map((selection) => [
    selection.component_definition_id,
    selection.version,
  ]));
  const graph = resolveComponentGraph(
    persistedResolvedComponent(database, pin.design_system_id, selectedVersions, componentDefinitionId, selected.version),
    (nestedId, nestedVersion) => persistedResolvedComponent(
      database,
      pin.design_system_id,
      selectedVersions,
      nestedId,
      nestedVersion,
    ),
  );
  const resolved = graph.at(-1)!;
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
    definition: resolved.definition,
    source: resolved.source,
    sourceHash: resolved.sourceHash,
    releaseTokens,
    nestedComponents: graph.slice(0, -1),
  };
}

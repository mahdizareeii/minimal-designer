import type { AnyDesignDocument, DesignDocument } from "@designer/core";

import { hashPayload } from "./ids.js";

export interface RevisionImplementationMappingRow {
  id: string;
  entity_kind: string;
  entity_id: string;
  platform: string;
  symbol: string;
  inventory_id: string | null;
  mapping_json: string;
  created_by: string;
  created_at: string;
}

export interface LinkedRevisionSpecification {
  version: number;
  specificationHash: string;
  specification: unknown;
}

interface TokenResolution {
  status: "resolved" | "missing" | "archived" | "cycle";
  value: unknown;
  path: string[];
}

interface InspectTokenReference extends TokenResolution {
  tokenId: string;
  tokenPath: string | null;
  jsonPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectionPath(collection: string, id: string): string {
  return `$.${collection}[${JSON.stringify(id)}]`;
}

function tokenRecords(document: AnyDesignDocument): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(document.tokens).map(([id, token]) => [id, token as unknown as Record<string, unknown>]),
  );
}

function isTokenReference(value: unknown): value is { token_id: string } {
  return isRecord(value) && typeof value.token_id === "string";
}

function resolveToken(
  tokenId: string,
  tokens: Record<string, Record<string, unknown>>,
  trail: string[] = [],
): TokenResolution {
  if (trail.includes(tokenId)) return { status: "cycle", value: null, path: [...trail, tokenId] };
  const token = tokens[tokenId];
  if (!token) return { status: "missing", value: null, path: [...trail, tokenId] };
  if (token.archived === true) return { status: "archived", value: null, path: [...trail, tokenId] };
  const nextTrail = [...trail, tokenId];
  if (isTokenReference(token.value)) return resolveToken(token.value.token_id, tokens, nextTrail);
  return { status: "resolved", value: structuredClone(token.value), path: nextTrail };
}

function resolveReferences(
  value: unknown,
  jsonPath: string,
  tokens: Record<string, Record<string, unknown>>,
  references: InspectTokenReference[],
): unknown {
  if (isTokenReference(value)) {
    const resolution = resolveToken(value.token_id, tokens);
    references.push({
      tokenId: value.token_id,
      tokenPath: typeof tokens[value.token_id]?.path === "string" ? tokens[value.token_id]!.path as string : null,
      jsonPath,
      ...resolution,
    });
    return resolution.status === "resolved" ? structuredClone(resolution.value) : structuredClone(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveReferences(item, `${jsonPath}[${index}]`, tokens, references));
  }
  if (!isRecord(value)) return structuredClone(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    resolveReferences(item, `${jsonPath}[${JSON.stringify(key)}]`, tokens, references),
  ]));
}

function nodeProperties(node: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([
    "id",
    "name",
    "type",
    "layout",
    "style",
    "visible",
    "locked",
    "archived",
    "metadata",
    "semantics",
    "tags",
  ]);
  return Object.fromEntries(Object.entries(node).filter(([key]) => !excluded.has(key)));
}

function inspectNodes(canonical: AnyDesignDocument, editor: DesignDocument) {
  const tokens = tokenRecords(canonical);
  return Object.values(editor.nodes).map((node) => {
    const canonicalNode = canonical.nodes[node.id] as unknown as Record<string, unknown> | undefined;
    const sourceNode = canonicalNode ?? node as unknown as Record<string, unknown>;
    const basePath = collectionPath("nodes", node.id);
    const tokenReferences: InspectTokenReference[] = [];
    const resolvedLayout = resolveReferences(node.layout, `${basePath}.layout`, tokens, tokenReferences);
    const resolvedStyle = resolveReferences(node.style, `${basePath}.style`, tokens, tokenReferences);
    const semantics = isRecord(sourceNode.semantics)
      ? structuredClone(sourceNode.semantics)
      : typeof sourceNode.role === "string"
        ? { role: sourceNode.role }
        : null;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      archived: node.archived,
      visible: node.visible,
      locked: node.locked,
      boundingBox: {
        x: node.layout.x,
        y: node.layout.y,
        width: node.layout.width,
        height: node.layout.height,
        rotation: node.layout.rotation ?? 0,
      },
      layout: node.layout,
      style: node.style,
      resolvedValues: { layout: resolvedLayout, style: resolvedStyle },
      tokenReferences,
      semantics,
      properties: nodeProperties(sourceNode),
      metadata: node.metadata,
      jsonPath: basePath,
    };
  });
}

function inspectTokens(document: AnyDesignDocument) {
  const tokens = tokenRecords(document);
  return Object.entries(tokens).map(([id, token]) => {
    const resolution = resolveToken(id, tokens);
    const modes = isRecord(token.modes)
      ? Object.fromEntries(Object.entries(token.modes).map(([mode, value]) => {
        if (!isTokenReference(value)) return [mode, { status: "resolved", value, path: [id] }];
        return [mode, resolveToken(value.token_id, tokens, [id])];
      }))
      : {};
    return {
      id,
      name: typeof token.name === "string" ? token.name : id,
      path: typeof token.path === "string" ? token.path : id,
      family: typeof token.family === "string" ? token.family : typeof token.kind === "string" ? token.kind : "unknown",
      layer: typeof token.layer === "string" ? token.layer : "project",
      rawValue: structuredClone(token.value),
      resolvedValue: resolution.value,
      resolutionStatus: resolution.status,
      resolutionPath: resolution.path,
      modes,
      archived: token.archived === true,
      deprecated: token.deprecated === true,
      jsonPath: collectionPath("tokens", id),
    };
  });
}

function inspectAssets(document: AnyDesignDocument) {
  return Object.entries(document.assets).map(([id, assetValue]) => {
    const asset = assetValue as unknown as Record<string, unknown>;
    const storageKey = typeof asset.storage_key === "string" ? asset.storage_key : null;
    return {
      id,
      name: typeof asset.name === "string" ? asset.name : id,
      kind: typeof asset.kind === "string" ? asset.kind : "unknown",
      mimeType: typeof asset.mime_type === "string" ? asset.mime_type : "application/octet-stream",
      sizeBytes: typeof asset.size_bytes === "number" ? asset.size_bytes : 0,
      width: typeof asset.width === "number" ? asset.width : null,
      height: typeof asset.height === "number" ? asset.height : null,
      sha256: typeof asset.sha256 === "string" ? asset.sha256 : null,
      status: typeof asset.status === "string"
        ? asset.status
        : storageKey?.startsWith("asset:")
          ? "managed"
          : "legacy",
      displayFilename: typeof asset.display_filename === "string"
        ? asset.display_filename
        : typeof asset.name === "string"
          ? asset.name
          : id,
      jsonPath: collectionPath("assets", id),
    };
  });
}

function inspectComponents(document: AnyDesignDocument) {
  if (document.schema_version === 2) {
    const nodes = Object.values(document.nodes) as unknown as Array<Record<string, unknown>>;
    return Object.entries(document.component_definitions).map(([id, definitionValue]) => {
      const definition = definitionValue as unknown as Record<string, unknown>;
      const instanceCount = nodes.filter((node) =>
        node.type === "component_instance" && node.component_definition_id === id).length;
      return {
        id,
        key: typeof definition.key === "string" ? definition.key : id,
        name: typeof definition.name === "string" ? definition.name : id,
        version: typeof definition.version === "number" ? definition.version : 1,
        status: typeof definition.status === "string" ? definition.status : "draft",
        rootNodeId: typeof definition.root_node_id === "string" ? definition.root_node_id : null,
        instanceCount,
        platformMappings: Array.isArray(definition.platform_mappings)
          ? structuredClone(definition.platform_mappings)
          : [],
        jsonPath: collectionPath("component_definitions", id),
      };
    });
  }
  const nodes = Object.values(document.nodes) as unknown as Array<Record<string, unknown>>;
  return nodes.filter((node) => node.type === "component" && typeof node.id === "string").map((node) => ({
    id: node.id as string,
    key: typeof node.component_key === "string" ? node.component_key : node.id as string,
    name: typeof node.name === "string" ? node.name : node.id as string,
    version: 1,
    status: "project_local",
    rootNodeId: node.id as string,
    instanceCount: nodes.filter((candidate) => candidate.type === "instance" && candidate.component_id === node.id).length,
    platformMappings: [],
    jsonPath: collectionPath("nodes", node.id as string),
  }));
}

function specificationEvidence(
  document: AnyDesignDocument,
  linkedSpecification: LinkedRevisionSpecification | null,
) {
  if (linkedSpecification) {
    return {
      source: "revision_link" as const,
      version: linkedSpecification.version,
      specificationHash: linkedSpecification.specificationHash,
      specification: linkedSpecification.specification,
      jsonPath: '$["@revision_product_specification"]',
    };
  }
  if (document.schema_version !== 2) return null;
  return {
    source: "document" as const,
    version: document.product_specification.version,
    specificationHash: hashPayload(document.product_specification),
    specification: document.product_specification,
    jsonPath: "$.product_specification",
  };
}

function inspectSpecificationItems(specification: ReturnType<typeof specificationEvidence>) {
  if (!specification || !isRecord(specification.specification)) {
    return { businessRules: [], acceptanceCriteria: [] };
  }
  const businessRules = Array.isArray(specification.specification.business_rules)
    ? specification.specification.business_rules
    : [];
  const acceptanceCriteria = Array.isArray(specification.specification.acceptance_criteria)
    ? specification.specification.acceptance_criteria
    : [];
  return {
    businessRules: businessRules.filter(isRecord).map((rule, index) => ({
      ...structuredClone(rule),
      jsonPath: `${specification.jsonPath}.business_rules[${index}]`,
    })),
    acceptanceCriteria: acceptanceCriteria.filter(isRecord).map((criterion, index) => ({
      ...structuredClone(criterion),
      jsonPath: `${specification.jsonPath}.acceptance_criteria[${index}]`,
    })),
  };
}

function parseMappingDetails(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function inspectMappings(document: AnyDesignDocument, rows: RevisionImplementationMappingRow[]) {
  const documentMappings = document.schema_version === 2
    ? Object.entries(document.implementation_mappings).map(([id, mappingValue]) => {
      const mapping = mappingValue as unknown as Record<string, unknown>;
      return {
        id,
        source: "document" as const,
        targetType: typeof mapping.target_type === "string" ? mapping.target_type : "unknown",
        sourceId: typeof mapping.source_id === "string" ? mapping.source_id : "unknown",
        platform: typeof mapping.platform === "string" ? mapping.platform : "other",
        symbol: typeof mapping.symbol === "string" ? mapping.symbol : "unknown",
        connectionId: typeof mapping.connection_id === "string" ? mapping.connection_id : null,
        inventoryId: null,
        mappingVersion: typeof mapping.mapping_version === "number" ? mapping.mapping_version : null,
        notes: typeof mapping.notes === "string" ? mapping.notes : null,
        details: structuredClone(mapping),
        jsonPath: collectionPath("implementation_mappings", id),
      };
    })
    : [];
  const revisionMappings = rows.map((row) => ({
    id: row.id,
    source: "revision" as const,
    targetType: row.entity_kind,
    sourceId: row.entity_id,
    platform: row.platform,
    symbol: row.symbol,
    connectionId: null,
    inventoryId: row.inventory_id,
    mappingVersion: null,
    notes: null,
    details: parseMappingDetails(row.mapping_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    jsonPath: `$["@revision_implementation_mappings"][${JSON.stringify(row.id)}]`,
  }));
  return [...documentMappings, ...revisionMappings];
}

export function buildRevisionInspectSnapshot(input: {
  canonicalDocument: AnyDesignDocument;
  editorDocument: DesignDocument;
  linkedSpecification: LinkedRevisionSpecification | null;
  implementationMappings: RevisionImplementationMappingRow[];
}) {
  const productSpecification = specificationEvidence(input.canonicalDocument, input.linkedSpecification);
  const specificationItems = inspectSpecificationItems(productSpecification);
  return {
    nodes: inspectNodes(input.canonicalDocument, input.editorDocument),
    productSpecification,
    evidence: {
      tokens: inspectTokens(input.canonicalDocument),
      assets: inspectAssets(input.canonicalDocument),
      components: inspectComponents(input.canonicalDocument),
      businessRules: specificationItems.businessRules,
      acceptanceCriteria: specificationItems.acceptanceCriteria,
      implementationMappings: inspectMappings(input.canonicalDocument, input.implementationMappings),
    },
    limitations: productSpecification
      ? []
      : ["No product specification version is explicitly pinned to this historical design revision."],
  };
}

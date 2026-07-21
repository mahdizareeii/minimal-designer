import type { DesignNode, DesignToken, DesignDocument } from "./model.js";
import { DesignDocumentSchema } from "./model.js";
import type { AssetId } from "./ids.js";
import type { DesignNodeV2 } from "./model-v2.js";
import { DesignDocumentV2Schema, type DesignDocumentV2 } from "./model-v2.js";
import type { DesignSystemToken } from "./design-system.js";

const FOUNDATION_SYSTEM_ID = "system_formaspec_foundation";
const FOUNDATION_RELEASE_ID = "release_formaspec_foundation_1";

function suffix(value: string): string {
  const index = value.indexOf("_");
  return (index === -1 ? value : value.slice(index + 1)).replace(/[^A-Za-z0-9_-]/g, "_").padEnd(8, "_");
}

function componentDefinitionId(nodeId: string): `component_${string}` {
  return `component_${suffix(nodeId)}`;
}

function specificationId(documentId: string): `spec_${string}` {
  return `spec_${suffix(documentId)}`;
}

function semanticRole(node: DesignNode): DesignNodeV2["semantics"]["role"] {
  if (node.type === "image") return "image";
  if (node.type === "frame" && node.role === "navigation") return "navigation";
  if (node.type === "frame" && node.role === "button") return "button";
  if (node.type === "frame" && node.role === "list") return "list";
  if (node.type === "frame" && node.role === "dialog") return "dialog";
  return "generic";
}

function commonNode(node: DesignNode) {
  const compatibilityAccessibilityLabel = typeof node.metadata.accessible_label === "string"
    ? node.metadata.accessible_label
    : node.type === "image" && node.alt
      ? node.alt
      : node.type === "icon" && node.label
        ? node.label
        : undefined;
  return {
    id: node.id,
    name: node.name,
    layout: structuredClone(node.layout),
    style: structuredClone(node.style),
    visible: node.visible,
    locked: node.locked,
    archived: node.archived,
    semantics: {
      role: semanticRole(node),
      business_rule_ids: [],
      acceptance_criterion_ids: [],
      ...(compatibilityAccessibilityLabel === undefined
        ? {}
        : { accessibility_label: compatibilityAccessibilityLabel }),
    },
    metadata: structuredClone(node.metadata),
    ...(node.tags === undefined ? {} : { tags: [...node.tags] }),
  };
}

function migrateNode(node: DesignNode): DesignNodeV2 {
  const common = commonNode(node);
  switch (node.type) {
    case "frame":
      return {
        ...common,
        type: "frame",
        children: [...node.children],
        clip_content: node.clip_content,
        locale: typeof node.metadata.locale === "string" ? node.metadata.locale : "en",
        text_direction: node.metadata.text_direction === "rtl" || node.metadata.text_direction === "ltr"
          ? node.metadata.text_direction
          : "auto",
      };
    case "group":
    case "component":
      return { ...common, type: "container", children: [...node.children], clip_content: false };
    case "text":
      return { ...common, type: "text", content: node.content, direction: node.direction ?? "auto" };
    case "rectangle":
      return { ...common, type: "rectangle" };
    case "ellipse":
      return { ...common, type: "ellipse" };
    case "image":
      return {
        ...common,
        type: "image",
        ...(node.asset_id === undefined ? {} : { asset_id: node.asset_id }),
        alt: node.alt,
        object_fit: node.object_fit,
      };
    case "icon":
      return {
        ...common,
        type: "icon",
        icon_name: node.icon_name,
        ...(node.label === undefined ? {} : { label: node.label }),
      };
    case "instance":
      return {
        ...common,
        type: "component_instance",
        component_definition_id: componentDefinitionId(node.component_id),
        component_version: 1,
        properties: {},
        slots: {},
        active_state: "default",
      };
  }
}

function tokenFamily(token: DesignToken): DesignSystemToken["family"] {
  switch (token.kind) {
    case "color": return "color";
    case "dimension": return "dimension";
    case "font_family": return "font_family";
    case "font_weight": return "font_weight";
    case "duration": return "duration";
    case "number": return "number";
    case "string": return "string";
  }
}

export interface MigrationV2Options {
  migratedAt?: string;
  sourceRevisionId?: string;
  sourceSnapshotHash?: string;
  verifiedBackupId?: string;
}

export function migrateDesignDocumentV1ToV2(
  input: DesignDocument,
  options: MigrationV2Options = {},
): DesignDocumentV2 {
  const source = DesignDocumentSchema.parse(input);
  const migratedAt = options.migratedAt ?? source.updated_at;
  const nodes = Object.fromEntries(Object.values(source.nodes).map((node) => [node.id, migrateNode(node)]));
  const pageReachable = new Set<string>();
  const visitPageTree = (nodeId: string): void => {
    if (pageReachable.has(nodeId)) return;
    const node = source.nodes[nodeId];
    if (!node || node.archived) return;
    pageReachable.add(nodeId);
    if ("children" in node) for (const childId of node.children) visitPageTree(childId);
  };
  for (const page of source.pages) {
    if (!page.archived) for (const rootId of page.children) visitPageTree(rootId);
  }
  const archiveDetachedComponentTree = (nodeId: string): void => {
    const sourceNode = source.nodes[nodeId];
    const migratedNode = nodes[nodeId];
    if (!sourceNode || !migratedNode || migratedNode.archived) return;
    migratedNode.archived = true;
    migratedNode.locked = true;
    if ("children" in sourceNode) for (const childId of sourceNode.children) archiveDetachedComponentTree(childId);
  };
  for (const node of Object.values(source.nodes)) {
    if (node.type === "component" && !pageReachable.has(node.id)) archiveDetachedComponentTree(node.id);
  }
  const componentDefinitions = Object.fromEntries(
    Object.values(source.nodes)
      .filter((node) => node.type === "component")
      .map((node) => {
        const id = componentDefinitionId(node.id);
        return [id, {
          id,
          key: node.component_key,
          name: node.name,
          version: 1,
          status: "draft" as const,
          root_node_id: node.id,
          properties_schema: [],
          slots: [],
          states: [{ key: "default" as const, name: "Default", node_id: node.id }],
          allowed_overrides: {
            allow_text: false,
            allow_assets: false,
            allow_icons: false,
            allowed_token_families: [],
            allowed_style_paths: [],
          },
          platform_mappings: [],
          documentation: {
            summary: node.description ?? "Migrated V1 component. Review and publish before organization-wide use.",
            usage: [],
            accessibility: [],
            do_list: [],
            dont_list: [],
          },
        }];
      }),
  );
  const legacyOverrides = Object.fromEntries(
    Object.values(source.nodes)
      .flatMap((node) => node.type === "instance" && Object.keys(node.overrides).length > 0
        ? [[node.id, structuredClone(node.overrides)] as const]
        : []),
  );
  const tokens = Object.fromEntries(Object.values(source.tokens).map((token) => [token.id, {
    id: token.id,
    path: token.path,
    name: token.name,
    family: tokenFamily(token),
    layer: "primitive" as const,
    value: token.value,
    ...(token.description === undefined ? {} : { description: token.description }),
    deprecated: token.archived,
  }]));
  const quarantinedAssetIds: AssetId[] = [];
  const assets = Object.fromEntries(Object.values(source.assets).map((asset) => {
    const ready = asset.kind === "image"
      && ["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type)
      && Boolean(asset.sha256 && asset.width && asset.height);
    if (!ready) quarantinedAssetIds.push(asset.id);
    return [asset.id, {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
      status: ready ? "ready" as const : "legacy_quarantined" as const,
      display_filename: asset.name,
      metadata: structuredClone(asset.metadata),
    }];
  }));

  const diagnostics = [
    ...Object.keys(legacyOverrides).map((nodeId) => ({
      code: "LEGACY_COMPONENT_OVERRIDES_QUARANTINED",
      severity: "warning" as const,
      message: "Free-form V1 component overrides were preserved but are not rendered in V2.",
      node_id: nodeId,
    })),
    ...quarantinedAssetIds.map((assetId) => ({
      code: "LEGACY_ASSET_REQUIRES_NORMALIZATION",
      severity: "warning" as const,
      message: "The asset must be decoded and normalized before V2 rendering.",
      asset_id: assetId,
    })),
  ];
  const compatibility = {
    node_types: Object.fromEntries(Object.values(source.nodes).flatMap((node) =>
      node.type === "group" || node.type === "component" || node.type === "instance"
        ? [[node.id, node.type] as const]
        : [],
    )),
    text_directions: Object.fromEntries(Object.values(source.nodes).flatMap((node) =>
      node.type === "text"
        ? [[node.id, node.direction ?? null] as const]
        : [],
    )),
    component_descriptions: Object.fromEntries(Object.values(source.nodes).flatMap((node) =>
      node.type === "component"
        ? [[node.id, node.description ?? null] as const]
        : [],
    )),
    frame_roles: Object.fromEntries(Object.values(source.nodes).flatMap((node) =>
      node.type === "frame" && node.role !== undefined
        ? [[node.id, node.role] as const]
        : [],
    )),
    token_metadata: Object.fromEntries(Object.values(source.tokens).map((token) => [
      token.id,
      structuredClone(token.metadata),
    ])),
    asset_storage_keys: Object.fromEntries(Object.values(source.assets).map((asset) => [
      asset.id,
      asset.storage_key,
    ])),
  };

  return DesignDocumentV2Schema.parse({
    schema_version: 2,
    id: source.id,
    name: source.name,
    revision: source.revision,
    pages: source.pages.map((page) => ({
      id: page.id,
      name: page.name,
      children: [...page.children],
      background: structuredClone(page.background),
      ...(page.viewport === undefined ? {} : { viewport: structuredClone(page.viewport) }),
      locale: typeof page.metadata.locale === "string" ? page.metadata.locale : "en",
      text_direction: page.metadata.text_direction === "rtl" || page.metadata.text_direction === "ltr"
        ? page.metadata.text_direction
        : "auto",
      archived: page.archived,
      metadata: structuredClone(page.metadata),
    })),
    nodes,
    tokens,
    assets,
    prototype_links: structuredClone(source.prototype_links),
    component_definitions: componentDefinitions,
    design_system: {
      design_system_id: FOUNDATION_SYSTEM_ID,
      release_id: FOUNDATION_RELEASE_ID,
      release_version: 1,
    },
    product_specification: {
      id: specificationId(source.id),
      version: 1,
      natural_language_brief: typeof source.metadata.product_brief === "string" ? source.metadata.product_brief : "",
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
    },
    implementation_mappings: {},
    migration: {
      source_schema_version: 1,
      migrated_at: migratedAt,
      ...(options.sourceRevisionId === undefined ? {} : { source_revision_id: options.sourceRevisionId }),
      ...(options.sourceSnapshotHash === undefined ? {} : { source_snapshot_hash: options.sourceSnapshotHash }),
      ...(options.verifiedBackupId === undefined ? {} : { verified_backup_id: options.verifiedBackupId }),
      legacy_component_overrides: legacyOverrides,
      quarantined_asset_ids: quarantinedAssetIds,
      compatibility,
      diagnostics,
    },
    metadata: structuredClone(source.metadata),
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
}

export const migrateV1ToV2 = migrateDesignDocumentV1ToV2;

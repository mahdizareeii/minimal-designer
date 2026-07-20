import { z } from "zod";

import { resolveDesignToken, type DesignSystemToken } from "./design-system.js";
import { migrateDesignDocumentV1ToV2 } from "./migration-v2.js";
import {
  DesignDocumentSchema,
  type ContainerNode,
  type DesignAsset,
  type DesignDocument,
  type DesignNode,
  type DesignToken,
  type Metadata,
} from "./model.js";
import {
  AnyDesignDocumentSchema,
  DesignDocumentV2Schema,
  type AnyDesignDocument,
  type DesignDocumentV2,
  type DesignNodeV2,
} from "./model-v2.js";

export interface V2CompatibilityIssue {
  code: string;
  message: string;
  path: Array<string | number>;
}

export class V2CompatibilityError extends Error {
  readonly issues: V2CompatibilityIssue[];

  constructor(message: string, issues: V2CompatibilityIssue[]) {
    super(message);
    this.name = "V2CompatibilityError";
    this.issues = issues;
  }
}

const V1_TOKEN_FAMILIES = new Set<DesignToken["kind"]>([
  "color",
  "dimension",
  "number",
  "string",
  "font_family",
  "font_weight",
  "duration",
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function compatibilityFailure(code: string, message: string, path: Array<string | number>): never {
  throw new V2CompatibilityError("The V2 document cannot be represented safely by the V1 editor.", [{ code, message, path }]);
}

function schemaFailure(error: z.ZodError): never {
  throw new V2CompatibilityError(
    "The V2 compatibility projection is invalid.",
    error.issues.map((issue) => ({
      code: "V2_COMPATIBILITY_SCHEMA_INVALID",
      message: issue.message,
      path: issue.path,
    })),
  );
}

function frameRole(document: DesignDocumentV2, node: Extract<DesignNodeV2, { type: "frame" }>): Extract<DesignNode, { type: "frame" }>["role"] {
  const legacy = document.migration?.compatibility?.frame_roles[node.id];
  if (legacy) return legacy;
  switch (node.semantics.role) {
    case "navigation": return "navigation";
    case "button": return "button";
    case "list": return "list";
    case "dialog": return "dialog";
    default: return undefined;
  }
}

function semanticRole(role: Extract<DesignNode, { type: "frame" }>["role"]): DesignNodeV2["semantics"]["role"] {
  switch (role) {
    case "navigation": return "navigation";
    case "button": return "button";
    case "list": return "list";
    case "dialog": return "dialog";
    default: return "generic";
  }
}

function tokenKind(family: DesignSystemToken["family"]): DesignToken["kind"] {
  if (V1_TOKEN_FAMILIES.has(family as DesignToken["kind"])) return family as DesignToken["kind"];
  if (["spacing", "radius", "border_width", "font_size", "line_height", "letter_spacing"].includes(family)) return "dimension";
  if (family === "opacity") return "number";
  return compatibilityFailure(
    "V2_TOKEN_FAMILY_UNSUPPORTED",
    `Token family ${family} has no lossless V1 representation.`,
    ["tokens"],
  );
}

function projectToken(document: DesignDocumentV2, token: DesignSystemToken): DesignToken {
  let value: unknown;
  try {
    value = resolveDesignToken(document.tokens, token.id).value;
  } catch (error) {
    return compatibilityFailure(
      "V2_TOKEN_RESOLUTION_FAILED",
      error instanceof Error ? error.message : String(error),
      ["tokens", token.id, "value"],
    );
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return compatibilityFailure(
      "V2_TOKEN_VALUE_UNSUPPORTED",
      `Token ${token.id} resolves to a structured value that the V1 renderer cannot represent.`,
      ["tokens", token.id, "value"],
    );
  }
  const kind = tokenKind(token.family);
  const metadata = document.migration?.compatibility?.token_metadata[token.id] ?? {};
  const parsed = DesignDocumentSchema.shape.tokens.element.safeParse({
    id: token.id,
    name: token.name,
    path: token.path,
    kind,
    value,
    ...(token.description === undefined ? {} : { description: token.description }),
    archived: token.deprecated,
    metadata,
  });
  if (!parsed.success) schemaFailure(parsed.error);
  return parsed.data;
}

function commonNode(node: DesignNodeV2) {
  return {
    id: node.id,
    name: node.name,
    layout: structuredClone(node.layout),
    style: structuredClone(node.style),
    visible: node.visible,
    locked: node.locked,
    archived: node.archived,
    metadata: structuredClone(node.metadata),
    ...(node.tags === undefined ? {} : { tags: [...node.tags] }),
  };
}

function localizedMetadata(
  metadata: Metadata,
  locale: string,
  direction: "auto" | "ltr" | "rtl",
): Metadata {
  return {
    ...structuredClone(metadata),
    ...(metadata.locale === undefined && locale !== "en" ? { locale } : {}),
    ...(metadata.text_direction === undefined && direction !== "auto" ? { text_direction: direction } : {}),
  };
}

function projectNode(
  document: DesignDocumentV2,
  node: DesignNodeV2,
  definitionByRoot: Map<string, DesignDocumentV2["component_definitions"][string]>,
): DesignNode {
  const common = commonNode(node);
  switch (node.type) {
    case "frame": {
      const role = frameRole(document, node);
      return {
        ...common,
        metadata: localizedMetadata(node.metadata, node.locale, node.text_direction),
        type: "frame",
        children: [...node.children],
        clip_content: node.clip_content,
        ...(role === undefined ? {} : { role }),
      };
    }
    case "container": {
      const definition = definitionByRoot.get(node.id);
      const legacyType = document.migration?.compatibility?.node_types[node.id];
      if (definition || legacyType === "component") {
        if (!definition) {
          return compatibilityFailure(
            "V2_COMPONENT_DEFINITION_MISSING",
            `Migrated component root ${node.id} has no component definition.`,
            ["nodes", node.id],
          );
        }
        if (definition.key.length > 160 || definition.documentation.summary.length > 2_000) {
          return compatibilityFailure(
            "V2_COMPONENT_TEXT_TOO_LARGE",
            `Component ${definition.id} exceeds V1 component text limits.`,
            ["component_definitions", definition.id],
          );
        }
        return {
          ...common,
          type: "component",
          children: [...node.children],
          component_key: definition.key,
          ...(document.migration?.compatibility?.component_descriptions[node.id] === null
            ? {}
            : { description: document.migration?.compatibility?.component_descriptions[node.id] ?? definition.documentation.summary }),
        };
      }
      return { ...common, type: "group", children: [...node.children] };
    }
    case "text": {
      const legacyDirection = document.migration?.compatibility?.text_directions[node.id];
      return {
        ...common,
        type: "text",
        content: node.content,
        ...(legacyDirection === null ? {} : { direction: legacyDirection ?? node.direction }),
      };
    }
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
    case "component_instance": {
      const definition = document.component_definitions[node.component_definition_id];
      if (!definition) {
        return compatibilityFailure(
          "V2_COMPONENT_DEFINITION_MISSING",
          `Component instance ${node.id} references a missing definition.`,
          ["nodes", node.id, "component_definition_id"],
        );
      }
      const definitionRoot = document.nodes[definition.root_node_id];
      if (!definitionRoot || definitionRoot.type !== "container") {
        return compatibilityFailure(
          "V2_COMPONENT_ROOT_UNSUPPORTED",
          `Component ${definition.id} does not use a V1-compatible container root.`,
          ["component_definitions", definition.id, "root_node_id"],
        );
      }
      return {
        ...common,
        type: "instance",
        component_id: definition.root_node_id,
        overrides: structuredClone(document.migration?.legacy_component_overrides[node.id] ?? {}),
      };
    }
  }
}

function projectAsset(document: DesignDocumentV2, asset: DesignDocumentV2["assets"][string]): DesignAsset {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    storage_key: document.migration?.compatibility?.asset_storage_keys[asset.id] ?? `asset:${asset.id}`,
    ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    metadata: structuredClone(asset.metadata),
  };
}

export function parseAnyDesignDocument(value: unknown): AnyDesignDocument {
  return AnyDesignDocumentSchema.parse(value);
}

export function toV1CompatibleDesignDocument(input: AnyDesignDocument): DesignDocument {
  const parsed = AnyDesignDocumentSchema.parse(input);
  if (parsed.schema_version === 1) return DesignDocumentSchema.parse(structuredClone(parsed));

  const definitionByRoot = new Map<string, DesignDocumentV2["component_definitions"][string]>();
  for (const definition of Object.values(parsed.component_definitions)) {
    if (definitionByRoot.has(definition.root_node_id)) {
      compatibilityFailure(
        "V2_COMPONENT_ROOT_AMBIGUOUS",
        `Multiple component definitions use root ${definition.root_node_id}.`,
        ["component_definitions", definition.id, "root_node_id"],
      );
    }
    definitionByRoot.set(definition.root_node_id, definition);
  }

  const projected = DesignDocumentSchema.safeParse({
    schema_version: 1,
    id: parsed.id,
    name: parsed.name,
    revision: parsed.revision,
    pages: parsed.pages.map((page) => ({
      id: page.id,
      name: page.name,
      children: [...page.children],
      background: structuredClone(page.background),
      ...(page.viewport === undefined ? {} : { viewport: structuredClone(page.viewport) }),
      archived: page.archived,
      metadata: localizedMetadata(page.metadata, page.locale, page.text_direction),
    })),
    nodes: Object.fromEntries(Object.values(parsed.nodes).map((node) => [
      node.id,
      projectNode(parsed, node, definitionByRoot),
    ])),
    tokens: Object.fromEntries(Object.values(parsed.tokens).map((token) => [token.id, projectToken(parsed, token)])),
    assets: Object.fromEntries(Object.values(parsed.assets).map((asset) => [asset.id, projectAsset(parsed, asset)])),
    prototype_links: structuredClone(parsed.prototype_links),
    metadata: structuredClone(parsed.metadata),
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  });
  if (!projected.success) schemaFailure(projected.error);
  return projected.data;
}

function tokenIsV1Writable(token: DesignSystemToken): boolean {
  return (typeof token.value === "string" || typeof token.value === "number")
    && token.modes === undefined
    && token.replacement_token_id === undefined
    && token.family !== "typography"
    && token.family !== "shadow";
}

function assertSameIdentity(base: DesignDocumentV2, edited: DesignDocument): void {
  if (base.id !== edited.id || base.created_at !== edited.created_at) {
    compatibilityFailure(
      "V2_DOCUMENT_IDENTITY_CHANGED",
      "The V1 compatibility editor cannot change a V2 document ID or creation timestamp.",
      ["id"],
    );
  }
  for (const nodeId of Object.keys(base.nodes)) {
    if (!edited.nodes[nodeId]) {
      compatibilityFailure(
        "V2_NODE_REMOVAL_UNSUPPORTED",
        `V2 node ${nodeId} cannot be removed; archive it explicitly.`,
        ["nodes", nodeId],
      );
    }
  }
}

function mergeExistingNode(
  baseDocument: DesignDocumentV2,
  projectedDocument: DesignDocument,
  editedDocument: DesignDocument,
  candidateDocument: DesignDocumentV2,
  nodeId: string,
): void {
  const base = baseDocument.nodes[nodeId];
  const projected = projectedDocument.nodes[nodeId];
  const edited = editedDocument.nodes[nodeId];
  const candidate = candidateDocument.nodes[nodeId];
  if (!base || !projected || !edited || !candidate) return;
  if (projected.type !== edited.type) {
    compatibilityFailure(
      "V2_NODE_TYPE_CHANGE_UNSUPPORTED",
      `Node ${nodeId} cannot change type through the V1 compatibility editor.`,
      ["nodes", nodeId, "type"],
    );
  }
  if (base.type === "component_instance") {
    if (edited.type !== "instance" || projected.type !== "instance") {
      compatibilityFailure("V2_COMPONENT_INSTANCE_INVALID", `Component instance ${nodeId} is invalid.`, ["nodes", nodeId]);
    }
    if (!equal(projected.overrides, edited.overrides)) {
      compatibilityFailure(
        "V2_COMPONENT_OVERRIDE_EDIT_UNSUPPORTED",
        "Typed V2 component properties and slots must be edited through the V2 component workflow.",
        ["nodes", nodeId, "overrides"],
      );
    }
    if (projected.component_id !== edited.component_id) {
      const definition = Object.values(baseDocument.component_definitions).find((item) => item.root_node_id === edited.component_id);
      if (!definition) {
        compatibilityFailure(
          "V2_COMPONENT_REBIND_UNSUPPORTED",
          `No exact V2 component definition exists for root ${edited.component_id}.`,
          ["nodes", nodeId, "component_id"],
        );
      }
      candidateDocument.nodes[nodeId] = {
        ...base,
        ...candidate,
        type: "component_instance",
        component_definition_id: definition.id,
        component_version: definition.version,
        properties: structuredClone(base.properties),
        slots: structuredClone(base.slots),
        active_state: base.active_state,
        semantics: structuredClone(base.semantics),
      };
      return;
    }
  }
  candidateDocument.nodes[nodeId] = {
    ...candidate,
    semantics: structuredClone(base.semantics),
    ...(base.inserted_from_template_id === undefined ? {} : { inserted_from_template_id: base.inserted_from_template_id }),
    ...(base.inserted_from_template_version === undefined ? {} : { inserted_from_template_version: base.inserted_from_template_version }),
    ...(base.type === "container" && candidate.type === "container" ? { clip_content: base.clip_content } : {}),
    ...(base.type === "frame" && candidate.type === "frame" ? {
      ...(base.user_story === undefined ? {} : { user_story: base.user_story }),
      ...(base.screen_purpose === undefined ? {} : { screen_purpose: base.screen_purpose }),
      ...(base.screen_state === undefined ? {} : { screen_state: base.screen_state }),
      ...(base.primary_action === undefined ? {} : { primary_action: base.primary_action }),
    } : {}),
    ...(base.type === "component_instance" && candidate.type === "component_instance" ? {
      component_definition_id: base.component_definition_id,
      component_version: base.component_version,
      properties: structuredClone(base.properties),
      slots: structuredClone(base.slots),
      active_state: base.active_state,
    } : {}),
  } as DesignNodeV2;
  if (base.type === "frame" && candidateDocument.nodes[nodeId]?.type === "frame"
    && projected.type === "frame" && edited.type === "frame" && projected.role !== edited.role) {
    if (!baseDocument.migration && semanticRole(edited.role) === "generic" && edited.role !== undefined && edited.role !== "none") {
      compatibilityFailure(
        "V2_FRAME_ROLE_EDIT_UNSUPPORTED",
        `Frame role ${edited.role} has no V2 semantic-role equivalent and requires a V2-native editor.`,
        ["nodes", nodeId, "role"],
      );
    }
    candidateDocument.nodes[nodeId]!.semantics.role = semanticRole(edited.role);
  }
  if (base.type === "frame" && candidateDocument.nodes[nodeId]?.type === "frame") {
    candidateDocument.nodes[nodeId]!.locale = base.locale;
    candidateDocument.nodes[nodeId]!.text_direction = base.text_direction;
  }
}

function preserveExistingPageFields(
  base: DesignDocumentV2,
  edited: DesignDocument,
  candidate: DesignDocumentV2,
): void {
  for (const basePage of base.pages) {
    if (!edited.pages.some((page) => page.id === basePage.id)) {
      compatibilityFailure("V2_PAGE_REMOVAL_UNSUPPORTED", `Page ${basePage.id} cannot be removed.`, ["pages", basePage.id]);
    }
    const candidatePage = candidate.pages.find((page) => page.id === basePage.id);
    if (candidatePage) {
      candidatePage.locale = basePage.locale;
      candidatePage.text_direction = basePage.text_direction;
    }
  }
}

function updateComponentDefinitions(
  base: DesignDocumentV2,
  projected: DesignDocument,
  edited: DesignDocument,
): DesignDocumentV2["component_definitions"] {
  const definitions = structuredClone(base.component_definitions);
  for (const [nodeId, projectedNode] of Object.entries(projected.nodes)) {
    if (projectedNode.type !== "component") continue;
    const editedNode = edited.nodes[nodeId];
    if (!editedNode || editedNode.type !== "component") {
      compatibilityFailure(
        "V2_COMPONENT_ROOT_EDIT_UNSUPPORTED",
        `Component root ${nodeId} must remain a component.`,
        ["nodes", nodeId],
      );
    }
    const matching = Object.values(definitions).filter((definition) => definition.root_node_id === nodeId);
    if (matching.length !== 1 || !matching[0]) {
      compatibilityFailure(
        "V2_COMPONENT_ROOT_AMBIGUOUS",
        `Component root ${nodeId} does not resolve to one exact definition.`,
        ["nodes", nodeId],
      );
    }
    const definition = matching[0];
    definitions[definition.id] = {
      ...definition,
      key: editedNode.component_key,
      name: editedNode.name,
      documentation: {
        ...definition.documentation,
        summary: editedNode.description ?? "",
      },
    };
  }
  for (const [nodeId, editedNode] of Object.entries(edited.nodes)) {
    if (editedNode.type === "component" && !projected.nodes[nodeId]) {
      compatibilityFailure(
        "V2_COMPONENT_CREATE_UNSUPPORTED",
        "Create V2 component definitions through the V2 design-system workflow.",
        ["nodes", nodeId],
      );
    }
    if (editedNode.type === "instance" && !projected.nodes[nodeId]) {
      compatibilityFailure(
        "V2_COMPONENT_INSTANCE_CREATE_UNSUPPORTED",
        "Create typed V2 component instances through the V2 component workflow.",
        ["nodes", nodeId],
      );
    }
  }
  return definitions;
}

export function mergeV1CompatibilityDocument(
  input: DesignDocumentV2,
  editedInput: DesignDocument,
): DesignDocumentV2 {
  const base = DesignDocumentV2Schema.parse(input);
  const edited = DesignDocumentSchema.parse(editedInput);
  const projected = toV1CompatibleDesignDocument(base);
  assertSameIdentity(base, edited);
  if (equal(projected, edited)) return DesignDocumentV2Schema.parse(structuredClone(base));

  const candidate = migrateDesignDocumentV1ToV2(edited, {
    migratedAt: base.migration?.migrated_at ?? edited.updated_at,
    ...(base.migration?.source_revision_id === undefined ? {} : { sourceRevisionId: base.migration.source_revision_id }),
    ...(base.migration?.source_snapshot_hash === undefined ? {} : { sourceSnapshotHash: base.migration.source_snapshot_hash }),
    ...(base.migration?.verified_backup_id === undefined ? {} : { verifiedBackupId: base.migration.verified_backup_id }),
  });

  for (const nodeId of Object.keys(base.nodes)) mergeExistingNode(base, projected, edited, candidate, nodeId);
  preserveExistingPageFields(base, edited, candidate);
  candidate.component_definitions = updateComponentDefinitions(base, projected, edited);
  candidate.design_system = structuredClone(base.design_system);
  candidate.product_specification = structuredClone(base.product_specification);
  candidate.implementation_mappings = structuredClone(base.implementation_mappings);

  for (const [tokenId, baseToken] of Object.entries(base.tokens)) {
    const before = projected.tokens[tokenId];
    const after = edited.tokens[tokenId];
    if (!after) {
      compatibilityFailure("V2_TOKEN_REMOVAL_UNSUPPORTED", `Token ${tokenId} cannot be removed.`, ["tokens", tokenId]);
    }
    if (before && equal(before, after)) {
      candidate.tokens[tokenId] = structuredClone(baseToken);
      continue;
    }
    if (!tokenIsV1Writable(baseToken)) {
      compatibilityFailure(
        "V2_TOKEN_EDIT_UNSUPPORTED",
        `Token ${tokenId} uses aliases, modes, replacement links, or a structured V2 value and is read-only in the V1 editor.`,
        ["tokens", tokenId],
      );
    }
    if (!base.migration && before && !equal(before.metadata, after.metadata)) {
      compatibilityFailure(
        "V2_TOKEN_METADATA_EDIT_UNSUPPORTED",
        `Token metadata for ${tokenId} has no V2-native storage field.`,
        ["tokens", tokenId, "metadata"],
      );
    }
    const replacement = candidate.tokens[tokenId];
    if (replacement) candidate.tokens[tokenId] = { ...replacement, layer: baseToken.layer };
  }

  for (const [assetId, baseAsset] of Object.entries(base.assets)) {
    const before = projected.assets[assetId];
    const after = edited.assets[assetId];
    if (!after) {
      compatibilityFailure("V2_ASSET_REMOVAL_UNSUPPORTED", `Asset ${assetId} cannot be removed.`, ["assets", assetId]);
    }
    if (before && equal(before, after)) candidate.assets[assetId] = structuredClone(baseAsset);
    else {
      if (!base.migration && before && before.storage_key !== after.storage_key) {
        compatibilityFailure(
          "V2_ASSET_STORAGE_KEY_EDIT_UNSUPPORTED",
          `Asset storage keys are not editable V2 document fields.`,
          ["assets", assetId, "storage_key"],
        );
      }
      const replacement = candidate.assets[assetId];
      if (replacement) {
        candidate.assets[assetId] = {
          ...replacement,
          status: baseAsset.status,
          display_filename: baseAsset.display_filename,
        };
      }
    }
  }

  if (base.migration) {
    candidate.migration = {
      ...structuredClone(base.migration),
      ...(candidate.migration?.compatibility === undefined ? {} : { compatibility: candidate.migration.compatibility }),
      legacy_component_overrides: structuredClone(base.migration.legacy_component_overrides),
      diagnostics: structuredClone(base.migration.diagnostics),
    };
  } else {
    delete candidate.migration;
  }

  return DesignDocumentV2Schema.parse(candidate);
}

export function documentSchemaVersion(document: AnyDesignDocument): 1 | 2 {
  return document.schema_version;
}

import {
  AssetIdSchema,
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  DesignNodeSchema,
  DocumentIdSchema,
  NodeIdSchema,
  PageIdSchema,
  PrototypeLinkIdSchema,
  TokenIdSchema,
} from "@designer/core";
import { z } from "zod";

import { PreviewRenderMetadataSchema } from "./preview-render-metadata.js";

const identifier = z.string().trim().min(1).max(300);
const revisionId = z.string().regex(/^revision_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/);
const previewId = z.string().regex(/^preview_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const positiveVersion = z.number().int().positive().max(1_000_000_000);
const boundedLink = z.string().min(1).max(4_096);

export const DesignSummaryResultSchema = z.object({
  id: DocumentIdSchema,
  name: z.string().trim().min(1).max(255),
  version: positiveVersion,
  revisionId,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const DesignRevisionResultSchema = z.object({
  id: revisionId,
  version: positiveVersion,
  parentRevisionId: revisionId.nullable(),
  snapshotHash: sha256,
  operationHash: sha256,
  revisionHash: sha256,
  message: z.string().max(20_000).nullable(),
  createdAt: timestamp,
}).strict();

export const DesignHistoryRevisionResultSchema = DesignRevisionResultSchema.extend({
  actorId: identifier,
}).strict();

export const DesignDiagnosticResultSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().trim().min(1).max(240),
  message: z.string().min(1).max(20_000),
  node_id: NodeIdSchema.optional(),
  entity_id: identifier.optional(),
  path: z.union([
    z.string().max(2_000),
    z.array(z.union([z.string().max(500), z.number().int().min(-1_000_000_000).max(1_000_000_000)])).max(128),
  ]).optional(),
  safety: z.enum(["safe", "review_required", "blocked"]).optional(),
  entityKind: z.enum(["release", "token", "component", "project"]).optional(),
  entityId: identifier.optional(),
  target_version: positiveVersion.optional(),
  pin_source: z.enum(["project_design_system_pins", "formaspec_foundation_default"]).optional(),
  active_design_system_id: identifier.optional(),
  active_release_id: identifier.optional(),
  active_release_version: positiveVersion.optional(),
  historical_design_system_id: identifier.optional(),
  historical_release_id: identifier.optional(),
  historical_release_version: positiveVersion.optional(),
}).strict();

export const DesignDiagnosticsResultSchema = z.array(DesignDiagnosticResultSchema).max(20_000);

const createdIdsSchema = z.object({
  pages: z.array(PageIdSchema).max(500),
  nodes: z.array(NodeIdSchema).max(10_000),
  tokens: z.array(TokenIdSchema).max(500),
  assets: z.array(AssetIdSchema).max(500),
  prototype_links: z.array(PrototypeLinkIdSchema).max(500),
}).strict();
const entityId = z.union([
  DocumentIdSchema,
  PageIdSchema,
  NodeIdSchema,
  TokenIdSchema,
  AssetIdSchema,
  PrototypeLinkIdSchema,
]);
const temporaryIdMapSchema = z.record(
  z.string().regex(/^tmp:[A-Za-z0-9._-]{1,80}$/),
  entityId,
).superRefine((mapping, context) => {
  if (Object.keys(mapping).length > 500) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Temporary ID maps may contain at most 500 entries." });
  }
});

export const DesignCreatedIdsResultSchema = z.object({
  temporary: temporaryIdMapSchema,
  created: createdIdsSchema,
}).strict();

const inactiveContextSchema = z.object({
  designId: z.null(),
  pageId: z.null(),
  selection: z.array(NodeIdSchema).max(500),
  updatedAt: z.null(),
}).strict();
const activeContextSchema = z.object({
  designId: DocumentIdSchema,
  pageId: PageIdSchema.nullable(),
  selection: z.array(NodeIdSchema).max(500),
  updatedAt: timestamp,
  contextRef: z.string().regex(/^context_[a-f0-9]{24}$/),
  contextSource: z.enum(["actor", "workspace"]),
  version: positiveVersion,
  revisionId,
}).strict();
export const DesignContextResultSchema = z.union([inactiveContextSchema, activeContextSchema]);

export const NodeSearchResultSchema = z.object({
  id: NodeIdSchema,
  type: z.enum(["frame", "group", "rectangle", "ellipse", "text", "image", "icon", "component", "instance"]),
  name: z.string().trim().min(1).max(160),
  visible: z.boolean(),
  archived: z.boolean(),
}).strict();

const structureNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.enum(["frame", "group", "rectangle", "ellipse", "text", "image", "icon", "component", "instance"]),
  name: z.string().trim().min(1).max(160),
  visible: z.boolean(),
  locked: z.boolean(),
  archived: z.boolean(),
  children: z.array(NodeIdSchema).max(10_000).optional(),
}).strict();
const subtreeNodesSchema = z.record(NodeIdSchema, z.union([DesignNodeSchema, structureNodeSchema])).superRefine((nodes, context) => {
  if (Object.keys(nodes).length > 1_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Subtree responses may contain at most 1,000 nodes." });
  }
});
export const DesignSubtreeResultSchema = z.object({
  rootId: NodeIdSchema,
  parent: z.union([
    z.object({ page_id: PageIdSchema }).strict(),
    z.object({ node_id: NodeIdSchema }).strict(),
  ]).nullable(),
  depth: z.number().int().min(0).max(20),
  maxNodes: z.number().int().min(1).max(1_000),
  projection: z.enum(["full", "structure"]),
  truncated: z.boolean(),
  nodes: subtreeNodesSchema,
}).strict();

const runtimeVersionsSchema = z.object({
  commandEngine: z.string().trim().min(1).max(160),
  renderer: z.string().trim().min(1).max(160),
  fontBundle: z.string().trim().min(1).max(160),
}).strict();

export const DesignPreviewSummaryResultSchema = z.object({
  id: previewId,
  designId: DocumentIdSchema,
  rootBaseVersion: positiveVersion,
  baseRevisionId: revisionId,
  baseSnapshotHash: sha256,
  operationHash: sha256,
  resultSnapshotHash: sha256,
  expiresAt: timestamp,
  canCommit: z.boolean(),
  destructive: z.boolean(),
  kind: z.enum(["ordinary", "archive"]),
  status: z.enum(["ready", "blocked", "expired", "committed"]),
  changedNodeIds: z.array(NodeIdSchema).max(10_000),
  versions: runtimeVersionsSchema,
  diagnostics: DesignDiagnosticsResultSchema,
  createdIds: DesignCreatedIdsResultSchema,
  editorDeepLink: boundedLink,
}).strict();

export const DesignRenderResultSchema = z.object({
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  renderer: z.enum(["playwright", "software"]),
  warnings: z.array(z.string().max(4_000)).max(100),
}).strict();

export const DesignPreviewRenderResultSchema = DesignRenderResultSchema.extend({
  resourceUri: boundedLink,
}).strict();

export const DesignPersistedPreviewRenderResultSchema = PreviewRenderMetadataSchema.extend({
  resourceUri: boundedLink,
}).strict();

const restoreDesignSystemReferenceSchema = z.object({
  designSystemId: identifier,
  releaseId: identifier,
  releaseVersion: positiveVersion,
}).strict();
const designSystemCompatibilityDiagnosticSchema = z.object({
  code: z.string().trim().min(1).max(160),
  severity: z.enum(["info", "warning", "error"]),
  safety: z.enum(["safe", "review_required", "blocked"]),
  message: z.string().min(1).max(4_000),
  entityKind: z.enum(["release", "token", "component", "project"]).optional(),
  entityId: identifier.optional(),
  path: z.string().max(500).optional(),
}).strict();
export const DesignRestoreDispositionResultSchema = z.object({
  targetVersion: positiveVersion,
  targetRevisionId: revisionId,
  targetSnapshotHash: sha256,
  targetRevisionHash: sha256,
  targetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  designSystem: z.object({
    status: z.enum(["not_applicable_v1", "active_pin_unchanged", "active_pin_preserved"]),
    pinSource: z.enum(["project_design_system_pins", "formaspec_foundation_default"]).nullable(),
    active: restoreDesignSystemReferenceSchema.nullable(),
    historical: restoreDesignSystemReferenceSchema.nullable(),
    compatibilityDiagnostics: z.array(designSystemCompatibilityDiagnosticSchema).max(20_000),
  }).strict(),
}).strict();

export const DesignCreateV1SuccessSchema = z.object({
  design: DesignSummaryResultSchema,
  revision: DesignRevisionResultSchema,
  document: DesignDocumentSchema,
  schemaVersion: z.literal(1),
  diagnostics: DesignDiagnosticsResultSchema,
  deepLink: boundedLink,
}).strict();
export const DesignCreateV2SuccessSchema: z.AnyZodObject = z.object({
  design: DesignSummaryResultSchema,
  revision: DesignRevisionResultSchema,
  document: DesignDocumentV2Schema,
  compatibilityDocument: DesignDocumentSchema,
  schemaVersion: z.literal(2),
  diagnostics: DesignDiagnosticsResultSchema,
  deepLink: boundedLink,
}).strict();

export const DesignReadSubtreeSuccessSchema = z.object({
  design: DesignSummaryResultSchema,
  revision: DesignRevisionResultSchema,
  subtree: DesignSubtreeResultSchema,
  diagnostics: DesignDiagnosticsResultSchema,
}).strict();
export const DesignReadV1SuccessSchema = z.object({
  design: DesignSummaryResultSchema,
  revision: DesignRevisionResultSchema,
  document: DesignDocumentSchema,
  schemaVersion: z.literal(1),
  diagnostics: DesignDiagnosticsResultSchema,
}).strict();
export const DesignReadV2SuccessSchema: z.AnyZodObject = z.object({
  design: DesignSummaryResultSchema,
  revision: DesignRevisionResultSchema,
  document: DesignDocumentV2Schema,
  compatibilityDocument: DesignDocumentSchema,
  schemaVersion: z.literal(2),
  diagnostics: DesignDiagnosticsResultSchema,
}).strict();

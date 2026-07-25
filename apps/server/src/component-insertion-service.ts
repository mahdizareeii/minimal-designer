import { createHash } from "node:crypto";

import {
  AssetIdSchema,
  ComponentDefinitionIdSchema,
  ComponentSourceStateKeySchema,
  DesignDocumentV2Schema,
  NodeIdSchema,
  ParentReferenceSchema,
  type ComponentSourceStateKey,
  type ComponentPropertyValue,
  type DesignDocumentV2,
  type NodeId,
  type NodeStyle,
  type ParentReference,
} from "@designer/core";

import { prepareComponentInstanceInsertion } from "./component-insertion.js";
import { requireActiveDesign } from "./active-design.js";
import {
  listPinnedComponentRelease,
  resolvePinnedComponentRelease,
  type PinnedComponentReleaseCatalog,
} from "./component-release-resolver.js";
import { assertScope, resolveAccess } from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { createId } from "./ids.js";
import type { DesignerService, PreviewResult } from "./service.js";

export interface ComponentInsertionPreviewInput {
  baseVersion: number;
  taskId?: string;
  componentDefinitionId: string;
  parent: ParentReference;
  activeState?: ComponentSourceStateKey;
  index?: number;
  position?: { x: number; y: number };
  name?: string;
  properties?: Record<string, ComponentPropertyValue>;
  slots?: Record<string, string[]>;
  visualOverrides?: Partial<Record<NodeId, NodeStyle>>;
}

export interface ComponentInsertionPreviewResult {
  preview: PreviewResult;
  component: {
    designSystemId: string;
    releaseId: string;
    releaseVersion: number;
    componentDefinitionId: string;
    componentVersion: number;
    sourceHash: string;
    activeState: ComponentSourceStateKey;
    instanceId: string;
    nodeIdMapping: Record<string, string>;
    assetIdMapping: Record<string, string>;
  };
}

interface ComponentAssetRow {
  id: string;
  filename: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  width: number;
  height: number;
  sha256: string;
  data: Buffer;
  created_at: string;
}

export interface ComponentInsertionLibraryResult extends PinnedComponentReleaseCatalog {
  designId: string;
  baseVersion: number;
}

export class ComponentInsertionService {
  constructor(
    readonly database: DesignerDatabase,
    readonly designer: DesignerService,
  ) {}

  authorizeLibraryRead(actorId: string, designId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      assertScope(access, "design:read");
      assertScope(access, "design_system:read");
    }
    requireActiveDesign(this.database.sqlite, access, designId);
    this.designer.authorizeDesignRead(actorId, designId);
  }

  authorizePreview(actorId: string, designId: string, taskId?: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      assertScope(access, "design:read");
      assertScope(access, "design_system:read");
    }
    requireActiveDesign(this.database.sqlite, access, designId);
    this.designer.authorizePreviewCreation(actorId, designId, taskId);
  }

  library(actorId: string, designId: string): ComponentInsertionLibraryResult {
    this.authorizeLibraryRead(actorId, designId);
    const current = this.designer.getDesign(actorId, designId);
    if (current.canonicalDocument.schema_version !== 2) {
      throw new DomainError("VALIDATION_FAILED", "Component insertion requires a strict V2 project revision.", 422);
    }
    const document = DesignDocumentV2Schema.parse(current.canonicalDocument);
    const design = requireActiveDesign(
      this.database.sqlite,
      resolveAccess(this.database.sqlite, actorId),
      designId,
    );
    return {
      designId,
      baseVersion: current.revision.version,
      ...listPinnedComponentRelease(this.database, design.organization_id, document),
    };
  }

  preview(
    actorId: string,
    designId: string,
    rawInput: ComponentInsertionPreviewInput,
  ): ComponentInsertionPreviewResult {
    this.authorizePreview(actorId, designId, rawInput.taskId);
    if (!Number.isInteger(rawInput.baseVersion) || rawInput.baseVersion < 1) {
      throw new DomainError("VALIDATION_FAILED", "Component insertion baseVersion must be a positive integer.", 422);
    }
    const componentDefinitionId = ComponentDefinitionIdSchema.parse(rawInput.componentDefinitionId);
    const parent = ParentReferenceSchema.parse(rawInput.parent);
    const activeState = ComponentSourceStateKeySchema.parse(rawInput.activeState ?? "default");
    if (rawInput.index !== undefined && (!Number.isInteger(rawInput.index) || rawInput.index < 0)) {
      throw new DomainError("VALIDATION_FAILED", "Component insertion index must be a non-negative integer.", 422);
    }
    const current = this.designer.getDesign(actorId, designId);
    if (current.revision.version !== rawInput.baseVersion) {
      throw new DomainError("VERSION_CONFLICT", "The project changed before component insertion preview.", 409, {
        retryable: true,
        details: {
          expectedBaseVersion: rawInput.baseVersion,
          currentVersion: current.revision.version,
          currentRevisionId: current.revision.id,
        },
      });
    }
    if (current.canonicalDocument.schema_version !== 2) {
      throw new DomainError("VALIDATION_FAILED", "Component insertion requires a strict V2 project revision.", 422);
    }
    const document = DesignDocumentV2Schema.parse(current.canonicalDocument);
    const design = requireActiveDesign(
      this.database.sqlite,
      resolveAccess(this.database.sqlite, actorId),
      designId,
    );
    const resolved = resolvePinnedComponentRelease(
      this.database,
      design.organization_id,
      document,
      componentDefinitionId,
    );
    const transaction = this.database.sqlite.transaction(() => {
      const instanceId = NodeIdSchema.parse(createId("node"));
      const componentAssetIds = [...new Set([
        ...resolved.source.dependencies.asset_ids,
        ...resolved.nestedComponents.flatMap((component) => component.source.dependencies.asset_ids),
      ])];
      const assetCopies = this.copyReleasedComponentAssets(
        actorId,
        designId,
        design.organization_id,
        componentAssetIds,
      );
      const prepared = prepareComponentInstanceInsertion({
        document,
        designSystemId: resolved.designSystemId,
        definition: resolved.definition,
        source: resolved.source,
        sourceHash: resolved.sourceHash,
        releaseTokens: resolved.releaseTokens,
        parent,
        instanceId,
        activeState,
        assetCopies,
        componentDependencies: resolved.nestedComponents,
        ...(rawInput.index === undefined ? {} : { index: rawInput.index }),
        ...(rawInput.position === undefined ? {} : { position: rawInput.position }),
        ...(rawInput.name === undefined ? {} : { name: rawInput.name }),
        ...(rawInput.properties === undefined ? {} : { properties: rawInput.properties }),
        ...(rawInput.slots === undefined ? {} : {
          slots: Object.fromEntries(Object.entries(rawInput.slots).map(([key, nodeIds]) => [
            key,
            nodeIds.map((nodeId) => NodeIdSchema.parse(nodeId)),
          ])),
        }),
        ...(rawInput.visualOverrides === undefined ? {} : { visualOverrides: rawInput.visualOverrides }),
      });
      const createdTokenIds = prepared.hydratedTokenIds.filter((tokenId) => document.tokens[tokenId] === undefined);
      const preview = this.designer.createPreparedPreview(actorId, designId, {
        baseVersion: rawInput.baseVersion,
        operations: [prepared.operation],
        document: prepared.document,
        createdIds: {
          pages: [],
          nodes: prepared.createdNodeIds,
          tokens: createdTokenIds,
          assets: prepared.hydratedAssetIds,
          prototype_links: [],
        },
        ...(rawInput.taskId === undefined ? {} : { taskId: rawInput.taskId }),
      });
      return {
        preview,
        component: {
          designSystemId: resolved.designSystemId,
          releaseId: resolved.releaseId,
          releaseVersion: resolved.releaseVersion,
          componentDefinitionId,
          componentVersion: resolved.definition.version,
          sourceHash: resolved.sourceHash,
          activeState,
          instanceId,
          nodeIdMapping: prepared.nodeIdMapping,
          assetIdMapping: Object.fromEntries(assetCopies.map((copy) => [copy.sourceAssetId, copy.asset.id])),
        },
      };
    });
    return transaction.immediate();
  }

  private copyReleasedComponentAssets(
    actorId: string,
    designId: string,
    organizationId: string,
    sourceAssetIds: readonly string[],
  ): Array<{
    sourceAssetId: string;
    asset: DesignDocumentV2["assets"][string];
  }> {
    return sourceAssetIds.map((rawSourceAssetId) => {
      const sourceAssetId = AssetIdSchema.parse(rawSourceAssetId);
      const source = this.database.sqlite.prepare(
        `SELECT id, filename, mime_type, size_bytes, width, height, sha256, data, created_at
         FROM assets WHERE id = ? AND organization_id = ?`,
      ).get(sourceAssetId, organizationId) as ComponentAssetRow | undefined;
      if (!source || !["image/png", "image/jpeg", "image/webp"].includes(source.mime_type)) {
        throw new DomainError("VALIDATION_FAILED", "A released component asset dependency is unavailable.", 422, {
          details: { sourceAssetId },
        });
      }
      const normalized = this.designer.assetStore?.readNormalized(
        source.sha256,
        source.mime_type,
        source.size_bytes,
      ) ?? null;
      const data = normalized ?? Buffer.from(source.data);
      if (data.length !== source.size_bytes
        || createHash("sha256").update(data).digest("hex") !== source.sha256) {
        throw new DomainError("INTERNAL_ERROR", "A released component asset failed its content hash verification.", 500, {
          details: { sourceAssetId },
        });
      }
      let target = this.database.sqlite.prepare(
        `SELECT id, filename, mime_type, size_bytes, width, height, sha256, data, created_at
         FROM assets
         WHERE organization_id = ? AND design_id = ? AND sha256 = ? AND mime_type = ?
           AND size_bytes = ? AND width = ? AND height = ?
         ORDER BY created_at, id LIMIT 1`,
      ).get(
        organizationId,
        designId,
        source.sha256,
        source.mime_type,
        source.size_bytes,
        source.width,
        source.height,
      ) as ComponentAssetRow | undefined;
      if (!target) {
        const targetAssetId = AssetIdSchema.parse(createId("asset"));
        const now = new Date().toISOString();
        this.database.sqlite.prepare(
          `INSERT INTO assets
           (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetAssetId,
          actorId,
          designId,
          source.filename,
          source.mime_type,
          source.size_bytes,
          source.width,
          source.height,
          source.sha256,
          data,
          now,
          organizationId,
        );
        target = { ...source, id: targetAssetId, data, created_at: now };
      }
      return {
        sourceAssetId,
        asset: {
          id: AssetIdSchema.parse(target.id),
          name: target.filename,
          kind: "image" as const,
          mime_type: target.mime_type,
          size_bytes: target.size_bytes,
          sha256: target.sha256,
          width: target.width,
          height: target.height,
          status: "ready" as const,
          display_filename: target.filename,
          metadata: {
            copied_from_component_asset_id: sourceAssetId,
            copied_by_content_hash: true,
          },
        },
      };
    });
  }
}

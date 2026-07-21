import {
  ComponentDefinitionIdSchema,
  ComponentSourceStateKeySchema,
  DesignDocumentV2Schema,
  NodeIdSchema,
  ParentReferenceSchema,
  type ComponentSourceStateKey,
  type ParentReference,
} from "@designer/core";

import { prepareComponentInstanceInsertion } from "./component-insertion.js";
import { resolvePinnedComponentRelease } from "./component-release-resolver.js";
import { assertScope, resolveAccess } from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { createId } from "./ids.js";
import type { DesignerService, PreviewResult } from "./service.js";

export interface ComponentInsertionPreviewInput {
  baseVersion: number;
  componentDefinitionId: string;
  parent: ParentReference;
  activeState?: ComponentSourceStateKey;
  index?: number;
  position?: { x: number; y: number };
  name?: string;
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
  };
}

export class ComponentInsertionService {
  constructor(
    readonly database: DesignerDatabase,
    readonly designer: DesignerService,
  ) {}

  authorizePreview(actorId: string, designId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      assertScope(access, "design:read");
      assertScope(access, "design_system:read");
    }
    this.designer.authorizePreviewCreation(actorId, designId);
  }

  preview(
    actorId: string,
    designId: string,
    rawInput: ComponentInsertionPreviewInput,
  ): ComponentInsertionPreviewResult {
    this.authorizePreview(actorId, designId);
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
    const design = this.database.sqlite.prepare(
      "SELECT organization_id FROM designs WHERE id = ?",
    ).get(designId) as { organization_id: string } | undefined;
    if (!design) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    const resolved = resolvePinnedComponentRelease(
      this.database,
      design.organization_id,
      document,
      componentDefinitionId,
    );
    const instanceId = NodeIdSchema.parse(createId("node"));
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
      ...(rawInput.index === undefined ? {} : { index: rawInput.index }),
      ...(rawInput.position === undefined ? {} : { position: rawInput.position }),
      ...(rawInput.name === undefined ? {} : { name: rawInput.name }),
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
        assets: [],
        prototype_links: [],
      },
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
      },
    };
  }
}

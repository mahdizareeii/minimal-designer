import { createHash } from "node:crypto";

import { FORMASPEC_FOUNDATION_SYSTEM } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { ComponentInsertionService } from "./component-insertion-service.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { DesignerService } from "./service.js";
import { createComponentSourceRevisionFixture } from "../test-fixtures/component-source.js";

const databases: DesignerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

describe("component insertion preview service", () => {
  it("resolves the pinned release, persists exact prepared bytes, and commits through ordinary preview CAS", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const designer = new DesignerService(database, new EventHub(), 900);
    const parentId = "node_component_insertion_parent_01";
    const sourceRevision = createComponentSourceRevisionFixture(
      database,
      designer,
      "local",
      [parentId],
      "component-insertion-service",
    );
    const selection = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions[0]!;
    const insertions = new ComponentInsertionService(database, designer);
    const beforeHistory = designer.history("local", sourceRevision.designId);
    const result = insertions.preview("local", sourceRevision.designId, {
      baseVersion: 2,
      componentDefinitionId: selection.component_definition_id,
      parent: { node_id: parentId },
      position: { x: 32.5, y: 48.25 },
    });

    expect(designer.history("local", sourceRevision.designId)).toEqual(beforeHistory);
    expect(result.preview.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.preview).toMatchObject({
      rootBaseVersion: 2,
      status: "ready",
      canCommit: true,
      kind: "ordinary",
      schemaVersion: 2,
    });
    expect(result.component).toMatchObject({
      componentDefinitionId: selection.component_definition_id,
      componentVersion: selection.version,
      activeState: "default",
    });
    expect(result.component.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const preview = designer.getPreview("local", sourceRevision.designId, result.preview.id);
    expect(preview.resultSnapshotHash).toBe(result.preview.resultSnapshotHash);
    expect(preview.canonicalDocument).toEqual(result.preview.canonicalDocument);

    const committed = designer.commitPreview("local", sourceRevision.designId, {
      previewId: result.preview.id,
      expectedBaseVersion: 2,
      idempotencyKey: "component-insertion-commit-0001",
      kind: "ordinary",
      message: "Insert Foundation component",
    });
    expect(committed.revision.snapshotHash).toBe(result.preview.resultSnapshotHash);
    expect(committed.canonicalDocument).toEqual(result.preview.canonicalDocument);
    expect(committed.revision.version).toBe(3);
    if (committed.canonicalDocument.schema_version !== 2) throw new Error("expected V2 document");
    expect(committed.canonicalDocument.nodes[result.component.instanceId]).toMatchObject({
      type: "component_instance",
      component_definition_id: selection.component_definition_id,
      component_version: selection.version,
    });
  });

  it("rejects stale base versions before persisting a preview", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const designer = new DesignerService(database, new EventHub(), 900);
    const parentId = "node_component_insertion_parent_02";
    const sourceRevision = createComponentSourceRevisionFixture(
      database,
      designer,
      "local",
      [parentId],
      "component-insertion-stale",
    );
    const selection = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions[0]!;
    const insertions = new ComponentInsertionService(database, designer);
    expect(() => insertions.preview("local", sourceRevision.designId, {
      baseVersion: 1,
      componentDefinitionId: selection.component_definition_id,
      parent: { node_id: parentId },
    })).toThrow(/changed before component insertion preview/);
    const previews = database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM previews WHERE design_id = ?",
    ).get(sourceRevision.designId) as { count: number };
    expect(previews.count).toBe(0);
  });

  it("copies released image dependencies into the target design by verified content hash", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const designer = new DesignerService(database, new EventHub(), 900);
    const source = createComponentSourceRevisionFixture(
      database,
      designer,
      "local",
      ["node_component_asset_source_parent_01"],
      "component-asset-source",
    );
    const target = createComponentSourceRevisionFixture(
      database,
      designer,
      "local",
      ["node_component_asset_target_parent_01"],
      "component-asset-target",
    );
    const organization = database.sqlite.prepare(
      "SELECT organization_id FROM designs WHERE id = ?",
    ).get(target.designId) as { organization_id: string };
    const data = Buffer.from("verified-component-asset-copy", "utf8");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const sourceAssetId = "asset_component_copy_source_01";
    database.sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
       VALUES (?, 'local', ?, 'component.png', 'image/png', ?, 16, 12, ?, ?, '2026-07-25T00:00:00.000Z', ?)`,
    ).run(sourceAssetId, source.designId, data.length, sha256, data, organization.organization_id);

    type CopyReleasedAssets = (
      actorId: string,
      designId: string,
      organizationId: string,
      sourceAssetIds: readonly string[],
    ) => Array<{ sourceAssetId: string; asset: { id: string; sha256?: string } }>;
    const insertions = new ComponentInsertionService(database, designer);
    const copyReleasedAssets = (insertions as unknown as {
      copyReleasedComponentAssets: CopyReleasedAssets;
    }).copyReleasedComponentAssets.bind(insertions);
    const first = copyReleasedAssets("local", target.designId, organization.organization_id, [sourceAssetId]);
    const second = copyReleasedAssets("local", target.designId, organization.organization_id, [sourceAssetId]);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sourceAssetId, asset: { sha256 } });
    expect(first[0]!.asset.id).not.toBe(sourceAssetId);
    expect(second[0]!.asset.id).toBe(first[0]!.asset.id);
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM assets WHERE design_id = ? AND sha256 = ?",
    ).get(target.designId, sha256)).toEqual({ count: 1 });
  });

  it("does not expose component libraries or previews for archived projects", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const designer = new DesignerService(database, new EventHub(), 900);
    const parentId = "node_component_insertion_parent_03";
    const sourceRevision = createComponentSourceRevisionFixture(
      database,
      designer,
      "local",
      [parentId],
      "component-insertion-archived",
    );
    const current = designer.getDesign("local", sourceRevision.designId, 2);
    designer.archiveDesign("local", sourceRevision.designId, {
      expectedVersion: 2,
      idempotencyKey: "component-insertion-archive-0001",
      confirmationName: current.design.name,
    });
    const insertions = new ComponentInsertionService(database, designer);
    const selection = FORMASPEC_FOUNDATION_SYSTEM.release.component_versions[0]!;

    expect(captureThrown(() => insertions.library("local", sourceRevision.designId)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => insertions.preview("local", sourceRevision.designId, {
      baseVersion: 2,
      componentDefinitionId: selection.component_definition_id,
      parent: { node_id: parentId },
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM previews WHERE design_id = ?",
    ).get(sourceRevision.designId)).toEqual({ count: 0 });
  });
});

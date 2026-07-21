import { createHash } from "node:crypto";

import {
  ContainerNodeV2Schema,
  DesignDocumentV2Schema,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";

import type { DesignerDatabase } from "../src/db/database.js";
import { canonicalJson } from "../src/ids.js";
import {
  operationHash,
  revisionHash,
  storeSnapshot,
} from "../src/persistence.js";
import type { DesignerService } from "../src/service.js";

export interface ComponentSourceRevisionFixture {
  designId: string;
  revisionId: string;
}

export function createComponentSourceRevisionFixture(
  database: DesignerDatabase,
  designer: DesignerService,
  actorId: string,
  rootNodeIds: readonly string[],
  label: string,
): ComponentSourceRevisionFixture {
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 24);
  const created = designer.createDesign(actorId, {
    name: `Component source ${label}`,
    preset: "web",
    idempotencyKey: `component-source-fixture-${digest}`,
  });
  const migratedAt = "2026-07-19T09:59:00.000Z";
  const migrated = migrateDesignDocumentV1ToV2({
    ...created.canonicalDocument,
    revision: 2,
    updated_at: migratedAt,
  }, { migratedAt });
  const page = migrated.pages[0];
  const template = Object.values(migrated.nodes).find((node) => node.type === "frame");
  if (!page || !template || template.type !== "frame") {
    throw new Error("Component-source fixture starter is missing its frame template.");
  }
  const nodes = Object.fromEntries(rootNodeIds.map((rootNodeId, index) => {
    const {
      locale: _locale,
      text_direction: _textDirection,
      user_story: _userStory,
      screen_purpose: _screenPurpose,
      screen_state: _screenState,
      primary_action: _primaryAction,
      ...containerTemplate
    } = structuredClone(template);
    const node = ContainerNodeV2Schema.parse({
      ...containerTemplate,
      type: "container",
      id: rootNodeId,
      name: `Component state ${index + 1}`,
      children: [],
      layout: {
        ...template.layout,
        x: index * 420,
        y: 0,
      },
      semantics: {
        ...template.semantics,
        business_rule_ids: [],
        acceptance_criterion_ids: [],
      },
      metadata: { component_source_fixture: label, state_index: index },
      visible: true,
      archived: false,
    });
    return [rootNodeId, node];
  }));
  const document = DesignDocumentV2Schema.parse({
    ...migrated,
    pages: [{ ...page, children: [...rootNodeIds] }],
    nodes,
    prototype_links: {},
    component_definitions: {},
    implementation_mappings: {},
    revision: 2,
    updated_at: migratedAt,
  });
  const parent = database.sqlite.prepare(
    `SELECT id, revision_hash FROM revisions WHERE design_id = ? AND version = 1`,
  ).get(created.design.id) as { id: string; revision_hash: string } | undefined;
  if (!parent) throw new Error("Component-source fixture parent revision is missing.");
  const revisionId = `revision_component_source_${digest}`;
  const snapshot = storeSnapshot(database.sqlite, document, migratedAt);
  const operationsHash = operationHash([]);
  const integrityHash = revisionHash({
    parentRevisionHash: parent.revision_hash,
    snapshotHash: snapshot.hash,
    operationHash: operationsHash,
    metadata: {
      id: revisionId,
      designId: created.design.id,
      version: 2,
      parentRevisionId: parent.id,
      actorId,
      message: "Create test component source revision",
      createdAt: migratedAt,
    },
  });
  database.sqlite.prepare(
    `INSERT INTO revisions
     (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
      snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
     VALUES (?, ?, 2, ?, ?, 'Create test component source revision', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    created.design.id,
    parent.id,
    actorId,
    snapshot.canonicalJson,
    canonicalJson([]),
    snapshot.hash,
    operationsHash,
    parent.revision_hash,
    integrityHash,
    migratedAt,
  );
  const updated = database.sqlite.prepare(
    `UPDATE designs SET current_version = 2, current_revision_id = ?, updated_at = ?
     WHERE id = ? AND current_version = 1 AND current_revision_id = ?`,
  ).run(revisionId, migratedAt, created.design.id, parent.id);
  if (updated.changes !== 1) throw new Error("Component-source fixture head update failed.");
  return { designId: created.design.id, revisionId };
}

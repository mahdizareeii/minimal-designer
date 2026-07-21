import {
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePinnedComponentRelease } from "./component-release-resolver.js";
import { DesignerDatabase } from "./db/database.js";

const databases: DesignerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("pinned component release resolution", () => {
  it("resolves every FormaSpec Foundation component to a verified bounded source", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const document = migrateDesignDocumentV1ToV2(createStarterDocument({
      now: "2026-07-21T09:00:00.000Z",
      idFactory: createSequentialIdFactory("foundationresolver"),
    }), { migratedAt: "2026-07-21T09:01:00.000Z" });

    expect(document.design_system.release_id).toBe(FORMASPEC_FOUNDATION_RELEASE_ID);
    for (const selection of FORMASPEC_FOUNDATION_SYSTEM.release.component_versions) {
      const resolved = resolvePinnedComponentRelease(
        database,
        "organization_legacy",
        document,
        selection.component_definition_id,
      );
      expect(resolved).toMatchObject({
        designSystemId: FORMASPEC_FOUNDATION_SYSTEM.id,
        releaseId: FORMASPEC_FOUNDATION_RELEASE_ID,
        releaseVersion: FORMASPEC_FOUNDATION_SYSTEM.release.version,
        definition: { id: selection.component_definition_id, version: selection.version },
        source: {
          component_definition_id: selection.component_definition_id,
          component_version: selection.version,
        },
      });
      expect(resolved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(resolved.source.nodes.length).toBeGreaterThan(0);
    }
  });
});

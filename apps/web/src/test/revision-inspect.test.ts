import { createStarterDocument, migrateDesignDocumentV1ToV2 } from "@designer/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readRevisionInspect } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revision inspect API", () => {
  it("keeps a strict V2 canonical document and the pinned revision separate from the current head", async () => {
    const source = createStarterDocument({ name: "Pinned V2 inspect" });
    const document = migrateDesignDocumentV1ToV2(source, {
      sourceRevisionId: "revision_webinspect0001",
      sourceSnapshotHash: "a".repeat(64),
      verifiedBackupId: "backup_webinspect00001",
    });
    document.revision = 3;
    const revisionId = "revision_webinspect0003";
    const projectId = document.id;
    const response = {
      project: {
        id: projectId,
        name: document.name,
        version: 3,
        revisionId,
        updatedAt: document.updated_at,
      },
      head: { version: 4, revisionId: "revision_webinspect0004" },
      revision: {
        id: revisionId,
        version: 3,
        parentRevisionId: "revision_webinspect0002",
        revisionHash: "b".repeat(64),
        snapshotHash: "c".repeat(64),
        operationHash: "d".repeat(64),
        message: "Migrate to V2",
        createdAt: document.updated_at,
      },
      integrity: {
        revisionId,
        parentRevisionId: "revision_webinspect0002",
        revisionHash: "b".repeat(64),
        snapshotHash: "c".repeat(64),
        operationHash: "d".repeat(64),
        schemaVersion: 2,
        documentRevision: 3,
        createdAt: document.updated_at,
      },
      document,
      nodes: [],
      tokens: {},
      assets: {},
      prototypeLinks: {},
      productSpecification: null,
      evidence: {
        tokens: [],
        assets: [],
        components: [],
        businessRules: [],
        acceptanceCriteria: [],
        implementationMappings: [],
      },
      limitations: [],
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await readRevisionInspect(projectId, revisionId);

    expect(result.document.schema_version).toBe(2);
    expect(result.project).toMatchObject({ version: 3, revisionId });
    expect(result.head).toEqual({ version: 4, revisionId: "revision_webinspect0004" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/inspect`,
    );
  });
});

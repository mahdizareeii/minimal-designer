import { createStarterDocument } from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictRecoveryPanel } from "../components/ConflictRecoveryPanel";
import { duplicateConflictDraft } from "../lib/api";
import {
  canonicalJson,
  createConflictPatchArtifact,
  createConflictRecovery,
  latestRevisionFromConflictDetails,
  loadPersistedConflictRecovery,
  parseConflictPatchJson,
  persistConflictRecovery,
  removePersistedConflictRecovery,
  MAX_CONFLICT_RECOVERY_OPERATION_BYTES,
} from "../lib/conflict-recovery";

describe("browser conflict recovery contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes exact operations and emits deterministic, strict, hash-verified patch bytes", async () => {
    const document = createStarterDocument({ preset: "phone", name: "Recovery fixture" });
    const frameId = document.pages[0]!.children[0]!;
    const baseVersion = 1;
    const recovery = await createConflictRecovery({
      designId: document.id,
      baseVersion,
      baseRevisionId: "revision_fixture_000001",
      latestRevision: {
        version: baseVersion + 1,
        id: "revision_fixture_000002",
        actor: "usr_codex_fixture",
        createdAt: "2026-07-21T08:30:00.000Z",
      },
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Local draft" } }],
      createdAt: "2026-07-21T08:31:00.000Z",
    });

    const first = await createConflictPatchArtifact(recovery);
    const second = await createConflictPatchArtifact(structuredClone(recovery));
    expect(second).toEqual(first);
    expect(first.filename).toMatch(new RegExp(`-base-v${baseVersion}-[a-f0-9]{12}\\.formaspec\\.patch\\.json$`));
    expect(first.json).toBe(`${canonicalJson(JSON.parse(first.json))}\n`);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);

    const parsed = await parseConflictPatchJson(first.json);
    expect(parsed.operations).toEqual(recovery.operations);
    expect(parsed.operation_hash).toBe(recovery.operationHash);
    expect(parsed.patch_sha256).toBe(first.sha256);

    const extra = { ...JSON.parse(first.json), unexpected: true };
    await expect(parseConflictPatchJson(`${canonicalJson(extra)}\n`)).rejects.toThrow(/unsupported fields/i);

    const tampered = JSON.parse(first.json) as Record<string, unknown>;
    tampered.operations = [{ type: "update_node", node_id: frameId, patch: { name: "Tampered" } }];
    await expect(parseConflictPatchJson(`${canonicalJson(tampered)}\n`)).rejects.toThrow(/operation hash/i);
  });

  it("captures supplied latest revision metadata and renders untrusted actor text only as data", async () => {
    const latest = latestRevisionFromConflictDetails({
      currentVersion: 7,
      currentRevisionId: "revision_fixture_000007",
      currentActor: "<img src=x onerror=alert(1)>",
      currentRevisionCreatedAt: "2026-07-21T09:00:00.000Z",
    });
    expect(latest).toEqual({
      version: 7,
      id: "revision_fixture_000007",
      actor: "<img src=x onerror=alert(1)>",
      createdAt: "2026-07-21T09:00:00.000Z",
    });

    const document = createStarterDocument({ preset: "web" });
    const frameId = document.pages[0]!.children[0]!;
    const recovery = await createConflictRecovery({
      designId: document.id,
      baseVersion: 1,
      latestRevision: latest,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Protected" } }],
      createdAt: "2026-07-21T09:01:00.000Z",
    });
    const html = renderToStaticMarkup(
      <ConflictRecoveryPanel
        recovery={recovery}
        durable
        canLoadLatest
        busy={null}
        onLoadLatest={vi.fn()}
        onExportPatch={vi.fn()}
        onDuplicate={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(html).toContain("Load latest");
    expect(html).toContain("Export patch");
    expect(html).toContain("Duplicate local draft");
    expect(html).toContain("Discard recovery");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("restores a canonical recovery after a browser reload and removes it only on explicit discard", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const document = createStarterDocument({ preset: "tablet" });
    const frameId = document.pages[0]!.children[0]!;
    const recovery = await createConflictRecovery({
      designId: document.id,
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Reload-safe" } }],
      createdAt: "2026-07-21T09:02:00.000Z",
    });

    expect(persistConflictRecovery(recovery)).toBe(true);
    expect(await loadPersistedConflictRecovery(document.id)).toEqual(recovery);
    expect(removePersistedConflictRecovery(document.id)).toBe(true);
    expect(await loadPersistedConflictRecovery(document.id)).toBeNull();
  });

  it("enforces the server's 500-operation and 1 MiB canonical operation limits", async () => {
    const document = createStarterDocument({ preset: "web" });
    const frameId = document.pages[0]!.children[0]!;
    const ordinary = { type: "update_node" as const, node_id: frameId, patch: { name: "Bounded" } };
    await expect(createConflictRecovery({
      designId: document.id,
      baseVersion: 1,
      operations: Array.from({ length: 501 }, () => ordinary),
    })).rejects.toThrow(/at most 500 operations/i);
    await expect(createConflictRecovery({
      designId: document.id,
      baseVersion: 1,
      operations: Array.from({ length: 20 }, (_, index) => ({
        type: "update_node" as const,
        node_id: frameId,
        patch: { content: `${index}:${"x".repeat(99_990)}` },
      })),
    })).rejects.toThrow(/1 MiB/i);
  });

  it("round-trips a near-limit operation payload with a separately bounded patch envelope", async () => {
    const document = createStarterDocument({ preset: "web" });
    const frameId = document.pages[0]!.children[0]!;
    const operationsFor = (tailLength: number) => [
      ...Array.from({ length: 10 }, (_, index) => ({
        type: "update_node" as const,
        node_id: frameId,
        patch: { content: `${index}:${"x".repeat(99_998)}` },
      })),
      {
        type: "update_node" as const,
        node_id: frameId,
        patch: { content: "y".repeat(tailLength) },
      },
    ];
    let low = 0;
    let high = 100_000;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      const bytes = new TextEncoder().encode(canonicalJson(operationsFor(candidate))).byteLength;
      if (bytes <= MAX_CONFLICT_RECOVERY_OPERATION_BYTES) low = candidate;
      else high = candidate - 1;
    }
    const operations = operationsFor(low);
    const operationBytes = new TextEncoder().encode(canonicalJson(operations)).byteLength;
    expect(operationBytes).toBeLessThanOrEqual(MAX_CONFLICT_RECOVERY_OPERATION_BYTES);
    expect(operationBytes).toBeGreaterThan(MAX_CONFLICT_RECOVERY_OPERATION_BYTES - 256);
    const recovery = await createConflictRecovery({ designId: document.id, baseVersion: 1, operations });
    const artifact = await createConflictPatchArtifact(recovery);
    expect(new TextEncoder().encode(artifact.json).byteLength).toBeGreaterThan(MAX_CONFLICT_RECOVERY_OPERATION_BYTES);
    await expect(parseConflictPatchJson(artifact.json)).resolves.toMatchObject({ operations });
  });

  it("accepts the exact nullable V1 duplicate contract and rejects malformed success responses", async () => {
    const document = createStarterDocument({ preset: "web" });
    const frameId = document.pages[0]!.children[0]!;
    const response = {
      duplicated: true,
      source: {
        projectId: document.id,
        baseVersion: 1,
        baseRevisionId: "revision_conflictreview_000001",
        baseSnapshotHash: "a".repeat(64),
        baseRevisionHash: "b".repeat(64),
        currentVersion: 2,
        currentRevisionId: "revision_conflictreview_000002",
      },
      project: {
        id: "document_conflictreview_000002",
        name: "Recovered draft",
        version: 1,
        revisionId: "revision_conflictreview_000003",
        snapshotHash: "c".repeat(64),
        operationHash: "d".repeat(64),
        revisionHash: "e".repeat(64),
        schemaVersion: 1,
        assetCount: 0,
        productSpecificationVersion: null,
        implementationMappingCount: 0,
      },
      idMapping: { [document.id]: "document_conflictreview_000002" },
      diagnostics: [],
      deepLink: "/design/document_conflictreview_000002",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, duplicated: false }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const operation = [{ type: "update_node" as const, node_id: frameId, patch: { name: "Recovered" } }];
    await expect(duplicateConflictDraft(document.id, 1, operation, "conflict-review-key-0001")).resolves.toMatchObject({
      duplicated: true,
      project: { productSpecificationVersion: null },
    });
    await expect(duplicateConflictDraft(document.id, 1, operation, "conflict-review-key-0002")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

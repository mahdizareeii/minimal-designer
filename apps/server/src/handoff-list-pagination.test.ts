import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";
import type { HandoffSpecification, UploadRepositoryInventory } from "./workspace-handoff-service.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-handoff-list-"));
  temporaryDirectories.push(root);
  const built = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(built);
  await built.app.ready();
  return built;
}

const inventoryEntityId = `inv_${"1".repeat(40)}`;

function repositoryInventory(): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: "2026-07-21T08:00:00.000Z",
    platforms: ["web"],
    gitHead: "b".repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 1,
    skippedFileCount: 0,
    bytesRead: 128,
    truncated: false,
    entities: [{
      id: inventoryEntityId,
      kind: "route",
      name: "Checkout route",
      symbol: null,
      locationId: `loc_${"2".repeat(40)}`,
      line: 12,
    }],
    excluded: [],
  };
}

function specification(index: number): HandoffSpecification {
  return {
    schemaVersion: 1,
    title: `Implement checkout slice ${index}`,
    summary: `Bounded handoff summary ${index}; detailed history remains available only through handoff_read.`,
    acceptanceCriteria: [{
      id: `criterion_${index}`,
      statement: "The implementation matches the selected immutable revision.",
      designEntityIds: [],
    }],
    implementationSlices: [{
      id: `slice_${index}`,
      title: `Checkout slice ${index}`,
      objective: "Implement the bounded checkout change without unrelated source access.",
      inventoryEntityIds: [inventoryEntityId],
      designEntityIds: [],
      dependsOn: [],
      validationChecks: index % 2 === 0 ? ["typecheck", "unit_tests"] : ["typecheck"],
    }],
    risks: [],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
  };
}

function createGrant(
  built: DesignerApplication,
  id: string,
  projectIds: string[],
): string {
  const principalId = `principal_${id}`;
  const now = "2026-07-21T08:00:00.000Z";
  built.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, id, `handoff-list:${id}`, now);
  built.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, 'agent', ?)`,
  ).run(principalId, now);
  built.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'generic_mcp', ?, 'active', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(
    `connection_${id}`,
    principalId,
    id,
    JSON.stringify(["handoff:read"]),
    JSON.stringify(projectIds),
    now,
    now,
  );
  built.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`,
  ).run(
    id,
    principalId,
    createHash("sha256").update(id).digest("hex"),
    JSON.stringify(["handoff:read"]),
    JSON.stringify(projectIds),
    now,
  );
  return `grant_${id}`;
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

async function fixture() {
  const built = await application();
  const allowed = built.service.createDesign("local", {
    name: "Allowed handoff summaries",
    preset: "web",
    idempotencyKey: "handoff-list-allowed-design",
  });
  const denied = built.service.createDesign("local", {
    name: "Denied handoff summaries",
    preset: "web",
    idempotencyKey: "handoff-list-denied-design",
  });
  const inventory = built.handoffs.persistRepositoryInventory("local", repositoryInventory());
  const allowedHandoffs = Array.from({ length: 5 }, (_value, index) => built.handoffs.createHandoff("local", {
    designId: allowed.design.id,
    revisionId: allowed.revision.id,
    expectedDesignVersion: 1,
    inventoryId: inventory.id,
    specification: specification(index + 1),
  }));
  const deniedHandoffs = Array.from({ length: 3 }, (_value, index) => built.handoffs.createHandoff("local", {
    designId: denied.design.id,
    revisionId: denied.revision.id,
    expectedDesignVersion: 1,
    inventoryId: inventory.id,
    specification: specification(index + 101),
  }));
  const allowedTimes = [
    "2026-07-21T18:00:00.000Z",
    "2026-07-21T17:00:00.000Z",
    "2026-07-21T17:00:00.000Z",
    "2026-07-21T16:00:00.000Z",
    "2026-07-21T15:00:00.000Z",
  ];
  const deniedTimes = [
    "2026-07-21T21:00:00.000Z",
    "2026-07-21T20:00:00.000Z",
    "2026-07-21T19:00:00.000Z",
  ];
  for (const [index, handoff] of allowedHandoffs.entries()) {
    built.database.sqlite.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?")
      .run(allowedTimes[index], handoff.id);
  }
  for (const [index, handoff] of deniedHandoffs.entries()) {
    built.database.sqlite.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?")
      .run(deniedTimes[index], handoff.id);
  }
  return { built, allowed, denied, allowedHandoffs, deniedHandoffs };
}

function mcpToolCall(
  built: DesignerApplication,
  name: string,
  args: Record<string, unknown>,
) {
  return built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: `${name}-pagination-probe`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

describe("paginated MCP handoff summaries", () => {
  it("filters authorized projects before stable keyset pagination and invalidates changed authorization", async () => {
    const { built, allowed, denied } = await fixture();
    const actorId = createGrant(built, "handoff_list_reader", [allowed.design.id]);
    const expected = (built.database.sqlite.prepare(
      "SELECT id FROM handoffs WHERE design_id = ? ORDER BY updated_at DESC, id DESC",
    ).all(allowed.design.id) as Array<{ id: string }>).map((row) => row.id);

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = built.handoffs.listHandoffSummaries(actorId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.handoffs).toHaveLength(Math.min(2, expected.length - collected.length));
      expect(page.handoffs.every((handoff) => handoff.designId === allowed.design.id)).toBe(true);
      for (const summary of page.handoffs) {
        expect(summary).not.toHaveProperty("specification");
        expect(summary).not.toHaveProperty("versions");
        expect(summary).not.toHaveProperty("transitions");
        expect(summary).not.toHaveProperty("executionDecisions");
      }
      collected.push(...page.handoffs.map((handoff) => handoff.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);

    const unrestricted = built.handoffs.listHandoffSummaries("local", { limit: 1 });
    expect(unrestricted.nextCursor).not.toBeNull();
    expect(captureThrown(() => built.handoffs.listHandoffSummaries("local", {
      designId: allowed.design.id,
      limit: 1,
      cursor: unrestricted.nextCursor!,
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "cursor_filter_mismatch" },
    });
    expect(captureThrown(() => built.handoffs.listHandoffSummaries("local", {
      cursor: "handoff_cursor_e30",
    }))).toMatchObject({ code: "VALIDATION_FAILED" });
    const tamperedCursor = `${unrestricted.nextCursor!.slice(0, -1)}${unrestricted.nextCursor!.endsWith("A") ? "B" : "A"}`;
    expect(captureThrown(() => built.handoffs.listHandoffSummaries("local", {
      cursor: tamperedCursor,
    }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(captureThrown(() => built.handoffs.listHandoffSummaries("local", {
      limit: 1,
      includeHistory: true,
    } as never))).toMatchObject({ code: "VALIDATION_FAILED" });

    const stateCursorPage = built.handoffs.listHandoffSummaries("local", {
      designId: allowed.design.id,
      limit: 1,
    });
    const stateCursorAnchor = stateCursorPage.handoffs[0]!;
    built.database.sqlite.prepare("UPDATE handoffs SET status = 'cancelled' WHERE id = ?")
      .run(stateCursorAnchor.id);
    expect(captureThrown(() => built.handoffs.listHandoffSummaries("local", {
      designId: allowed.design.id,
      limit: 1,
      cursor: stateCursorPage.nextCursor!,
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { reason: "cursor_anchor_changed" },
    });

    const authorizedPage = built.handoffs.listHandoffSummaries(actorId, { limit: 1 });
    expect(authorizedPage.nextCursor).not.toBeNull();
    built.database.sqlite.prepare("UPDATE agent_grants SET project_ids_json = ? WHERE id = ?")
      .run(JSON.stringify([allowed.design.id, denied.design.id]), "handoff_list_reader");
    expect(captureThrown(() => built.handoffs.listHandoffSummaries(actorId, {
      limit: 1,
      cursor: authorizedPage.nextCursor!,
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { reason: "cursor_authorization_changed" },
    });
  });

  it("exposes bounded summaries through MCP, preserves detailed reads, and rejects stale cursors", async () => {
    const { built, allowed } = await fixture();
    const expected = (built.database.sqlite.prepare(
      "SELECT id FROM handoffs WHERE design_id = ? ORDER BY updated_at DESC, id DESC",
    ).all(allowed.design.id) as Array<{ id: string }>).map((row) => row.id);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await mcpToolCall(built, "handoff_list", {
        design_id: allowed.design.id,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        result: {
          isError?: boolean;
          structuredContent: {
            ok: true;
            handoffs: Array<Record<string, unknown> & { id: string }>;
            nextCursor: string | null;
          };
        };
      }>();
      expect(body.result.isError).not.toBe(true);
      expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse(body.result.structuredContent).success).toBe(true);
      for (const summary of body.result.structuredContent.handoffs) {
        expect(Object.keys(summary).sort()).toEqual([
          "acceptanceCriterionCount",
          "createdAt",
          "createdBy",
          "currentVersion",
          "designId",
          "designVersion",
          "id",
          "implementationSliceCount",
          "inventoryId",
          "resourceUri",
          "revisionId",
          "status",
          "summary",
          "title",
          "updatedAt",
          "validationChecks",
        ]);
      }
      collected.push(...body.result.structuredContent.handoffs.map((handoff) => handoff.id));
      cursor = body.result.structuredContent.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(collected).toEqual(expected);

    const detailed = await mcpToolCall(built, "handoff_read", { handoff_id: collected[0] });
    expect(detailed.json<{
      result: { structuredContent: { handoff: Record<string, unknown> } };
    }>().result.structuredContent.handoff).toMatchObject({
      id: collected[0],
      versions: expect.any(Array),
      transitions: expect.any(Array),
      executionDecisions: expect.any(Array),
    });

    const first = await mcpToolCall(built, "handoff_list", {
      design_id: allowed.design.id,
      limit: 1,
    });
    const firstPage = first.json<{
      result: { structuredContent: { handoffs: Array<{ id: string }>; nextCursor: string } };
    }>().result.structuredContent;
    const anchorId = firstPage.handoffs[0]!.id;
    built.database.sqlite.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", anchorId);
    const stale = await mcpToolCall(built, "handoff_list", {
      design_id: allowed.design.id,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(stale.json<{
      result: { isError: boolean; structuredContent: { error: { code: string; details: { reason: string } } } };
    }>().result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "VERSION_CONFLICT", details: { reason: "cursor_anchor_changed" } },
      },
    });

    const invalid = await mcpToolCall(built, "handoff_list", { cursor: "handoff_cursor_e30" });
    expect(invalid.json<{
      result: { isError: boolean; structuredContent: { error: { code: string } } };
    }>().result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "VALIDATION_FAILED" } },
    });
  });

  it("closes the summary page schema against history leakage and size drift", () => {
    const summary = {
      id: `handoff_${"a".repeat(32)}`,
      designId: "document_handoffsummary0001",
      revisionId: "revision_handoffsummary0001",
      designVersion: 1,
      inventoryId: `inventory_${"b".repeat(32)}`,
      status: "draft",
      currentVersion: 1,
      title: "Bounded handoff summary",
      summary: "The list contract intentionally excludes immutable history and decision evidence.",
      acceptanceCriterionCount: 1,
      implementationSliceCount: 1,
      validationChecks: ["typecheck"],
      createdBy: "principal_local",
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-21T08:00:00.000Z",
      resourceUri: `formaspec://handoffs/handoff_${"a".repeat(32)}`,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: [summary],
      nextCursor: null,
    }).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: [{ ...summary, transitions: [] }],
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: Array.from({ length: 101 }, () => summary),
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: [{ ...summary, title: "x".repeat(201) }],
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: [{ ...summary, summary: "x".repeat(4_001) }],
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_list.safeParse({
      ok: true,
      handoffs: [summary],
      nextCursor: "not-a-cursor",
    }).success).toBe(false);
  });
});

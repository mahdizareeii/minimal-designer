import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-design-list-pagination-"));
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

function createProjects(built: DesignerApplication, count: number) {
  return Array.from({ length: count }, (_value, index) => built.service.createDesign("local", {
    name: `Pagination project ${index + 1}`,
    preset: "web",
    idempotencyKey: `design-list-pagination-create-${index + 1}`,
  }).design);
}

function setUpdatedAt(built: DesignerApplication, designId: string, updatedAt: string): void {
  built.database.sqlite.prepare("UPDATE designs SET updated_at = ? WHERE id = ?").run(updatedAt, designId);
}

function installRestrictedGrant(built: DesignerApplication, projectIds: string[]): string {
  const id = "design_list_restricted_0001";
  const principalId = `principal_${id}`;
  const now = "2026-07-22T12:00:00.000Z";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  built.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, id, `design-list:${id}`, now);
  built.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, 'agent', ?)`,
  ).run(principalId, now);
  built.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'generic_mcp', ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    `connection_${id}`,
    principalId,
    id,
    JSON.stringify(["design:read"]),
    JSON.stringify(projectIds),
    expiresAt,
    now,
    now,
  );
  built.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    principalId,
    createHash("sha256").update(id).digest("hex"),
    JSON.stringify(["design:read"]),
    JSON.stringify(projectIds),
    now,
    expiresAt,
  );
  return `grant_${id}`;
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a DomainError.");
}

describe("design list pagination", () => {
  it("walks equal-timestamp projects exactly once through REST and MCP", async () => {
    const built = await application();
    const projects = createProjects(built, 5);
    const timestamps = [
      "2026-07-22T18:00:00.000Z",
      "2026-07-22T17:00:00.000Z",
      "2026-07-22T17:00:00.000Z",
      "2026-07-22T17:00:00.000Z",
      "2026-07-22T16:00:00.000Z",
    ];
    projects.forEach((project, index) => setUpdatedAt(built, project.id, timestamps[index]!));
    const expectedIds = projects.map((project, index) => ({ id: project.id, updatedAt: timestamps[index]! }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map(({ id }) => id);

    const firstResponse = await built.app.inject({ method: "GET", url: "/api/designs?limit=1" });
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const first = firstResponse.json<{
      designs: Array<{ id: string }>;
      nextCursor: string | null;
    }>();
    const visited = first.designs.map(({ id }) => id);
    let cursor = first.nextCursor;
    expect(cursor).toMatch(/^design_cursor_[A-Za-z0-9_-]+$/);

    while (cursor !== null) {
      const response = await built.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: `design-list-page-${visited.length + 1}`,
          method: "tools/call",
          params: { name: "design_list", arguments: { limit: 1, cursor } },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<{
        result: {
          structuredContent: {
            ok: boolean;
            designs: Array<{ id: string }>;
            nextCursor: string | null;
          };
        };
      }>().result.structuredContent;
      expect(page.ok).toBe(true);
      visited.push(...page.designs.map(({ id }) => id));
      cursor = page.nextCursor;
      expect(visited.length).toBeLessThanOrEqual(projects.length);
    }

    expect(visited).toEqual(expectedIds);
    expect(new Set(visited).size).toBe(projects.length);

    const legacy = built.service.listDesigns("local", 100, "2026-07-22T17:00:00.000Z");
    expect(legacy.designs.map(({ id }) => id)).toEqual([projects[4]!.id]);
    expect(legacy.nextCursor).toBeNull();
  });

  it("keeps project-restricted pagination filtered and binds opaque cursors to authorization", async () => {
    const built = await application();
    const projects = createProjects(built, 4);
    for (const project of projects) setUpdatedAt(built, project.id, "2026-07-22T17:00:00.000Z");
    const allowedIds = [projects[0]!.id, projects[2]!.id];
    const actorId = installRestrictedGrant(built, allowedIds);
    const expectedIds = [...allowedIds].sort((left, right) => right.localeCompare(left));
    const visited: string[] = [];
    let cursor: string | undefined;

    do {
      const page = built.service.listDesigns(actorId, 1, cursor);
      visited.push(...page.designs.map(({ id }) => id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(visited).toEqual(expectedIds);
    expect(visited).not.toContain(projects[1]!.id);
    expect(visited).not.toContain(projects[3]!.id);

    const unrestrictedCursor = built.service.listDesigns("local", 1).nextCursor;
    expect(unrestrictedCursor).not.toBeNull();
    expect(captureDomainError(
      () => built.service.listDesigns(actorId, 1, unrestrictedCursor!),
    )).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
      details: { reason: "cursor_authorization_changed" },
    });
    expect(captureDomainError(
      () => built.service.listDesigns(actorId, 1, "design_cursor_not-base64"),
    )).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
  });

  it("rejects an opaque cursor when its anchor changes or is archived", async () => {
    const built = await application();
    const projects = createProjects(built, 3);
    projects.forEach((project, index) => setUpdatedAt(
      built,
      project.id,
      `2026-07-22T1${8 - index}:00:00.000Z`,
    ));

    const originalPage = built.service.listDesigns("local", 1);
    const originalAnchor = originalPage.designs[0]!;
    expect(originalPage.nextCursor).not.toBeNull();
    setUpdatedAt(built, originalAnchor.id, "2026-07-22T19:00:00.000Z");
    expect(captureDomainError(
      () => built.service.listDesigns("local", 1, originalPage.nextCursor!),
    )).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
      details: { reason: "cursor_anchor_changed" },
    });

    setUpdatedAt(built, originalAnchor.id, originalAnchor.updatedAt);
    const archivePage = built.service.listDesigns("local", 1);
    const archiveAnchor = archivePage.designs[0]!;
    expect(archivePage.nextCursor).not.toBeNull();
    built.service.archiveDesign("local", archiveAnchor.id, {
      expectedVersion: archiveAnchor.version,
      idempotencyKey: "design-list-pagination-archive-anchor-0001",
      confirmationName: archiveAnchor.name,
    });
    expect(captureDomainError(
      () => built.service.listDesigns("local", 1, archivePage.nextCursor!),
    )).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
      details: { reason: "cursor_anchor_changed" },
    });
  });
});

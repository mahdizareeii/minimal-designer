import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FORMASPEC_FOUNDATION_SYSTEM } from "@designer/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { encodeRgbaPng } from "./render.js";
import { createComponentSourceRevisionFixture } from "../test-fixtures/component-source.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];
const PROXY_SECRET = "component-insertion-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "component-insertion-admin@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function application(label: string, mode: "local" | "server"): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-component-insertion-http-${label}-`));
  temporaryDirectories.push(root);
  const app = await buildApplication(loadConfig(mode === "local" ? {
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  } : {
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "component-insertion-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  const renderPng = encodeRgbaPng(24, 16, Buffer.alloc(24 * 16 * 4, 255));
  vi.spyOn(app.renderer, "render").mockResolvedValue({
    png: renderPng,
    width: 24,
    height: 16,
    renderer: "software",
    warnings: ["Deterministic HTTP preview test renderer."],
  });
  applications.push(app);
  await app.app.ready();
  return app;
}

function serverHeaders(identity: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function previewPayload(parentId: string) {
  return {
    baseVersion: 2,
    componentDefinitionId: FORMASPEC_FOUNDATION_SYSTEM.release.component_versions[0]!.component_definition_id,
    parent: { node_id: parentId },
    activeState: "default",
    position: { x: 28.5, y: 44.25 },
  };
}

function mcpTool(
  fixture: DesignerApplication,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return fixture.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "design.example.test",
      authorization: `Bearer ${token}`,
      "x-formaspec-proxy-secret": PROXY_SECRET,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

function mcpResource(
  fixture: DesignerApplication,
  token: string,
  uri: string,
) {
  return fixture.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "design.example.test",
      authorization: `Bearer ${token}`,
      "x-formaspec-proxy-secret": PROXY_SECRET,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    },
  });
}

describe("component insertion preview HTTP authorization", () => {
  it("creates an isolated exact preview and commits it through the ordinary commit endpoint", async () => {
    const fixture = await application("local", "local");
    const parentId = "node_component_insertion_http_parent_01";
    const source = createComponentSourceRevisionFixture(
      fixture.database,
      fixture.service,
      "local",
      [parentId],
      "component-insertion-http-local",
    );
    const historyBefore = fixture.service.history("local", source.designId);
    const libraryResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/designs/${source.designId}/component-library`,
    });
    expect(libraryResponse.statusCode, libraryResponse.body).toBe(200);
    const library = libraryResponse.json<{
      library: {
        baseVersion: number;
        releaseId: string;
        components: Array<{
          definition: { id: string; name: string };
          sourceHash: string;
          insertable: boolean;
        }>;
      };
    }>().library;
    expect(library).toMatchObject({
      baseVersion: 2,
      releaseId: FORMASPEC_FOUNDATION_SYSTEM.release.id,
    });
    expect(library.components).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definition: expect.objectContaining({ id: previewPayload(parentId).componentDefinitionId }),
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        insertable: true,
      }),
    ]));
    expect(fixture.service.history("local", source.designId)).toEqual(historyBefore);

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/designs/${source.designId}/component-insertion-previews`,
      payload: previewPayload(parentId),
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{
      previewId: string;
      rootBaseVersion: number;
      resultSnapshotHash: string;
      canCommit: boolean;
      status: string;
      renderMetadata: { sha256: string; width: number; height: number };
      component: { instanceId: string; sourceHash: string };
    }>();
    expect(body).toMatchObject({ rootBaseVersion: 2, canCommit: true, status: "ready" });
    expect(body.component.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.renderMetadata).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      width: 24,
      height: 16,
    });
    expect(fixture.service.history("local", source.designId)).toEqual(historyBefore);

    const exactRender = await fixture.app.inject({
      method: "GET",
      url: `/api/designs/${source.designId}/previews/${body.previewId}/render.png`,
    });
    expect(exactRender.statusCode, exactRender.body).toBe(200);
    expect(exactRender.headers["content-type"]).toContain("image/png");
    expect(exactRender.headers["x-formaspec-preview-render-mode"]).toBe("exact");
    expect(exactRender.headers["x-formaspec-preview-render-sha256"]).toBe(body.renderMetadata.sha256);
    expect(createHash("sha256").update(exactRender.rawPayload).digest("hex")).toBe(body.renderMetadata.sha256);

    const commit = await fixture.app.inject({
      method: "POST",
      url: `/api/designs/${source.designId}/previews/${body.previewId}/commit`,
      payload: {
        expectedBaseVersion: 2,
        idempotencyKey: "component-insertion-http-commit-0001",
        message: "Insert verified component",
      },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    expect(commit.json<{ snapshotHash: string; version: number }>() ).toMatchObject({
      snapshotHash: body.resultSnapshotHash,
      version: 3,
    });
    const head = fixture.service.getDesign("local", source.designId).canonicalDocument;
    if (head.schema_version !== 2) throw new Error("expected V2 head");
    expect(head.nodes[body.component.instanceId]?.type).toBe("component_instance");
  });

  it("enforces trusted identity and hides cross-organization project IDs", async () => {
    const fixture = await application("authorization", "server");
    const warm = await fixture.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expect(warm.statusCode, warm.body).toBe(200);
    const policy = fixture.policies.read(ADMIN_ACTOR);
    const nextPolicy = structuredClone(policy.policy);
    nextPolicy.identity.roleMappings = [{ claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" }];
    fixture.policies.update(ADMIN_ACTOR, {
      expectedConfigurationHash: policy.configurationHash,
      policy: nextPolicy,
    });
    const allowedParentId = "node_component_insertion_http_allowed_01";
    const deniedParentId = "node_component_insertion_http_denied_001";
    const allowed = createComponentSourceRevisionFixture(
      fixture.database,
      fixture.service,
      ADMIN_ACTOR,
      [allowedParentId],
      "component-insertion-http-allowed",
    );
    const denied = createComponentSourceRevisionFixture(
      fixture.database,
      fixture.service,
      ADMIN_ACTOR,
      [deniedParentId],
      "component-insertion-http-denied",
    );
    const now = new Date().toISOString();
    fixture.database.sqlite.prepare(
      "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES ('organization_component_insertion_foreign', 'Foreign', '{}', ?, ?)",
    ).run(now, now);
    fixture.database.sqlite.prepare(
      "UPDATE designs SET organization_id = 'organization_component_insertion_foreign' WHERE id = ?",
    ).run(denied.designId);

    const allowedLibraryResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/designs/${allowed.designId}/component-library`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expect(allowedLibraryResponse.statusCode, allowedLibraryResponse.body).toBe(200);

    const restrictedLibraryResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/designs/${denied.designId}/component-library`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expect(restrictedLibraryResponse.statusCode, restrictedLibraryResponse.body).toBe(404);
    expect(restrictedLibraryResponse.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");

    const allowedResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/designs/${allowed.designId}/component-insertion-previews`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: previewPayload(allowedParentId),
    });
    expect(allowedResponse.statusCode, allowedResponse.body).toBe(201);

    const restrictedResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/designs/${denied.designId}/component-insertion-previews`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: previewPayload(deniedParentId),
    });
    expect(restrictedResponse.statusCode, restrictedResponse.body).toBe(404);
    expect(restrictedResponse.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");

    const missingIdentityResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/designs/${allowed.designId}/component-insertion-previews`,
      remoteAddress: "127.0.0.1",
      headers: {
        host: "design.example.test",
        origin: PUBLIC_ORIGIN,
        "x-formaspec-csrf": "1",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
      payload: previewPayload(allowedParentId),
    });
    expect(missingIdentityResponse.statusCode, missingIdentityResponse.body).toBe(401);
    expect(missingIdentityResponse.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
  });

  it("enforces MCP scopes, project grants, and revocation for the dedicated insertion tool", async () => {
    const fixture = await application("mcp-authorization", "server");
    const warm = await fixture.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expect(warm.statusCode, warm.body).toBe(200);
    const policy = fixture.policies.read(ADMIN_ACTOR);
    const nextPolicy = structuredClone(policy.policy);
    nextPolicy.identity.roleMappings = [{ claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" }];
    fixture.policies.update(ADMIN_ACTOR, {
      expectedConfigurationHash: policy.configurationHash,
      policy: nextPolicy,
    });
    const allowedParentId = "node_component_insertion_mcp_allowed_01";
    const deniedParentId = "node_component_insertion_mcp_denied_001";
    const allowed = createComponentSourceRevisionFixture(
      fixture.database,
      fixture.service,
      ADMIN_ACTOR,
      [allowedParentId],
      "component-insertion-mcp-allowed",
    );
    const denied = createComponentSourceRevisionFixture(
      fixture.database,
      fixture.service,
      ADMIN_ACTOR,
      [deniedParentId],
      "component-insertion-mcp-denied",
    );
    const allowedChallenge = fixture.enterprise.createAgentConnection(ADMIN_ACTOR, {
      adapter: "codex",
      displayName: "Component insertion MCP allowed",
      scopes: [
        "design:preview",
        "design:read",
        "design:write",
        "design_system:read",
        "task:read",
        "task:claim",
        "task:update",
      ],
      projectIds: [allowed.designId],
      expiresInSeconds: 3_600,
    });
    const missingScopeChallenge = fixture.enterprise.createAgentConnection(ADMIN_ACTOR, {
      adapter: "codex",
      displayName: "Component insertion MCP missing scope",
      scopes: ["design:preview", "design:read", "task:read", "task:claim", "task:update"],
      projectIds: [allowed.designId],
      expiresInSeconds: 3_600,
    });
    const allowedGrant = fixture.enterprise.pairAgentConnection(allowedChallenge.nonce).grant;
    const missingScopeGrant = fixture.enterprise.pairAgentConnection(missingScopeChallenge.nonce).grant;
    const task = fixture.enterprise.createAgentTask(ADMIN_ACTOR, {
      designId: allowed.designId,
      brief: "Insert a pinned component as an exact proposal",
      selection: [allowedParentId],
      baseVersion: 2,
      expectedOutput: "design_preview",
      idempotencyKey: "component-insertion-mcp-task-0001",
      expiresInSeconds: 3_600,
    });
    fixture.enterprise.claimAgentTask(allowedGrant.actorId, task.id);
    fixture.enterprise.transitionAgentTask(allowedGrant.actorId, task.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    const renderedPng = encodeRgbaPng(160, 44, Buffer.alloc(160 * 44 * 4, 255));
    vi.spyOn(fixture.renderer, "render").mockResolvedValue({
      png: renderedPng,
      width: 160,
      height: 44,
      renderer: "playwright",
      warnings: [],
    });
    const args = {
      design_id: allowed.designId,
      task_id: task.id,
      base_version: 2,
      component_definition_id: FORMASPEC_FOUNDATION_SYSTEM.release.component_versions[0]!.component_definition_id,
      parent: { node_id: allowedParentId },
      position: { x: 20, y: 30 },
      max_size: 512,
    };
    const allowedResponse = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_system_component_insert_preview",
      args,
    );
    expect(allowedResponse.statusCode, allowedResponse.body).toBe(200);
    const allowedBody = allowedResponse.json<{
      result: {
        structuredContent: {
          ok: boolean;
          preview: { id: string; canCommit: boolean };
          component: { instanceId: string };
          render: {
            options: { nodeId: string; maxSize: number };
            width: number;
            height: number;
            renderer: "playwright" | "software";
            warnings: string[];
            sha256: string;
            resourceUri: string;
          };
        };
      };
    }>();
    expect(allowedBody.result, allowedResponse.body).toBeDefined();
    expect(allowedBody.result.structuredContent, allowedResponse.body).toBeDefined();
    expect(allowedBody.result.structuredContent, allowedResponse.body).toMatchObject({
      ok: true,
      preview: { canCommit: true },
      component: { instanceId: expect.stringMatching(/^node_/) },
    });
    const allowedContent = allowedBody.result.structuredContent;
    const renderedSha256 = createHash("sha256").update(renderedPng).digest("hex");
    expect(allowedContent.render).toEqual({
      options: { nodeId: allowedContent.component.instanceId, maxSize: 512 },
      width: 160,
      height: 44,
      renderer: "playwright",
      warnings: [],
      sha256: renderedSha256,
      resourceUri: `formaspec://designs/${allowed.designId}/previews/${allowedContent.preview.id}/render.png`,
    });
    const persistedRender = fixture.database.sqlite.prepare(
      "SELECT render_metadata_json FROM previews WHERE id = ?",
    ).get(allowedContent.preview.id) as { render_metadata_json: string | null };
    expect(persistedRender.render_metadata_json).not.toBeNull();
    expect(JSON.parse(persistedRender.render_metadata_json!)).toEqual({
      options: allowedContent.render.options,
      width: allowedContent.render.width,
      height: allowedContent.render.height,
      renderer: allowedContent.render.renderer,
      warnings: allowedContent.render.warnings,
      sha256: allowedContent.render.sha256,
    });

    const resourceResponse = await mcpResource(fixture, allowedGrant.token, allowedContent.render.resourceUri);
    expect(resourceResponse.statusCode, resourceResponse.body).toBe(200);
    const resourceBody = resourceResponse.json<{
      result: { contents: Array<{ mimeType?: string; blob?: string }> };
    }>();
    const resourceImage = resourceBody.result.contents[0];
    expect(resourceImage?.mimeType).toBe("image/png");
    expect(createHash("sha256").update(Buffer.from(resourceImage!.blob!, "base64")).digest("hex"))
      .toBe(allowedContent.render.sha256);

    const historyBeforeMissingEvidenceCommit = fixture.service.history(ADMIN_ACTOR, allowed.designId);
    const versionBeforeMissingEvidenceCommit = fixture.service.getDesign(ADMIN_ACTOR, allowed.designId).revision.version;
    const missingEvidencePreview = fixture.componentInsertions.preview(allowedGrant.actorId, allowed.designId, {
      baseVersion: 2,
      taskId: task.id,
      componentDefinitionId: args.component_definition_id,
      parent: { node_id: allowedParentId },
      position: { x: 40, y: 50 },
    }).preview;
    expect(missingEvidencePreview.renderMetadata).toBeNull();
    const missingEvidenceCommit = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_commit_preview",
      {
        design_id: allowed.designId,
        preview_id: missingEvidencePreview.id,
        expected_base_version: 2,
        idempotency_key: "component-insertion-missing-render-commit-0001",
        message: "Reject preview without exact render evidence",
      },
    );
    expect(missingEvidenceCommit.statusCode, missingEvidenceCommit.body).toBe(200);
    expect(missingEvidenceCommit.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(fixture.service.getDesign(ADMIN_ACTOR, allowed.designId).revision.version)
      .toBe(versionBeforeMissingEvidenceCommit);
    expect(fixture.service.history(ADMIN_ACTOR, allowed.designId)).toEqual(historyBeforeMissingEvidenceCommit);

    const deniedResponse = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_system_component_insert_preview",
      { ...args, design_id: denied.designId, parent: { node_id: deniedParentId } },
    );
    expect(deniedResponse.statusCode, deniedResponse.body).toBe(200);
    expect(deniedResponse.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const commitArguments = {
      design_id: allowed.designId,
      preview_id: allowedContent.preview.id,
      expected_base_version: 2,
      idempotency_key: "component-insertion-exact-render-commit-0001",
      message: "Commit exact component insertion preview",
    };
    const committedResponse = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_commit_preview",
      commitArguments,
    );
    expect(committedResponse.statusCode, committedResponse.body).toBe(200);
    const committedContent = committedResponse.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent;
    expect(committedContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(fixture.service.getDesign(ADMIN_ACTOR, allowed.designId).revision.version).toBe(2);

    fixture.service.versions.renderer = `${fixture.service.versions.renderer}-upgraded`;
    const retriedCommitResponse = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_commit_preview",
      commitArguments,
    );
    expect(retriedCommitResponse.statusCode, retriedCommitResponse.body).toBe(200);
    expect(retriedCommitResponse.json<{
      result: { structuredContent: typeof committedContent };
    }>().result.structuredContent).toEqual(committedContent);

    fixture.enterprise.transitionAgentTask(allowedGrant.actorId, task.id, {
      expectedStatus: "in_progress",
      toStatus: "failed",
      message: "Finish authorization checks without committing",
    });
    const missingScopeTask = fixture.enterprise.createAgentTask(ADMIN_ACTOR, {
      designId: allowed.designId,
      brief: "Prove component-library scope is still required",
      selection: [allowedParentId],
      baseVersion: 2,
      expectedOutput: "design_preview",
      idempotencyKey: "component-insertion-missing-scope-task-0001",
      expiresInSeconds: 3_600,
    });
    fixture.enterprise.claimAgentTask(missingScopeGrant.actorId, missingScopeTask.id);
    fixture.enterprise.transitionAgentTask(missingScopeGrant.actorId, missingScopeTask.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    const missingScopeResponse = await mcpTool(
      fixture,
      missingScopeGrant.token,
      "design_system_component_insert_preview",
      { ...args, task_id: missingScopeTask.id },
    );
    expect(missingScopeResponse.statusCode, missingScopeResponse.body).toBe(200);
    expect(missingScopeResponse.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    fixture.enterprise.revokeAgentConnection(ADMIN_ACTOR, allowedChallenge.connection.id);
    const revokedResponse = await mcpTool(
      fixture,
      allowedGrant.token,
      "design_system_component_insert_preview",
      args,
    );
    expect(revokedResponse.statusCode, revokedResponse.body).toBe(401);
    expect(revokedResponse.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
  });
});

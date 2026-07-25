import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import {
  DesignerDatabase,
  applyDatabaseMigrationPrefixForTesting,
} from "./db/database.js";
import { DesignSystemService } from "./design-system-service.js";
import { DomainError } from "./errors.js";
import { EnterpriseService } from "./enterprise-service.js";
import { EventHub } from "./events.js";
import { ProductService } from "./product-service.js";
import { registerProductHttpRoutes } from "./product-http-routes.js";
import { DesignerService } from "./service.js";

const applications: DesignerApplication[] = [];
const databases: DesignerDatabase[] = [];
const httpApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(httpApps.splice(0).map((app) => app.close()));
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

async function waitForClockAdvance(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function serviceFixture() {
  const database = new DesignerDatabase(":memory:");
  databases.push(database);
  const events = new EventHub();
  const designer = new DesignerService(database, events, 900);
  const enterprise = new EnterpriseService(database, events, { designerService: designer });
  let productNow: Date | null = null;
  const products = new ProductService(database, () => productNow === null ? new Date() : new Date(productNow));
  return {
    database,
    events,
    designer,
    enterprise,
    products,
    setProductTime(value: string | null) {
      productNow = value === null ? null : new Date(value);
    },
  };
}

async function productHttpApp(products: ProductService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  httpApps.push(app);
  app.decorateRequest("actorId", "local");
  app.addHook("onRequest", async (request) => {
    const actorId = request.headers["x-test-actor-id"];
    if (typeof actorId === "string") request.actorId = actorId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.toJSON() });
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "The request did not match the expected schema.",
          retryable: false,
          details: { issues: error.issues },
        },
      });
    }
    throw error;
  });
  registerProductHttpRoutes(app, products);
  await app.ready();
  return app;
}

async function localApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-product-mcp-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    FORMASPEC_WEB_BASE_URL: "http://127.0.0.1:4311",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function productIdForDesign(database: DesignerDatabase, designId: string): string {
  const row = database.sqlite.prepare("SELECT product_id FROM designs WHERE id = ?").get(designId) as {
    product_id: string;
  } | undefined;
  if (!row) throw new Error(`Design ${designId} has no Product fixture.`);
  return row.product_id;
}

describe("Product organization service and HTTP authorization", () => {
  it("covers Product CRUD, every route, role guards, and exact move preview/commit semantics", async () => {
    const fixture = serviceFixture();
    const sourceDesign = fixture.designer.createDesign("local", {
      name: "Checkout application",
      preset: "web",
      idempotencyKey: "product-http-source-design-0001",
    });
    const secondDesign = fixture.designer.createDesign("local", {
      name: "Operations application",
      preset: "tablet",
      idempotencyKey: "product-http-second-design-0001",
    });
    const sourceProductId = productIdForDesign(fixture.database, sourceDesign.document.id);
    const secondProductId = productIdForDesign(fixture.database, secondDesign.document.id);
    const app = await productHttpApp(fixture.products);

    const listed = await app.inject({ method: "GET", url: "/api/products?limit=100" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ products: Array<{ id: string }> }>().products.map((product) => product.id))
      .toEqual(expect.arrayContaining([sourceProductId, secondProductId]));

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: {
        name: "Company storefront",
        description: "The canonical customer-facing commerce Product.",
        defaultLocale: "fa-IR",
        defaultDirection: "rtl",
        locales: ["fa-IR", "en"],
        metadata: { ownerTeam: "Commerce" },
        idempotencyKey: "product-http-create-0001",
      },
    });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = createdResponse.json<{
      product: { id: string; name: string; updatedAt: string; designCount: number };
    }>();
    expect(created.product).toMatchObject({ name: "Company storefront", designCount: 0 });

    const replay = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: {
        name: "Company storefront",
        description: "The canonical customer-facing commerce Product.",
        defaultLocale: "fa-IR",
        defaultDirection: "rtl",
        locales: ["fa-IR", "en"],
        metadata: { ownerTeam: "Commerce" },
        idempotencyKey: "product-http-create-0001",
      },
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(createdResponse.json());

    const read = await app.inject({ method: "GET", url: `/api/products/${created.product.id}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ product: { id: created.product.id }, designs: [] });

    await waitForClockAdvance();
    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/products/${created.product.id}`,
      payload: {
        expectedUpdatedAt: created.product.updatedAt,
        name: "Company commerce",
        idempotencyKey: "product-http-update-0001",
      },
    });
    expect(updatedResponse.statusCode, updatedResponse.body).toBe(200);
    const updated = updatedResponse.json<{ product: { name: string; updatedAt: string } }>();
    expect(updated.product.name).toBe("Company commerce");

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/products/${created.product.id}`,
      payload: {
        expectedUpdatedAt: created.product.updatedAt,
        description: "Stale update",
        idempotencyKey: "product-http-update-stale-0001",
      },
    });
    expect(staleUpdate.statusCode, staleUpdate.body).toBe(409);
    expect(staleUpdate.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });

    const sourceBefore = fixture.products.readProduct("local", sourceProductId);
    const movePreviewResponse = await app.inject({
      method: "POST",
      url: `/api/products/${created.product.id}/design-move-previews`,
      payload: {
        designId: sourceDesign.document.id,
        expectedSourceProductId: sourceProductId,
        expectedDesignVersion: 1,
        idempotencyKey: "product-http-move-preview-0001",
      },
    });
    expect(movePreviewResponse.statusCode, movePreviewResponse.body).toBe(201);
    const movePreview = movePreviewResponse.json<{ preview: { id: string; status: string } }>().preview;
    expect(movePreview.status).toBe("ready");
    expect(productIdForDesign(fixture.database, sourceDesign.document.id)).toBe(sourceProductId);

    const previewRead = await app.inject({
      method: "GET",
      url: `/api/product-move-previews/${movePreview.id}`,
    });
    expect(previewRead.statusCode, previewRead.body).toBe(200);
    expect(previewRead.json()).toMatchObject({ preview: { id: movePreview.id, status: "ready" } });

    const revisionBytesBefore = fixture.database.sqlite.prepare(
      "SELECT document_json, revision_hash FROM revisions WHERE design_id = ? ORDER BY version",
    ).all(sourceDesign.document.id);
    const committedResponse = await app.inject({
      method: "POST",
      url: `/api/product-move-previews/${movePreview.id}/commit`,
      payload: { idempotencyKey: "product-http-move-commit-0001" },
    });
    expect(committedResponse.statusCode, committedResponse.body).toBe(200);
    expect(committedResponse.json()).toMatchObject({
      preview: { id: movePreview.id, status: "committed" },
      product: { product: { id: created.product.id }, designs: [expect.objectContaining({ id: sourceDesign.document.id })] },
    });
    expect(productIdForDesign(fixture.database, sourceDesign.document.id)).toBe(created.product.id);
    expect(fixture.database.sqlite.prepare(
      "SELECT document_json, revision_hash FROM revisions WHERE design_id = ? ORDER BY version",
    ).all(sourceDesign.document.id)).toEqual(revisionBytesBefore);
    expect(fixture.designer.getDesign("local", sourceDesign.document.id).revision.version).toBe(1);

    const commitReplay = await app.inject({
      method: "POST",
      url: `/api/product-move-previews/${movePreview.id}/commit`,
      payload: { idempotencyKey: "product-http-move-commit-0001" },
    });
    expect(commitReplay.statusCode, commitReplay.body).toBe(200);
    expect(commitReplay.json()).toEqual(committedResponse.json());

    await waitForClockAdvance();
    const sourceAfterMove = fixture.products.readProduct("local", sourceProductId);
    const archiveSource = await app.inject({
      method: "POST",
      url: `/api/products/${sourceProductId}/archive`,
      payload: {
        expectedUpdatedAt: sourceAfterMove.product.updatedAt,
        confirmationName: sourceAfterMove.product.name,
        idempotencyKey: "product-http-archive-source-0001",
      },
    });
    expect(archiveSource.statusCode, archiveSource.body).toBe(200);
    expect(archiveSource.json()).toMatchObject({ product: { id: sourceProductId, status: "archived" } });

    const activeArchive = await app.inject({
      method: "POST",
      url: `/api/products/${secondProductId}/archive`,
      payload: {
        expectedUpdatedAt: fixture.products.readProduct("local", secondProductId).product.updatedAt,
        confirmationName: "Operations application",
        idempotencyKey: "product-http-archive-active-0001",
      },
    });
    expect(activeArchive.statusCode, activeArchive.body).toBe(409);
    expect(activeArchive.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });

    const viewer = resolveAccess(fixture.database.sqlite, "product-http-viewer");
    fixture.database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);
    const viewerList = await app.inject({
      method: "GET",
      url: "/api/products",
      headers: { "x-test-actor-id": "product-http-viewer" },
    });
    expect(viewerList.statusCode, viewerList.body).toBe(200);
    const viewerWrite = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: { "x-test-actor-id": "product-http-viewer" },
      payload: { name: "Denied Product", idempotencyKey: "product-http-viewer-denied-0001" },
    });
    expect(viewerWrite.statusCode, viewerWrite.body).toBe(403);
    expect(viewerWrite.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const challenge = fixture.enterprise.createAgentConnection("local", {
      adapter: "generic_mcp",
      displayName: "Product project restriction",
      scopes: ["design:read"],
      projectIds: [secondDesign.document.id],
      expiresInSeconds: 3_600,
    });
    const paired = fixture.enterprise.pairAgentConnection(challenge.nonce);
    expect(fixture.products.listProducts(paired.grant.actorId).products.map((product) => product.id))
      .toEqual([secondProductId]);
    expect(captureThrown(() => fixture.products.readProduct(paired.grant.actorId, created.product.id)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(sourceBefore.product.id).toBe(sourceProductId);
  });

  it("persists move previews, expires/stales them safely, and commits exactly once", async () => {
    const fixture = serviceFixture();
    fixture.setProductTime("2026-07-20T00:00:00.000Z");
    const first = fixture.designer.createDesign("local", {
      name: "Move persistence source",
      preset: "web",
      idempotencyKey: "product-move-persistence-source-0001",
    });
    const second = fixture.designer.createDesign("local", {
      name: "Move stale source",
      preset: "phone",
      idempotencyKey: "product-move-stale-source-0001",
    });
    const target = fixture.products.createProduct("local", {
      name: "Move target",
      idempotencyKey: "product-move-target-create-0001",
    });
    const firstSourceId = productIdForDesign(fixture.database, first.document.id);
    const secondSourceId = productIdForDesign(fixture.database, second.document.id);

    const persisted = fixture.products.previewDesignMove("local", target.product.id, first.document.id, {
      expectedSourceProductId: firstSourceId,
      expectedDesignVersion: 1,
      idempotencyKey: "product-move-persist-preview-0001",
    });
    expect(new ProductService(
      fixture.database,
      () => new Date("2026-07-20T00:00:30.000Z"),
    ).readDesignMovePreview("local", persisted.id)).toEqual(persisted);

    const expired = fixture.products.previewDesignMove("local", target.product.id, second.document.id, {
      expectedSourceProductId: secondSourceId,
      expectedDesignVersion: 1,
      idempotencyKey: "product-move-expired-preview-0001",
    });
    fixture.setProductTime("2026-07-20T00:16:00.000Z");
    expect(captureThrown(() => fixture.products.commitDesignMovePreview("local", expired.id, {
      idempotencyKey: "product-move-expired-commit-0001",
    }))).toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
    expect(fixture.products.readDesignMovePreview("local", expired.id).status).toBe("expired");
    fixture.setProductTime("2026-07-20T00:05:00.000Z");

    const stale = fixture.products.previewDesignMove("local", target.product.id, second.document.id, {
      expectedSourceProductId: secondSourceId,
      expectedDesignVersion: 1,
      idempotencyKey: "product-move-stale-preview-0001",
    });
    fixture.designer.applyRevision("local", second.document.id, {
      baseVersion: 1,
      operations: [{ type: "set_metadata", target: { kind: "document" }, metadata: { changed: true } }],
      idempotencyKey: "product-move-stale-revision-0001",
    });
    expect(captureThrown(() => fixture.products.commitDesignMovePreview("local", stale.id, {
      idempotencyKey: "product-move-stale-commit-0001",
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(productIdForDesign(fixture.database, second.document.id)).toBe(secondSourceId);
    expect(fixture.products.readDesignMovePreview("local", stale.id).status).toBe("ready");

    const committed = fixture.products.commitDesignMovePreview("local", persisted.id, {
      idempotencyKey: "product-move-persist-commit-0001",
    });
    expect(committed.preview.status).toBe("committed");
    expect(fixture.products.commitDesignMovePreview("local", persisted.id, {
      idempotencyKey: "product-move-persist-commit-0001",
    })).toEqual(committed);
    expect(captureThrown(() => fixture.products.commitDesignMovePreview("local", persisted.id, {
      idempotencyKey: "product-move-second-commit-0001",
    }))).toMatchObject({ code: "PREVIEW_ALREADY_COMMITTED", statusCode: 409 });
  });

  it("paginates equal timestamps without duplicates and binds cursors to the exact authorization", () => {
    const fixture = serviceFixture();
    fixture.setProductTime("2026-07-20T08:00:00.000Z");
    for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      fixture.products.createProduct("local", {
        name,
        idempotencyKey: `product-pagination-create-${index}-0001`,
      });
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = fixture.products.listProducts("local", { limit: 1, ...(cursor ? { cursor } : {}) });
      ids.push(...page.products.map((product) => product.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    const first = fixture.products.listProducts("local", { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const viewer = resolveAccess(fixture.database.sqlite, "product-pagination-viewer");
    fixture.database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);
    expect(captureThrown(() => fixture.products.listProducts("product-pagination-viewer", {
      limit: 1,
      cursor: first.nextCursor!,
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(captureThrown(() => fixture.products.listProducts("local", {
      limit: 1,
      cursor: `${first.nextCursor!.slice(0, -1)}x`,
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
  });
});

describe("Product-bound immutable agent context", () => {
  it("freezes Product, specification, system release, locale, platform, and repository evidence", async () => {
    const fixture = serviceFixture();
    const design = fixture.designer.createDesign("local", {
      name: "Frozen task context",
      preset: "web",
      idempotencyKey: "product-frozen-context-design-0001",
    });
    const productId = productIdForDesign(fixture.database, design.document.id);
    const systems = new DesignSystemService(fixture.database, { designerService: fixture.designer });
    const system = systems.createDesignSystem("local", { name: "Frozen task system" });
    const release1 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Release 1",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const release2 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 1,
      name: "Release 2",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const specification1Preview = fixture.enterprise.previewProductSpecification("local", {
      designId: design.document.id,
      baseVersion: 0,
      naturalLanguageBrief: "Version one product rules.",
    });
    const specification1 = fixture.enterprise.commitProductSpecificationPreview("local", {
      designId: design.document.id,
      previewId: specification1Preview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "product-frozen-specification-1-0001",
    });

    const beforeUpdate = fixture.products.readProduct("local", productId);
    await waitForClockAdvance();
    fixture.products.updateProduct("local", productId, {
      expectedUpdatedAt: beforeUpdate.product.updatedAt,
      name: "Frozen Product v1",
      defaultDesignSystemReleaseId: release1.id,
      defaultLocale: "fa-IR",
      defaultDirection: "rtl",
      locales: ["fa-IR", "en"],
      idempotencyKey: "product-frozen-update-1-0001",
    });
    const task = fixture.enterprise.createAgentTask("local", {
      designId: design.document.id,
      brief: "Design a checkout screen using the frozen context.",
      baseVersion: 1,
      expectedOutput: "design_preview",
      locale: "fa-IR",
      platform: "web",
      idempotencyKey: "product-frozen-task-0001",
    });
    const frozen = structuredClone(task.resolvedContext);
    expect(frozen).toMatchObject({
      product: { id: productId, name: "Frozen Product v1" },
      productSpecification: {
        version: 1,
        specificationHash: specification1.specificationHash,
      },
      designSystem: { source: "product_default", releaseId: release1.id, releaseVersion: 1 },
      locale: "fa-IR",
      direction: "rtl",
      platform: "web",
    });

    const specification2Preview = fixture.enterprise.previewProductSpecification("local", {
      designId: design.document.id,
      baseVersion: 1,
      naturalLanguageBrief: "Version two changes the business rules.",
    });
    fixture.enterprise.commitProductSpecificationPreview("local", {
      designId: design.document.id,
      previewId: specification2Preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "product-frozen-specification-2-0001",
    });
    const currentProduct = fixture.products.readProduct("local", productId);
    await waitForClockAdvance();
    fixture.products.updateProduct("local", productId, {
      expectedUpdatedAt: currentProduct.product.updatedAt,
      name: "Live Product v2",
      defaultDesignSystemReleaseId: release2.id,
      defaultLocale: "en",
      defaultDirection: "ltr",
      locales: ["en", "fa-IR"],
      idempotencyKey: "product-frozen-update-2-0001",
    });

    const reread = fixture.enterprise.readAgentTask("local", task.id);
    expect(reread.product).toMatchObject({ id: productId, name: "Live Product v2" });
    expect(reread.resolvedContext).toEqual(frozen);
  });

  it("keeps pre-migration tasks readable with null resolved context", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-product-legacy-task-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "designer.sqlite");
    const legacy = new Database(filename);
    legacy.pragma("foreign_keys = ON");
    applyDatabaseMigrationPrefixForTesting(legacy, 16);
    const now = "2026-07-20T00:00:00.000Z";
    const designId = "document_legacyproducttask0001";
    const unconstrainedLegacyDesignId = "legacy-design-without-document-prefix";
    const revisionId = "revision_legacyproducttask0001";
    const taskId = "task_legacyproducttask0001";
    legacy.prepare(
      `INSERT INTO designs
       (id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
       VALUES (?, 'local', 'Legacy Product task', 1, ?, ?, ?, 'organization_legacy')`,
    ).run(designId, revisionId, now, now);
    legacy.prepare(
      `INSERT INTO designs
       (id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
       VALUES (?, 'local', 'Unconstrained legacy design', 1, 'revision_unconstrainedlegacy0001', ?, ?, 'organization_legacy')`,
    ).run(unconstrainedLegacyDesignId, now, now);
    legacy.prepare(
      `INSERT INTO agent_tasks
       (id, organization_id, design_id, actor_id, brief, selection_json, base_version,
        expected_output, created_at, expires_at)
       VALUES (?, 'organization_legacy', ?, 'principal_local', 'Legacy task', '[]', 1,
               'product_spec_preview', ?, '2099-07-20T00:00:00.000Z')`,
    ).run(taskId, designId, now);
    legacy.prepare(
      `INSERT INTO agent_task_transitions
       (id, task_id, from_status, to_status, actor_id, message, data_json, created_at)
       VALUES ('transition_legacyproducttask0001', ?, NULL, 'queued', 'principal_local', 'Task created', '{}', ?)`,
    ).run(taskId, now);
    legacy.close();

    const migrated = new DesignerDatabase(filename);
    databases.push(migrated);
    expect(migrated.schemaVersion()).toBe(17);
    const productId = `product_${designId.slice("document_".length)}`;
    expect(migrated.sqlite.prepare("SELECT product_id FROM designs WHERE id = ?").get(designId))
      .toEqual({ product_id: productId });
    const hashedProductId = `product_${createHash("sha256").update(unconstrainedLegacyDesignId).digest("hex").slice(0, 32)}`;
    expect(migrated.sqlite.prepare("SELECT product_id FROM designs WHERE id = ?").get(unconstrainedLegacyDesignId))
      .toEqual({ product_id: hashedProductId });
    const task = new EnterpriseService(migrated, new EventHub()).readAgentTask("local", taskId);
    expect(task.product).toMatchObject({ id: productId, name: "Legacy Product task", status: "active" });
    expect(task.resolvedContext).toBeNull();
  });
});

describe("Product MCP filtering and resource boundary", () => {
  it("lists and reads only Products visible to a project-restricted grant", async () => {
    const application = await localApplication("restricted");
    const allowed = application.service.createDesign("local", {
      name: "Allowed MCP Product",
      preset: "phone",
      idempotencyKey: "product-mcp-allowed-design-0001",
    });
    const denied = application.service.createDesign("local", {
      name: "Denied MCP Product",
      preset: "web",
      idempotencyKey: "product-mcp-denied-design-0001",
    });
    const allowedProductId = productIdForDesign(application.database, allowed.document.id);
    const deniedProductId = productIdForDesign(application.database, denied.document.id);
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "generic_mcp",
      displayName: "Product MCP restriction",
      scopes: ["design:read"],
      projectIds: [allowed.document.id],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const request = (payload: Record<string, unknown>) => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        authorization: `Bearer ${paired.grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload,
    });

    const listed = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "product_list", arguments: { limit: 100 } },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{
      result: { structuredContent: { ok: true; products: Array<{ id: string }>; nextCursor: null } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      products: [{ id: allowedProductId }],
      nextCursor: null,
    });
    expect(listed.body).not.toContain(deniedProductId);
    expect(listed.body).not.toContain("Denied MCP Product");

    const resource = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: `formaspec://products/${allowedProductId}` },
    });
    expect(resource.statusCode, resource.body).toBe(200);
    expect(resource.body).toContain(allowedProductId);
    expect(resource.body).not.toContain(deniedProductId);

    const deniedRead = await request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "product_read", arguments: { product_id: deniedProductId } },
    });
    expect(deniedRead.json<{
      result: { structuredContent: { ok: false; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

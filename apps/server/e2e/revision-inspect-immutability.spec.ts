import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  ProductSpecificationSchema,
  createComponentNode,
  createInstanceNode,
  createTextNode,
  createTokenId,
  type DesignAsset,
  type DesignDocument,
  type DesignOperation,
} from "@designer/core";
import { expect, test } from "playwright/test";

import { buildApplication, type DesignerApplication } from "../src/app.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { canonicalJson, hashPayload } from "../src/ids.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

interface RevisionEnvelope {
  version: number;
  revisionId: string;
  schemaVersion: number;
  document: DesignDocument;
}

interface InspectEnvelope {
  project: { version: number; revisionId: string };
  head: { version: number; revisionId: string };
  revision: { version: number; id: string };
  integrity: { revisionId: string; revisionHash: string; snapshotHash: string; operationHash: string };
  document: { schema_version: number; revision: number };
  nodes: Array<{ id: string; name: string; jsonPath: string; resolvedValues: unknown }>;
  evidence: {
    tokens: Array<{ id: string; resolvedValue: unknown }>;
    assets: Array<{ id: string; sha256: string | null }>;
    components: Array<{ id: string; name: string }>;
    businessRules: Array<{ id: string; title: string }>;
    acceptanceCriteria: Array<{ id: string; title: string }>;
    implementationMappings: Array<{ id: string; symbol: string }>;
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function localConfig(port: number, dataDir: string, backupDir: string): ServerConfig {
  const baseURL = `http://127.0.0.1:${port}`;
  return loadConfig({
    ...process.env,
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_BASE_URL: baseURL,
    DATA_DIR: dataDir,
    BACKUP_DIR: backupDir,
    DESIGNER_DATABASE_PATH: path.join(dataDir, "designer.sqlite"),
    AUTH_MODE: "none",
    DESIGNER_TOKEN: "",
    DESIGNER_AUTH_TOKEN: "",
    DESIGNER_AUTH_REQUIRED: "false",
    DESIGNER_CORS_ORIGINS: baseURL,
    DESIGNER_LOG_LEVEL: "silent",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
    FORMASPEC_RENDER_SOCKET: "",
    FORMASPEC_CONTAINER_LOCAL: "false",
  });
}

async function api<T>(baseURL: string, route: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseURL}${route}`, {
    method: options.method ?? "GET",
    headers: {
      "x-formaspec-csrf": "1",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${route} failed (${response.status}): ${body}`);
  return JSON.parse(body) as T;
}

function exactSpecification(input: {
  version: number;
  ruleId: string;
  ruleTitle: string;
  criterionId: string;
  criterionTitle: string;
  nodeId: string;
  componentId: string;
}) {
  return ProductSpecificationSchema.parse({
    id: "spec_revisioninspect0001",
    version: input.version,
    natural_language_brief: "Checkout requires an explicit, inspectable confirmation step.",
    summary: "Revision-pinned checkout behavior",
    business_rules: [{
      id: input.ruleId,
      title: input.ruleTitle,
      description: "A sensitive payment cannot complete without confirmation.",
      links: { node_ids: [input.nodeId], component_definition_ids: [input.componentId] },
      conditions: [],
      outcomes: ["Show the exact confirmation state"],
      priority: "critical",
    }],
    acceptance_criteria: [{
      id: input.criterionId,
      title: input.criterionTitle,
      description: "The amount remains visible before confirmation.",
      links: { node_ids: [input.nodeId], component_definition_ids: [input.componentId] },
      given: ["The cart contains an order"],
      when: ["The customer presses Pay now"],
      then: ["The confirmation state shows the exact amount"],
    }],
  });
}

test("revision inspect remains pinned after the head changes and exposes exact engineering evidence", async ({ page }) => {
  test.setTimeout(180_000);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-inspect-e2e-"));
  const config = localConfig(
    await reserveLoopbackPort(),
    path.join(temporaryRoot, "data"),
    path.join(temporaryRoot, "backups"),
  );
  const baseURL = config.publicBaseUrl;
  let application: DesignerApplication | null = null;

  try {
    application = await buildApplication(config);
    await application.app.listen({ host: config.host, port: config.port });

    const created = await api<RevisionEnvelope>(baseURL, "/api/designs", {
      method: "POST",
      body: { name: "Immutable checkout inspect", preset: "phone", idempotencyKey: "inspect-create-0001" },
    });
    const designId = created.document.id;
    const rootFrameId = created.document.pages[0]!.children[0]!;
    const tokenId = createTokenId();
    const asset = application.service.saveAsset("local", {
      designId,
      filename: "checkout-dot.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: onePixelPng,
    });
    const designAsset: DesignAsset = {
      id: asset.id as DesignAsset["id"],
      name: asset.filename,
      kind: "image",
      mime_type: asset.mimeType,
      size_bytes: asset.sizeBytes,
      storage_key: `asset:${asset.id}`,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      metadata: {},
    };
    const label = createTextNode({
      name: "Pay label",
      content: "Pay now",
      layout: { x: 18, y: 18, width: 180, height: 32 },
      style: { color: { token_id: tokenId }, typography: { font_size: 18, font_weight: 650 } },
    });
    const component = createComponentNode({
      name: "Payment button",
      component_key: "checkout.payment-button",
      description: "Primary payment action",
      children: [label.id],
      layout: { x: 32, y: 160, width: 230, height: 68, mode: "absolute" },
      style: { fill: "#ffffff", radius: 12 },
    });
    const instance = createInstanceNode({
      name: "Payment button instance",
      component_id: component.id,
      layout: { x: 32, y: 260, width: 230, height: 68 },
    });
    const operations: DesignOperation[] = [
      {
        type: "upsert_token",
        token: {
          id: tokenId,
          name: "Action foreground",
          path: "color.action.foreground",
          kind: "color",
          value: "#2457f5",
          archived: false,
          metadata: {},
        },
      },
      { type: "upsert_asset", asset: designAsset },
      {
        type: "create_tree",
        parent: { node_id: rootFrameId },
        root_ids: [component.id, instance.id],
        nodes: [component, label, instance],
      },
    ];
    const authored = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}/revisions`, {
      method: "POST",
      body: { baseVersion: 1, operations, idempotencyKey: "inspect-author-0001", message: "Author inspect fixture" },
    });
    expect(authored).toMatchObject({ version: 2, schemaVersion: 1 });

    const backup = await api<{ backup: { id: string; status: string } }>(baseURL, "/api/backups", {
      method: "POST",
      body: {},
    });
    expect(backup.backup.status).toBe("valid");
    const migrated = await api<RevisionEnvelope & { migrated: boolean }>(
      baseURL,
      `/api/designs/${encodeURIComponent(designId)}/migrations/v2`,
      {
        method: "POST",
        body: {
          expectedBaseVersion: 2,
          backupId: backup.backup.id,
          idempotencyKey: "inspect-migrate-0001",
        },
      },
    );
    expect(migrated).toMatchObject({ version: 3, schemaVersion: 2, migrated: true });
    const pinnedRevisionId = migrated.revisionId;
    const initialInspect = await api<InspectEnvelope>(
      baseURL,
      `/api/projects/${encodeURIComponent(designId)}/revisions/${encodeURIComponent(pinnedRevisionId)}/inspect`,
    );
    const componentDefinitionId = initialInspect.evidence.components[0]?.id;
    expect(componentDefinitionId).toMatch(/^component_/);

    const pinnedSpecification = exactSpecification({
      version: 1,
      ruleId: "rule_pinnedinspect0001",
      ruleTitle: "Pinned confirmation rule",
      criterionId: "criterion_pinnedinspect0001",
      criterionTitle: "Pinned amount remains visible",
      nodeId: instance.id,
      componentId: componentDefinitionId!,
    });
    const now = "2026-07-20T10:00:00.000Z";
    application.database.sqlite.prepare(
      `INSERT INTO product_specifications
       (design_id, version, specification_json, organization_id, specification_hash, message,
        revision_id, actor_id, created_at)
       VALUES (?, 1, ?, 'organization_legacy', ?, 'Pinned inspect specification', ?, 'principal_local', ?)`,
    ).run(designId, canonicalJson(pinnedSpecification), hashPayload(pinnedSpecification), pinnedRevisionId, now);
    application.database.sqlite.prepare(
      `INSERT INTO implementation_mappings
       (id, organization_id, design_id, revision_id, inventory_id, entity_kind, entity_id,
        platform, symbol, mapping_json, created_by, created_at)
       VALUES ('mapping_pinnedinspect0001', 'organization_legacy', ?, ?, NULL, 'component', ?,
               'web', 'CheckoutButton', ?, 'principal_local', ?)`,
    ).run(designId, pinnedRevisionId, componentDefinitionId, canonicalJson({ module: "checkout/CheckoutButton.tsx" }), now);

    const inspectUrl = `${baseURL}/projects/${encodeURIComponent(designId)}/revisions/${encodeURIComponent(pinnedRevisionId)}/inspect`;
    await page.goto(inspectUrl);
    await expect(page.locator(".inspect-topbar")).toContainText("pinned revision 3");
    await expect(page.locator(".inspect-integrity-pills")).toContainText("Pinned v3");
    await expect(page.locator(".inspect-integrity-pills")).toContainText("Schema v2");
    await expect(page.getByTestId("revision-integrity")).toContainText(pinnedRevisionId);
    await expect(page.getByTestId("inspect-tokens")).toContainText("color.action.foreground");
    await expect(page.getByTestId("inspect-tokens")).toContainText("#2457f5");
    await expect(page.getByTestId("inspect-assets")).toContainText(asset.sha256);
    await expect(page.getByTestId("inspect-components")).toContainText("Payment button");
    await expect(page.getByTestId("inspect-business-rules")).toContainText("Pinned confirmation rule");
    await expect(page.getByTestId("inspect-acceptance-criteria")).toContainText("Pinned amount remains visible");
    await expect(page.getByTestId("inspect-implementation-mappings")).toContainText("CheckoutButton");
    await expect(page.locator(".inspect-preview img")).toHaveAttribute("src", /[?&]version=3(?:&|$)/);

    await page.getByLabel("Search revision nodes").fill("Pay label");
    await page.locator(".inspect-node-list button", { hasText: "Pay label" }).click();
    await expect(page.getByTestId("resolved-node-values")).toContainText("#2457f5");
    await expect(page.locator(".inspect-card", { hasText: "Stable identity" })).toContainText(`$.nodes["${label.id}"]`);

    const latest = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}/revisions`, {
      method: "POST",
      body: {
        baseVersion: 3,
        idempotencyKey: "inspect-head-update-0001",
        message: "Change the project head after inspect is pinned",
        operations: [
          {
            type: "upsert_token",
            token: {
              id: tokenId,
              name: "Action foreground",
              path: "color.action.foreground",
              kind: "color",
              value: "#ef4444",
              archived: false,
              metadata: {},
            },
          },
          { type: "update_node", node_id: label.id, patch: { name: "Latest pay label", content: "Latest pay now" } },
        ],
      },
    });
    expect(latest).toMatchObject({ version: 4, schemaVersion: 2 });
    const latestSpecification = exactSpecification({
      version: 2,
      ruleId: "rule_latestinspect0001",
      ruleTitle: "Latest head-only rule",
      criterionId: "criterion_latestinspect0001",
      criterionTitle: "Latest head-only criterion",
      nodeId: instance.id,
      componentId: componentDefinitionId!,
    });
    application.database.sqlite.prepare(
      `INSERT INTO product_specifications
       (design_id, version, specification_json, organization_id, specification_hash, message,
        revision_id, actor_id, created_at)
       VALUES (?, 2, ?, 'organization_legacy', ?, 'Latest head specification', ?, 'principal_local', ?)`,
    ).run(designId, canonicalJson(latestSpecification), hashPayload(latestSpecification), latest.revisionId, now);
    application.database.sqlite.prepare(
      `INSERT INTO implementation_mappings
       (id, organization_id, design_id, revision_id, inventory_id, entity_kind, entity_id,
        platform, symbol, mapping_json, created_by, created_at)
       VALUES ('mapping_latestinspect0001', 'organization_legacy', ?, ?, NULL, 'component', ?,
               'web', 'LatestCheckoutButton', ?, 'principal_local', ?)`,
    ).run(designId, latest.revisionId, componentDefinitionId, canonicalJson({ module: "latest/CheckoutButton.tsx" }), now);

    await page.reload();
    await expect(page.locator(".inspect-integrity-pills")).toContainText("Pinned v3");
    await expect(page.locator(".inspect-integrity-pills")).toContainText("Head v4");
    await expect(page.getByTestId("inspect-tokens")).toContainText("#2457f5");
    await expect(page.getByTestId("inspect-tokens")).not.toContainText("#ef4444");
    await expect(page.getByTestId("inspect-business-rules")).toContainText("Pinned confirmation rule");
    await expect(page.getByTestId("inspect-business-rules")).not.toContainText("Latest head-only rule");
    await expect(page.getByTestId("inspect-implementation-mappings")).toContainText("CheckoutButton");
    await expect(page.getByTestId("inspect-implementation-mappings")).not.toContainText("LatestCheckoutButton");
    await expect(page.locator(".inspect-node-list")).not.toContainText("Latest pay label");

    const reloadedInspect = await api<InspectEnvelope>(
      baseURL,
      `/api/projects/${encodeURIComponent(designId)}/revisions/${encodeURIComponent(pinnedRevisionId)}/inspect`,
    );
    expect(reloadedInspect).toMatchObject({
      project: { version: 3, revisionId: pinnedRevisionId },
      head: { version: 4, revisionId: latest.revisionId },
      revision: { version: 3, id: pinnedRevisionId },
      document: { schema_version: 2, revision: 3 },
    });
    expect(reloadedInspect.evidence.tokens[0]?.resolvedValue).toBe("#2457f5");
    expect(reloadedInspect.evidence.businessRules.map((rule) => rule.title)).toEqual(["Pinned confirmation rule"]);
    expect(reloadedInspect.evidence.implementationMappings.map((mapping) => mapping.symbol)).toEqual(["CheckoutButton"]);
  } finally {
    await application?.app.close().catch(() => undefined);
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

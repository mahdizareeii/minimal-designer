import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { PLANNING_SECTIONS } from "@designer/core";
import { expect, test, type Page, type TestInfo } from "playwright/test";

import { buildApplication, type DesignerApplication } from "../src/app.js";
import { restoreVerifiedBackup } from "../src/backup.js";
import { loadConfig, type ServerConfig } from "../src/config.js";

interface RevisionEnvelope {
  version: number;
  revisionId: string;
  snapshotHash: string;
  operationHash: string;
  revisionHash: string;
  schemaVersion: number;
  document: {
    schema_version: number;
    id: string;
    revision: number;
    pages: Array<{ id: string; name: string; children: string[] }>;
    nodes: Record<string, {
      id: string;
      name: string;
      type: string;
      content?: string;
      style: Record<string, unknown>;
    }>;
  };
}

interface PublicBackupRecord {
  id: string;
  filename: string;
  status: "creating" | "valid" | "invalid" | "restored";
  bundleSha256: string | null;
  sizeBytes: number | null;
}

interface AgentTask {
  id: string;
  designId: string;
  baseVersion: number;
  status: string;
  expectedOutput: string;
  launchUrl: string;
}

interface McpEnvelope<T extends Record<string, unknown>> {
  result?: {
    instructions?: string;
    structuredContent?: T & { ok: boolean; error?: { code?: string; message?: string } };
    content?: Array<{ type: string; mimeType?: string; data?: string; text?: string }>;
  };
  error?: { code: number; message: string; data?: unknown };
}

interface StepEvidence {
  step: number;
  name: string;
  durationMs: number;
  completedAt: string;
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

function releaseConfig(port: number, dataDir: string, backupDir: string): ServerConfig {
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

async function startApplication(config: ServerConfig): Promise<DesignerApplication> {
  const application = await buildApplication(config);
  try {
    await application.app.listen({ host: config.host, port: config.port });
    return application;
  } catch (error) {
    await application.app.close().catch(() => undefined);
    throw error;
  }
}

async function readResponseBody(response: Response): Promise<{ text: string; json?: unknown }> {
  const text = await response.text();
  if (!text) return { text };
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
}

async function api<T>(
  baseURL: string,
  route: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(`${baseURL}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      "x-formaspec-csrf": "1",
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const parsed = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${route} failed (${response.status}): ${parsed.text}`);
  }
  return parsed.json as T;
}

async function apiBytes(baseURL: string, route: string): Promise<{ data: Buffer; headers: Headers }> {
  const response = await fetch(`${baseURL}${route}`, { headers: { "x-formaspec-csrf": "1" } });
  if (!response.ok) throw new Error(`GET ${route} failed (${response.status}): ${await response.text()}`);
  return { data: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}

async function validatePortableBundle(baseURL: string, data: Buffer): Promise<Record<string, unknown>> {
  const body = new FormData();
  body.append("file", new Blob([Uint8Array.from(data)], { type: "application/zip" }), "release-scenario.formaspec.zip");
  const response = await fetch(`${baseURL}/api/imports/validate`, {
    method: "POST",
    headers: { "x-formaspec-csrf": "1" },
    body,
  });
  const parsed = await readResponseBody(response);
  if (!response.ok) throw new Error(`Portable validation failed (${response.status}): ${parsed.text}`);
  return parsed.json as Record<string, unknown>;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function designIdFromPage(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/design\/([^/]+)$/);
  if (!match?.[1]) throw new Error(`Expected an editor deep link, received ${page.url()}.`);
  return decodeURIComponent(match[1]);
}

test("product manager to verified backup restore completes through browser, MCP, and immutable history", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-release-e2e-"));
  const dataDir = path.join(temporaryRoot, "data");
  const backupDir = path.join(temporaryRoot, "backups");
  const port = await reserveLoopbackPort();
  const config = releaseConfig(port, dataDir, backupDir);
  const baseURL = config.publicBaseUrl;
  const evidence: StepEvidence[] = [];
  let application: DesignerApplication | null = null;
  let mcpRequestId = 1;
  let agentToken = "";

  const step = async <T>(name: string, handler: () => Promise<T>): Promise<T> => {
    const stepNumber = evidence.length + 1;
    return test.step(`${String(stepNumber).padStart(2, "0")}. ${name}`, async () => {
      const startedAt = performance.now();
      const result = await handler();
      evidence.push({
        step: stepNumber,
        name,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        completedAt: new Date().toISOString(),
      });
      return result;
    });
  };

  const mcp = async <T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<McpEnvelope<T>> => {
    const response = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(agentToken ? { authorization: `Bearer ${agentToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: mcpRequestId++, method, params }),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(`MCP ${method} failed (${response.status}): ${body.text}`);
    const envelope = body.json as McpEnvelope<T>;
    if (envelope.error) throw new Error(`MCP ${method} returned ${envelope.error.message}.`);
    return envelope;
  };

  const callTool = async <T extends Record<string, unknown>>(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<{
    structured: T & { ok: true };
    content: NonNullable<NonNullable<McpEnvelope<T>["result"]>["content"]>;
  }> => {
    const envelope = await mcp<T>("tools/call", { name, arguments: arguments_ });
    const structured = envelope.result?.structuredContent;
    if (!structured?.ok) {
      throw new Error(`${name} failed: ${structured?.error?.code ?? "UNKNOWN"} ${structured?.error?.message ?? "No structured result."}`);
    }
    return {
      structured: structured as T & { ok: true },
      content: envelope.result?.content ?? [],
    };
  };

  await page.addInitScript(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.protocol === "formaspec:") {
        (window as unknown as { __formaspecTaskLink?: string }).__formaspecTaskLink = this.href;
        return;
      }
      originalClick.call(this);
    };
  });

  let designId = "";
  let rootFrameId = "";
  let task: AgentTask;
  let planningSessionId = "";
  let titleNodeId = "";
  let initialPreviewId = "";
  let manualRevision: RevisionEnvelope;
  let restoredHead: RevisionEnvelope;
  let finalBackup: PublicBackupRecord;
  let finalBundlePath = "";

  try {
    application = await startApplication(config);

    await step("Start an isolated local FormaSpec workspace and pass readiness", async () => {
      const health = await api<{ ok: boolean; migrations: number; render: { ok: boolean } }>(baseURL, "/health/ready");
      expect(health).toMatchObject({ ok: true, migrations: 10, render: { ok: true } });
    });

    await step("Create the product from the dashboard in a real browser", async () => {
      await page.goto(baseURL);
      await expect(page.getByRole("heading", { name: /Describe the product/i })).toBeVisible();
      await page.getByRole("button", { name: /Design a new product/i }).click();
      const createDialog = page.getByRole("dialog", { name: "New design" });
      await createDialog.getByLabel("Design name").fill("Courier dispatch release scenario");
      await createDialog.getByRole("button", { name: /^Create design/ }).click();
      await expect(page).toHaveURL(/\/design\/document_/);
      designId = designIdFromPage(page);
      const created = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(created).toMatchObject({ version: 1, schemaVersion: 1 });
      rootFrameId = created.document.pages[0]?.children[0] ?? "";
      expect(rootFrameId).toMatch(/^node_/);
    });

    const migrationBackup = await step("Create and verify the required pre-migration backup", async () => {
      const created = await api<{ backup: PublicBackupRecord }>(baseURL, "/api/backups", { method: "POST", body: {} });
      expect(created.backup).toMatchObject({ status: "valid" });
      expect(created.backup.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      const verified = await api<{ backup: PublicBackupRecord }>(
        baseURL,
        `/api/backups/${encodeURIComponent(created.backup.id)}/verify`,
        { method: "POST", body: {} },
      );
      expect(verified.backup.status).toBe("valid");
      return created.backup;
    });

    await step("Migrate only the active project head from V1 to strict V2", async () => {
      const migrated = await api<RevisionEnvelope & { migrated: boolean; backupId: string }>(
        baseURL,
        `/api/designs/${encodeURIComponent(designId)}/migrations/v2`,
        {
          method: "POST",
          body: {
            expectedBaseVersion: 1,
            backupId: migrationBackup.id,
            idempotencyKey: "release-e2e-v2-migration-0001",
          },
        },
      );
      expect(migrated).toMatchObject({ migrated: true, version: 2, schemaVersion: 2, backupId: migrationBackup.id });
      await page.goto(`${baseURL}/design/${encodeURIComponent(designId)}`);
      await expect(page.locator(".document-title")).toContainText("Courier dispatch release scenario");
      // The browser intentionally edits the V1 compatibility projection while
      // the API and immutable head remain strict canonical V2.
      await expect(page.getByText("Schema v1")).toBeVisible();
    });

    await step("Enter the canonical product brief and create a website-owned Codex task", async () => {
      const brief = [
        "Build a professional bilingual courier dispatch flow for operations managers.",
        "Dispatchers assign urgent orders, review courier availability, and confirm sensitive changes.",
        "English and Persian RTL must be supported, touch targets must be accessible, and every commit must remain auditable.",
      ].join(" ");
      await page.getByLabel("Describe the product, business logic, and constraints").fill(brief);
      await page.getByRole("button", { name: /Start with Codex/i }).click();
      await expect(page.locator(".product-panel-success")).toContainText("queued");

      const tasks = await api<{ tasks: AgentTask[] }>(baseURL, `/api/designs/${encodeURIComponent(designId)}/agent-tasks`);
      task = tasks.tasks[0]!;
      expect(task).toMatchObject({ designId, baseVersion: 2, status: "queued", expectedOutput: "design_preview" });
      expect(await page.evaluate(() => (window as unknown as { __formaspecTaskLink?: string }).__formaspecTaskLink))
        .toBe(`formaspec://connect-agent?task=${encodeURIComponent(task.id)}`);
      const specification = await api<{ version: number; naturalLanguageBrief: string }>(
        baseURL,
        `/api/designs/${encodeURIComponent(designId)}/product-specification`,
      );
      expect(specification.version).toBe(1);
      expect(specification.naturalLanguageBrief).toContain("bilingual courier dispatch");
    });

    await step("Complete and persist the versioned 22-section product-manager interview", async () => {
      let planning = await api<{
        session: { id: string; version: number; status: string };
        sectionCount: number;
      }>(baseURL, `/api/designs/${encodeURIComponent(designId)}/planning-sessions`, {
        method: "POST",
        body: { idempotencyKey: "release-e2e-planning-session-0001" },
      });
      planningSessionId = planning.session.id;
      expect(planning.sectionCount).toBe(22);
      expect(PLANNING_SECTIONS).toHaveLength(22);
      for (const [index, section] of PLANNING_SECTIONS.entries()) {
        planning = await api<typeof planning>(baseURL, `/api/planning-sessions/${encodeURIComponent(planningSessionId)}/answers`, {
          method: "POST",
          body: {
            expectedVersion: planning.session.version,
            section,
            answer: `Release scenario answer ${index + 1}: ${section.replaceAll("_", " ")}.`,
            ...(index + 1 < PLANNING_SECTIONS.length ? { nextSection: PLANNING_SECTIONS[index + 1] } : { status: "ready_for_review" }),
          },
        });
      }
      planning = await api<typeof planning>(baseURL, `/api/planning-sessions/${encodeURIComponent(planningSessionId)}/transition`, {
        method: "POST",
        body: { expectedVersion: planning.session.version, status: "completed" },
      });
      expect(planning.session.status).toBe("completed");
    });

    await step("Pair a project-scoped agent and initialize the stateless FormaSpec MCP contract", async () => {
      const challenge = await api<{
        connection: { id: string; status: string };
        nonce: string;
      }>(baseURL, "/api/agent-connections", {
        method: "POST",
        body: {
          adapter: "codex",
          displayName: "Release scenario Codex",
          scopes: [
            "design:read",
            "design:preview",
            "design:write",
            "product_spec:read",
            "task:read",
            "task:claim",
            "task:update",
          ],
          projectIds: [designId],
          expiresInSeconds: 3_600,
        },
      });
      expect(challenge.connection.status).toBe("pending");
      const paired = await api<{
        connection: { id: string; status: string };
        grant: { token: string; actorId: string };
      }>(baseURL, "/api/agent-connections/pair", {
        method: "POST",
        body: { nonce: challenge.nonce },
      });
      expect(paired.connection).toMatchObject({ id: challenge.connection.id, status: "active" });
      agentToken = paired.grant.token;
      expect(agentToken.length).toBeGreaterThanOrEqual(32);

      const initialized = await mcp<Record<string, never>>("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "formaspec-release-e2e", version: "1.0.0" },
      });
      expect(initialized.result?.instructions).toContain("also called Minimal UI");
      expect(initialized.result?.instructions).toContain("Preview, inspect, and lint");
      expect(initialized.result?.instructions?.length).toBeLessThanOrEqual(512);
    });

    await step("Claim the immutable website task and record agent progress through MCP", async () => {
      const claimed = await callTool<{ task: { id: string; status: string } }>("task_claim", { task_id: task.id });
      expect(claimed.structured.task).toMatchObject({ id: task.id, status: "claimed" });
      const progressed = await callTool<{ task: { status: string } }>("task_transition", {
        task_id: task.id,
        expected_status: "claimed",
        to_status: "in_progress",
        message: "Read the PM brief and begin a bounded design proposal.",
      });
      expect(progressed.structured.task.status).toBe("in_progress");
    });

    await step("Read the active browser context and strict V2 project head through MCP", async () => {
      const context = await callTool<{ context: { designId: string; version: number; selection: string[] } }>("context_get", {});
      expect(context.structured.context).toMatchObject({ designId, version: 2 });
      const design = await callTool<{ schemaVersion: number; document: { schema_version: number } }>("design_read", {
        design_id: designId,
        depth: 4,
        max_nodes: 250,
        projection: "full",
      });
      expect(design.structured).toMatchObject({ schemaVersion: 2, document: { schema_version: 2 } });
    });

    const initialPreview = await step("Preview a structured multi-screen design with temporary IDs", async () => {
      const preview = await callTool<{
        preview: {
          id: string;
          rootBaseVersion: number;
          canCommit: boolean;
          resultSnapshotHash: string;
          changedNodeIds: string[];
          createdIds: { temporary: Record<string, string> };
          editorDeepLink: string;
        };
        render: { width: number; height: number; renderer: string };
      }>("design_preview_changes", {
        design_id: designId,
        base_version: 2,
        max_size: 768,
        operations: [
          {
            type: "create_page",
            page: {
              id: "tmp:confirmation-page",
              name: "Dispatch confirmation",
              background: "#080b14",
              viewport: { width: 1440, height: 900 },
              metadata: { locale: "en-US", direction: "ltr" },
            },
          },
          {
            type: "create_tree",
            parent: { page_id: "tmp:confirmation-page" },
            root_ids: ["tmp:confirmation-frame"],
            nodes: [
              {
                id: "tmp:confirmation-frame",
                type: "frame",
                name: "Confirmation screen",
                role: "screen",
                children: ["tmp:confirmation-title"],
                clip_content: true,
                layout: { x: 0, y: 0, width: 1440, height: 900, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
                style: { fill: "#101525" },
                visible: true,
                locked: false,
                archived: false,
                metadata: { locale: "en-US", direction: "ltr" },
              },
              {
                id: "tmp:confirmation-title",
                type: "text",
                name: "Confirmation title",
                content: "Order assigned successfully",
                direction: "auto",
                layout: { x: 96, y: 104, width: 620, height: 64, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
                style: { color: "#f4f7ff", typography: { font_family: "Inter", font_size: 38, font_weight: 700, line_height: 48 } },
                visible: true,
                locked: false,
                archived: false,
                metadata: { semantic_role: "heading" },
              },
            ],
          },
          {
            type: "create_tree",
            parent: { node_id: rootFrameId },
            root_ids: ["tmp:title", "tmp:cta", "tmp:cta-label"],
            nodes: [
              {
                id: "tmp:title",
                type: "text",
                name: "Checkout title",
                content: "Review urgent dispatch",
                direction: "auto",
                layout: { x: 96, y: 96, width: 560, height: 72, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
                style: { color: "#111827", typography: { font_family: "Inter", font_size: 40, font_weight: 700, line_height: 48 } },
                visible: true,
                locked: false,
                archived: false,
                metadata: { semantic_role: "heading", rule_id: "rule_dispatch_confirmation" },
              },
              {
                id: "tmp:cta",
                type: "rectangle",
                name: "Assign courier action",
                layout: { x: 96, y: 220, width: 260, height: 56, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
                style: { fill: "#675cff", radius: 14 },
                visible: true,
                locked: false,
                archived: false,
                metadata: { semantic_role: "button", acceptance_criterion_id: "ac_assign_courier" },
              },
              {
                id: "tmp:cta-label",
                type: "text",
                name: "Assign courier label",
                content: "Assign courier",
                direction: "auto",
                layout: { x: 126, y: 234, width: 200, height: 28, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
                style: { color: "#ffffff", typography: { font_family: "Inter", font_size: 17, font_weight: 650, line_height: 24, text_align: "center" } },
                visible: true,
                locked: false,
                archived: false,
                metadata: { semantic_role: "button_label" },
              },
            ],
          },
          {
            type: "set_prototype_link",
            link: {
              id: "tmp:assign-link",
              source_node_id: "tmp:cta",
              trigger: { type: "click" },
              action: { type: "navigate", page_id: "tmp:confirmation-page" },
              transition: { type: "dissolve", duration_ms: 180, easing: "ease-out" },
              metadata: { flow: "assign_courier" },
            },
          },
        ],
      });
      initialPreviewId = preview.structured.preview.id;
      titleNodeId = preview.structured.preview.createdIds.temporary["tmp:title"] ?? "";
      expect(preview.structured.preview).toMatchObject({ rootBaseVersion: 2, canCommit: true });
      expect(preview.structured.preview.resultSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.structured.preview.createdIds.temporary["tmp:confirmation-page"]).toMatch(/^page_/);
      expect(titleNodeId).toMatch(/^node_/);
      expect(preview.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
      return preview.structured;
    });

    await step("Lint the exact persisted preview without mutating history", async () => {
      const lint = await callTool<{ diagnostics: unknown[] }>("design_lint", {
        design_id: designId,
        preview_id: initialPreviewId,
      });
      expect(Array.isArray(lint.structured.diagnostics)).toBe(true);
      const head = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(head.version).toBe(2);
    });

    await step("Render the same preview as a bounded PNG for visual inspection", async () => {
      const rendered = await callTool<{ render: { width: number; height: number; renderer: string; warnings: string[] } }>("design_render", {
        design_id: designId,
        preview_id: initialPreviewId,
        max_size: 768,
      });
      expect(rendered.structured.render.width).toBeGreaterThan(0);
      expect(rendered.structured.render.height).toBeGreaterThan(0);
      expect(rendered.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
      expect(initialPreview.render.width).toBe(rendered.structured.render.width);
    });

    const agentCommit = await step("Commit the exact preview atomically as the first agent revision", async () => {
      const committed = await callTool<{
        design: { version: number };
        revision: { id: string; snapshotHash: string; revisionHash: string };
        deepLink: string;
      }>("design_commit_preview", {
        design_id: designId,
        preview_id: initialPreviewId,
        expected_base_version: 2,
        idempotency_key: "release-e2e-agent-commit-0001",
        message: "Codex creates the bilingual dispatch flow",
      });
      expect(committed.structured.design.version).toBe(3);
      expect(committed.structured.revision.snapshotHash).toBe(initialPreview.preview.resultSnapshotHash);
      expect(committed.structured.deepLink).toBe(`${baseURL}/design/${designId}`);
      return committed.structured;
    });

    await step("Complete the website task with its validated preview output", async () => {
      const completed = await callTool<{ task: { status: string } }>("task_transition", {
        task_id: task.id,
        expected_status: "in_progress",
        to_status: "completed",
        message: "Preview inspected, linted, and committed with approval.",
        data: { previewId: initialPreviewId },
      });
      expect(completed.structured.task.status).toBe("completed");
    });

    await step("Let a human select and correct the same design in the browser editor", async () => {
      await page.goto(`${baseURL}/design/${encodeURIComponent(designId)}?node=${encodeURIComponent(titleNodeId)}`);
      await expect(page.locator(`.designer-node[data-node-id="${titleNodeId}"]`)).toBeVisible();
      const titleRow = page.locator(".layer-row").filter({ has: page.locator(".layer-name", { hasText: "Checkout title" }) });
      await titleRow.click();
      const content = page.locator(".inspector-field.textarea-field textarea");
      await content.fill("Review urgent dispatch — human verified");
      await expect(page.locator(".save-status")).toContainText(/Unsaved|Saving|Saved/);
      const saveButton = page.getByTitle("Save now");
      if (await saveButton.isEnabled()) await saveButton.click();
      await expect(page.locator(".save-status")).toContainText("Saved", { timeout: 15_000 });
      manualRevision = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(manualRevision.version).toBe(4);
      expect(manualRevision.document.nodes[titleNodeId]?.content).toContain("human verified");
    });

    const refinementPreview = await step("Read the editor selection and preview a selection-scoped agent refinement", async () => {
      const context = await callTool<{ context: { designId: string; version: number; selection: string[] } }>("context_get", {});
      expect(context.structured.context).toMatchObject({ designId, version: 4, selection: [titleNodeId] });
      const before = await apiBytes(
        baseURL,
        `/api/designs/${encodeURIComponent(designId)}/render.png?version=4&nodeId=${encodeURIComponent(titleNodeId)}&maxSize=768`,
      );
      const preview = await callTool<{
        preview: { id: string; canCommit: boolean; resultSnapshotHash: string; changedNodeIds: string[] };
      }>("design_preview_changes", {
        design_id: designId,
        base_version: 4,
        node_id: titleNodeId,
        max_size: 768,
        operations: [{
          type: "update_node",
          node_id: titleNodeId,
          patch: {
            direction: "auto",
            style: {
              color: "#2f2a8f",
              typography: { font_family: "Inter", font_size: 42, font_weight: 750, line_height: 50 },
            },
            metadata: { refinement: "selection_scoped", preserves_human_copy: true },
          },
        }],
      });
      expect(preview.structured.preview).toMatchObject({ canCommit: true, changedNodeIds: [titleNodeId] });
      const previewImage = preview.content.find((item) => item.type === "image" && item.mimeType === "image/png");
      if (!previewImage?.data) throw new Error("The scoped MCP preview did not return its PNG content block.");
      const after = Buffer.from(previewImage.data, "base64");
      expect(before.headers.get("content-type")).toContain("image/png");
      expect(after.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(sha256(after)).not.toBe(sha256(before.data));
      return preview.structured;
    });

    await step("Commit the inspected refinement and preserve the human-authored copy", async () => {
      const committed = await callTool<{ design: { version: number }; revision: { id: string; snapshotHash: string } }>("design_commit_preview", {
        design_id: designId,
        preview_id: refinementPreview.preview.id,
        expected_base_version: 4,
        idempotency_key: "release-e2e-selection-commit-0001",
        message: "Codex refines the selected heading",
      });
      expect(committed.structured).toMatchObject({ design: { version: 5 } });
      expect(committed.structured.revision.snapshotHash).toBe(refinementPreview.preview.resultSnapshotHash);
      const head = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(head.document.nodes[titleNodeId]?.content).toContain("human verified");
      expect(head.document.nodes[titleNodeId]?.style).toMatchObject({ color: "#2f2a8f" });
    });

    await step("Restore the human revision through history and inspect immutable integrity metadata", async () => {
      await page.goto(`${baseURL}/design/${encodeURIComponent(designId)}`);
      await page.getByRole("button", { name: "History" }).click();
      const manualRow = page.locator(".history-row").filter({ hasText: "Manual editor changes" }).first();
      await expect(manualRow).toBeVisible();
      await manualRow.getByRole("button", { name: "Restore" }).click();
      await expect(page.locator(".toast")).toContainText("Restored version 4 as a new immutable revision", { timeout: 15_000 });
      restoredHead = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(restoredHead.version).toBe(6);
      expect(restoredHead.document.nodes[titleNodeId]?.content).toContain("human verified");
      expect(restoredHead.document.nodes[titleNodeId]?.style).not.toMatchObject({ color: "#2f2a8f" });

      const inspection = await api<{
        integrity: { revisionId: string; revisionHash: string; snapshotHash: string; operationHash: string; schemaVersion: number };
        document: { revision: number };
      }>(baseURL, `/api/projects/${encodeURIComponent(designId)}/revisions/${encodeURIComponent(manualRevision.revisionId)}/inspect`);
      expect(inspection.integrity).toMatchObject({
        revisionId: manualRevision.revisionId,
        revisionHash: manualRevision.revisionHash,
        snapshotHash: manualRevision.snapshotHash,
        operationHash: manualRevision.operationHash,
        schemaVersion: 2,
      });
      expect(inspection.document.revision).toBe(4);
    });

    await step("Validate canonical JSON, the portable bundle, and a final verified backup", async () => {
      const canonical = await api<{ schema_version: number; revision: number; id: string }>(
        baseURL,
        `/api/designs/${encodeURIComponent(designId)}/export`,
      );
      expect(canonical).toMatchObject({ schema_version: 2, revision: 6, id: designId });

      const portable = await apiBytes(baseURL, `/api/designs/${encodeURIComponent(designId)}/export.formaspec.zip`);
      expect(portable.headers.get("content-type")).toContain("application/zip");
      expect(portable.headers.get("x-formaspec-bundle-sha256")).toBe(sha256(portable.data));
      const validation = await validatePortableBundle(baseURL, portable.data);
      expect(validation).toMatchObject({ valid: true });

      const created = await api<{ backup: PublicBackupRecord }>(baseURL, "/api/backups", { method: "POST", body: {} });
      finalBackup = created.backup;
      expect(finalBackup).toMatchObject({ status: "valid" });
      expect(finalBackup.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(finalBackup.sizeBytes).toBeGreaterThan(0);
      const verified = await api<{ backup: PublicBackupRecord }>(
        baseURL,
        `/api/backups/${encodeURIComponent(finalBackup.id)}/verify`,
        { method: "POST", body: {} },
      );
      expect(verified.backup.status).toBe("valid");
      finalBundlePath = path.join(backupDir, finalBackup.filename);
      expect((await fs.promises.stat(finalBundlePath)).size).toBe(finalBackup.sizeBytes);
    });

    await step("Restore with the database stopped, restart, and prove exact workflow recovery", async () => {
      const drift = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}/revisions`, {
        method: "POST",
        body: {
          baseVersion: 6,
          operations: [{ type: "update_node", node_id: titleNodeId, patch: { content: "Post-backup drift that must disappear" } }],
          idempotencyKey: "release-e2e-post-backup-drift-0001",
          message: "Post-backup drift sentinel",
        },
      });
      expect(drift.version).toBe(7);
      const sentinel = await api<RevisionEnvelope>(baseURL, "/api/designs", {
        method: "POST",
        body: { name: "Post-backup sentinel project", preset: "phone", idempotencyKey: "release-e2e-sentinel-create-0001" },
      });
      expect(sentinel.document.id).not.toBe(designId);

      await page.goto("about:blank");
      const restoreRenderer = application?.renderer;
      const rasterVerifier = application?.backups.rasterVerifier;
      if (!restoreRenderer || !rasterVerifier) {
        throw new Error("The release restore scenario requires isolated raster-verification wiring.");
      }
      await application?.app.close();
      application = null;
      if (!finalBackup.bundleSha256 || !finalBackup.sizeBytes) throw new Error("The verified restore source is incomplete.");
      try {
        await restoreVerifiedBackup(finalBundlePath, dataDir, {
          databaseClosed: true,
          expectedSource: { sha256: finalBackup.bundleSha256, sizeBytes: finalBackup.sizeBytes },
          sourcePinDirectory: backupDir,
          rasterVerifier,
          requireRasterVerifier: true,
        });
      } finally {
        await restoreRenderer.close();
      }
      application = await startApplication(config);

      const health = await api<{ ok: boolean; migrations: number }>(baseURL, "/health/ready");
      expect(health).toMatchObject({ ok: true, migrations: 10 });
      const projects = await api<{ designs: Array<{ id: string; version: number }> }>(baseURL, "/api/designs?limit=100");
      expect(projects.designs.some((project) => project.id === sentinel.document.id)).toBe(false);
      expect(projects.designs).toEqual(expect.arrayContaining([expect.objectContaining({ id: designId, version: 6 })]));

      const recovered = await api<RevisionEnvelope>(baseURL, `/api/designs/${encodeURIComponent(designId)}`);
      expect(recovered).toMatchObject({
        version: 6,
        revisionId: restoredHead.revisionId,
        revisionHash: restoredHead.revisionHash,
        snapshotHash: restoredHead.snapshotHash,
        operationHash: restoredHead.operationHash,
        schemaVersion: 2,
      });
      expect(recovered.document.nodes[titleNodeId]?.content).toContain("human verified");
      expect(recovered.document.nodes[titleNodeId]?.content).not.toContain("Post-backup drift");

      const recoveredSpec = await api<{ version: number; naturalLanguageBrief: string }>(
        baseURL,
        `/api/designs/${encodeURIComponent(designId)}/product-specification`,
      );
      expect(recoveredSpec).toMatchObject({ version: 1 });
      const recoveredPlanning = await api<{ session: { status: string }; versions: unknown[] }>(
        baseURL,
        `/api/planning-sessions/${encodeURIComponent(planningSessionId)}`,
      );
      expect(recoveredPlanning.session.status).toBe("completed");
      expect(recoveredPlanning.versions.length).toBe(24);
      const recoveredTask = await api<{ task: AgentTask }>(baseURL, `/api/agent-tasks/${encodeURIComponent(task.id)}`);
      expect(recoveredTask.task.status).toBe("completed");

      const smoke = await apiBytes(baseURL, `/api/designs/${encodeURIComponent(designId)}/render.png?maxSize=512`);
      expect(smoke.headers.get("content-type")).toContain("image/png");
      expect(smoke.data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(agentCommit.revision.id).toMatch(/^revision_/);
    });

    expect(evidence).toHaveLength(20);
  } finally {
    await testInfo.attach("product-manager-backup-restore-evidence.json", {
      body: Buffer.from(`${JSON.stringify({
        generatedAt: new Date().toISOString(),
        releaseDecision: "NO-GO",
        completedSteps: evidence.length,
        steps: evidence,
        limitations: [
          "The release scenario uses the stopped-database restore engine in an isolated local harness.",
          "Server-mode external-supervisor recovery remains separate release-blocking evidence.",
          "Backup provenance remains unsigned.",
        ],
      }, null, 2)}\n`),
      contentType: "application/json",
    });
    await page.goto("about:blank").catch(() => undefined);
    await application?.app.close().catch(() => undefined);
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

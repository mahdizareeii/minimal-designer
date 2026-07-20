import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

describe("design-system component authoring HTTP API", () => {
  let application: DesignerApplication | undefined;
  let directory: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-component-http-"));
    application = await buildApplication(loadConfig({
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: path.join(directory, "data"),
      BACKUP_DIR: path.join(directory, "backups"),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    await application.app.ready();
  });

  afterEach(async () => {
    await application?.app.close();
    application = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("lists latest definitions and publishes/deprecates by appending exact versions", async () => {
    if (!application) throw new Error("Expected the application to be ready.");
    const systemResponse = await application.app.inject({
      method: "POST",
      url: "/api/design-systems",
      payload: { name: "HTTP component system" },
    });
    expect(systemResponse.statusCode).toBe(201);
    const systemId = systemResponse.json<{ designSystem: { id: string } }>().designSystem.id;
    const definition = {
      id: "component_httpbutton000001",
      key: "button.http",
      name: "HTTP button",
      version: 1,
      status: "draft",
      root_node_id: "node_httpbuttonroot0001",
      properties_schema: [{
        key: "label",
        label: "Label",
        required: true,
        type: "text",
        default: "Continue",
      }],
      slots: [{
        key: "leading",
        name: "Leading content",
        required: false,
        min_items: 0,
        max_items: 1,
        allowed_node_types: ["icon"],
      }],
      states: [
        { key: "default", name: "Default", node_id: "node_httpbuttonroot0001" },
        { key: "focused", name: "Focused", node_id: "node_httpbuttonfocus001" },
      ],
      allowed_overrides: {
        allow_text: true,
        allow_assets: false,
        allow_icons: true,
        allowed_token_families: [],
        allowed_style_paths: [],
      },
      platform_mappings: [],
      documentation: {
        summary: "A typed HTTP fixture.",
        usage: [],
        accessibility: [],
        do_list: [],
        dont_list: [],
      },
    };
    const draftResponse = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemId}/components`,
      payload: { expectedLatestVersion: 0, definition },
    });
    expect(draftResponse.statusCode).toBe(201);

    const listDraft = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${systemId}/components`,
    });
    expect(listDraft.statusCode).toBe(200);
    const draftCatalog = listDraft.json<{
      components: Array<Record<string, unknown>>;
      permissions: { designSystemId: string; canAuthorComponents: boolean };
    }>();
    expect(draftCatalog.permissions).toEqual({ designSystemId: systemId, canAuthorComponents: true });
    expect(draftCatalog.components).toEqual([
      expect.objectContaining({
        componentId: definition.id,
        version: 1,
        status: "draft",
        isLatest: true,
        versionCount: 1,
        diagnostics: [expect.objectContaining({ code: "COMPONENT_DRAFT_REVIEW_REQUIRED" })],
      }),
    ]);

    const publishResponse = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemId}/components/${definition.id}/lifecycle`,
      payload: { expectedLatestVersion: 1, targetStatus: "published" },
    });
    expect(publishResponse.statusCode).toBe(201);
    expect(publishResponse.json<{ componentVersion: { version: number; status: string } }>().componentVersion)
      .toMatchObject({ version: 2, status: "published" });

    const deprecateResponse = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemId}/components/${definition.id}/lifecycle`,
      payload: { expectedLatestVersion: 2, targetStatus: "deprecated", replacementComponentId: null },
    });
    expect(deprecateResponse.statusCode).toBe(201);
    expect(deprecateResponse.json<{ componentVersion: { version: number; status: string } }>().componentVersion)
      .toMatchObject({ version: 3, status: "deprecated" });

    const historyResponse = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${systemId}/components?includeHistory=true`,
    });
    expect(historyResponse.statusCode).toBe(200);
    const history = historyResponse.json<{ components: Array<{ version: number; status: string; isLatest: boolean }> }>().components;
    expect(history.map((item) => [item.version, item.status, item.isLatest])).toEqual([
      [3, "deprecated", true],
      [2, "published", false],
      [1, "draft", false],
    ]);

    const latestResponse = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${systemId}/components?includeHistory=false`,
    });
    expect(latestResponse.statusCode).toBe(200);
    expect(latestResponse.json<{ components: Array<{ version: number }> }>().components.map((item) => item.version))
      .toEqual([3]);

    const staleResponse = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemId}/components/${definition.id}/lifecycle`,
      payload: { expectedLatestVersion: 2, targetStatus: "deprecated" },
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");

    application.database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE principal_id = 'principal_local'",
    ).run();
    const viewerCatalogResponse = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${systemId}/components?includeHistory=false`,
    });
    expect(viewerCatalogResponse.statusCode).toBe(200);
    expect(viewerCatalogResponse.json<{ permissions: { canAuthorComponents: boolean } }>().permissions)
      .toEqual({ designSystemId: systemId, canAuthorComponents: false });
    const deniedDraft = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemId}/components`,
      payload: {
        expectedLatestVersion: 3,
        definition: { ...definition, version: 4, status: "draft" },
      },
    });
    expect(deniedDraft.statusCode).toBe(403);
    expect(deniedDraft.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });
});

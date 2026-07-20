import { ComponentDefinitionSchema } from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildComponentDraftDefinition,
  DesignSystemComponentAuthoring,
  draftFromComponent,
  type ComponentAuthoringDraft,
} from "../components/DesignSystemComponentAuthoring";
import {
  createDesignSystemComponentDraft,
  readDesignSystemComponentCatalog,
  transitionDesignSystemComponent,
  type ComponentDefinitionCatalogRecord,
} from "../lib/api";

const draft: ComponentAuthoringDraft = {
  componentId: "component_checkoutbutton001",
  expectedLatestVersion: 2,
  key: "checkout.primary-action",
  name: "Checkout action",
  rootNodeId: "node_checkoutbuttonroot01",
  summary: "Completes the current checkout step.",
  properties: [
    {
      key: "label",
      label: "Label",
      type: "text",
      required: true,
      defaultValue: "Continue",
      enumValues: "",
      minItems: 0,
      maxItems: 1,
    },
    {
      key: "tone",
      label: "Tone",
      type: "enum",
      required: false,
      defaultValue: "brand",
      enumValues: "brand, neutral, brand",
      minItems: 0,
      maxItems: 1,
    },
  ],
  slots: [{
    key: "leading",
    name: "Leading content",
    required: false,
    minItems: 0,
    maxItems: 1,
    allowedNodeTypes: "icon, image, icon",
  }],
  states: [
    { key: "default", name: "Default", nodeId: "node_checkoutbuttonroot01" },
    { key: "focused", name: "Focused", nodeId: "node_checkoutbuttonfocus1" },
  ],
  allowText: true,
  allowAssets: false,
  allowIcons: true,
  preservedDefinition: null,
};

afterEach(() => vi.restoreAllMocks());

describe("design-system component authoring UI contract", () => {
  it("builds a strict typed draft and preserves its contract when reopened", () => {
    const definition = buildComponentDraftDefinition(draft);
    expect(ComponentDefinitionSchema.parse(definition)).toEqual(definition);
    expect(definition).toMatchObject({
      version: 3,
      status: "draft",
      properties_schema: [
        { key: "label", type: "text", default: "Continue" },
        { key: "tone", type: "enum", values: ["brand", "neutral"], default: "brand" },
      ],
      slots: [{ key: "leading", allowed_node_types: ["icon", "image"] }],
      states: [
        { key: "default", node_id: "node_checkoutbuttonroot01" },
        { key: "focused", node_id: "node_checkoutbuttonfocus1" },
      ],
    });

    const catalog: ComponentDefinitionCatalogRecord = {
      designSystemId: "system_companydesign001",
      componentId: definition.id,
      version: definition.version,
      status: definition.status,
      definition,
      createdBy: "principal_editor",
      createdAt: "2026-07-20T08:00:00.000Z",
      isLatest: true,
      versionCount: 3,
      replacement: null,
      diagnostics: [],
    };
    expect(buildComponentDraftDefinition(draftFromComponent(catalog))).toEqual({
      ...definition,
      version: 4,
    });
  });

  it("renders the bounded authoring surface and empty-state guidance", () => {
    const empty = renderToStaticMarkup(<DesignSystemComponentAuthoring designSystems={[]} />);
    expect(empty).toContain("Component catalog");
    expect(empty).toContain("Create a design system first");

    const ready = renderToStaticMarkup(<DesignSystemComponentAuthoring designSystems={[{
      id: "system_companydesign001",
      name: "Company system",
      description: "Shared components",
      status: "active",
      createdBy: "principal_admin",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    }]} />);
    expect(ready).toContain("Component design system");
    expect(ready).not.toContain("New component");
  });

  it("uses list, immutable draft, and lifecycle endpoints with exact typed payloads", async () => {
    const definition = buildComponentDraftDefinition({ ...draft, expectedLatestVersion: 0 });
    const componentVersion = {
      designSystemId: "system_companydesign001",
      componentId: definition.id,
      version: 1,
      status: "draft" as const,
      definition,
      createdBy: "principal_editor",
      createdAt: "2026-07-20T08:00:00.000Z",
    };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        components: [],
        permissions: { designSystemId: "system_companydesign001", canAuthorComponents: true },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ componentVersion }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        componentVersion: { ...componentVersion, version: 2, status: "published", definition: { ...definition, version: 2, status: "published" } },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));

    const catalog = await readDesignSystemComponentCatalog("system_companydesign001");
    expect(catalog.permissions).toEqual({
      designSystemId: "system_companydesign001",
      canAuthorComponents: true,
    });
    await createDesignSystemComponentDraft({
      designSystemId: "system_companydesign001",
      expectedLatestVersion: 0,
      definition,
    });
    await transitionDesignSystemComponent({
      designSystemId: "system_companydesign001",
      componentId: definition.id,
      expectedLatestVersion: 1,
      targetStatus: "published",
    });

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/design-systems/system_companydesign001/components?includeHistory=false");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedLatestVersion: 0,
      definition,
    });
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/design-systems/system_companydesign001/components/${definition.id}/lifecycle`);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      expectedLatestVersion: 1,
      targetStatus: "published",
    });
  });

  it("defaults missing or denied authoring capability to read-only", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        components: [],
        permissions: { designSystemId: "system_companydesign001", canAuthorComponents: false },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ components: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    expect((await readDesignSystemComponentCatalog("system_companydesign001")).permissions.canAuthorComponents).toBe(false);
    expect((await readDesignSystemComponentCatalog("system_companydesign001")).permissions.canAuthorComponents).toBe(false);
  });
});

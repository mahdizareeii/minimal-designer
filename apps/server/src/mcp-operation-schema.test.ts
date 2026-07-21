import { DesignOperationListSchema } from "@designer/core";
import { describe, expect, it } from "vitest";

import { McpDesignOperationListSchema } from "./mcp-operation-schema.js";

const layout = {
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  mode: "absolute",
  width_sizing: "fixed",
  height_sizing: "fixed",
} as const;

function temporaryIdOperations(): Array<Record<string, unknown>> {
  return [
    {
      type: "create_page",
      page: {
        id: "tmp:checkout-page",
        name: "Checkout",
        background: { token_id: "tmp:surface-token" },
        viewport: { width: 390, height: 844 },
        metadata: {},
      },
    },
    {
      type: "create_tree",
      parent: { page_id: "tmp:checkout-page" },
      root_ids: ["tmp:card", "tmp:hero-image", "tmp:instance"],
      nodes: [
        {
          id: "tmp:card",
          type: "rectangle",
          name: "Card",
          layout,
          style: { fill: { token_id: "tmp:surface-token" } },
          visible: true,
          locked: false,
          archived: false,
          metadata: {},
        },
        {
          id: "tmp:hero-image",
          type: "image",
          name: "Hero",
          layout,
          style: {},
          visible: true,
          locked: false,
          archived: false,
          metadata: {},
          asset_id: "tmp:hero-asset",
          alt: "Checkout hero",
          object_fit: "cover",
        },
        {
          id: "tmp:instance",
          type: "instance",
          name: "Button instance",
          layout,
          style: {},
          visible: true,
          locked: false,
          archived: false,
          metadata: {},
          component_id: "tmp:button-component",
          overrides: {},
        },
      ],
    },
    {
      type: "update_node",
      node_id: "tmp:card",
      patch: {
        asset_id: "tmp:hero-asset",
        component_id: "tmp:button-component",
        layout: { gap: { token_id: "tmp:spacing-token" } },
        style: { color: { token_id: "tmp:text-token" } },
      },
    },
    {
      type: "move_node",
      node_id: "tmp:card",
      parent: { node_id: "tmp:container" },
      index: 0,
      position: { x: 12.5, y: 18.25 },
    },
    {
      type: "archive_nodes",
      node_ids: ["tmp:obsolete-node"],
    },
    {
      type: "upsert_token",
      token: {
        id: "tmp:surface-token",
        name: "Surface",
        path: "color.surface",
        kind: "color",
        value: "#ffffff",
        archived: false,
        metadata: {},
      },
    },
    {
      type: "upsert_asset",
      asset: {
        id: "tmp:hero-asset",
        name: "Hero",
        kind: "image",
        mime_type: "image/png",
        size_bytes: 128,
        storage_key: "asset:uploaded",
        sha256: "a".repeat(64),
        width: 640,
        height: 360,
        metadata: {},
      },
    },
    {
      type: "insert_template",
      template: "button",
      parent: { page_id: "tmp:checkout-page" },
      overrides: {
        id: "tmp:continue-button",
        name: "Continue",
        text: "Continue",
        layout: { gap: { token_id: "tmp:spacing-token" } },
        style: { fill: { token_id: "tmp:action-token" } },
        metadata: {},
      },
    },
    {
      type: "set_prototype_link",
      link: {
        id: "tmp:continue-link",
        source_node_id: "tmp:continue-button",
        trigger: { type: "click" },
        action: {
          type: "navigate",
          page_id: "tmp:confirmation-page",
          node_id: "tmp:confirmation-frame",
        },
        transition: { type: "dissolve", duration_ms: 180, easing: "ease-out" },
        metadata: {},
      },
    },
    {
      type: "set_metadata",
      target: { kind: "token", id: "tmp:surface-token" },
      metadata: { reviewed: true },
      mode: "merge",
    },
  ];
}

function addUnknownNestedField(operation: Record<string, unknown>): Record<string, unknown> {
  const candidate = structuredClone(operation);
  switch (candidate.type) {
    case "create_page":
      (candidate.page as Record<string, unknown>).unexpected = true;
      break;
    case "create_tree":
      ((candidate.nodes as Array<Record<string, unknown>>)[0] as Record<string, unknown>).unexpected = true;
      break;
    case "update_node":
      (candidate.patch as Record<string, unknown>).unexpected = true;
      break;
    case "move_node":
      (candidate.position as Record<string, unknown>).unexpected = true;
      break;
    case "archive_nodes":
      candidate.unexpected = true;
      break;
    case "upsert_token":
      (candidate.token as Record<string, unknown>).unexpected = true;
      break;
    case "upsert_asset":
      (candidate.asset as Record<string, unknown>).unexpected = true;
      break;
    case "insert_template":
      (candidate.overrides as Record<string, unknown>).unexpected = true;
      break;
    case "set_prototype_link":
      ((candidate.link as Record<string, unknown>).action as Record<string, unknown>).unexpected = true;
      break;
    case "set_metadata":
      (candidate.target as Record<string, unknown>).unexpected = true;
      break;
  }
  return candidate;
}

describe("temporary-ID MCP operation schema", () => {
  it("accepts every strict operation variant with temporary IDs in nested entity-reference positions", () => {
    const operations = temporaryIdOperations();
    expect(operations.map((operation) => operation.type)).toEqual([
      "create_page",
      "create_tree",
      "update_node",
      "move_node",
      "archive_nodes",
      "upsert_token",
      "upsert_asset",
      "insert_template",
      "set_prototype_link",
      "set_metadata",
    ]);
    expect(DesignOperationListSchema.safeParse(operations).success).toBe(false);
    const parsed = McpDesignOperationListSchema.safeParse(operations);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(operations);
  });

  it("retains strict nested unknown-key rejection for every operation variant", () => {
    for (const operation of temporaryIdOperations()) {
      const parsed = McpDesignOperationListSchema.safeParse([addUnknownNestedField(operation)]);
      expect(parsed.success, String(operation.type)).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"), JSON.stringify(parsed.error.issues)).toBe(true);
      }
    }
  });

  it("allows only bounded temporary entity IDs and keeps operation IDs permanent", () => {
    const [createPage] = temporaryIdOperations();
    expect(McpDesignOperationListSchema.safeParse([{
      ...createPage,
      page: { ...(createPage?.page as Record<string, unknown>), id: "tmp:bad/id" },
    }]).success).toBe(false);
    expect(McpDesignOperationListSchema.safeParse([{
      ...createPage,
      page: { ...(createPage?.page as Record<string, unknown>), id: `tmp:${"a".repeat(81)}` },
    }]).success).toBe(false);
    expect(McpDesignOperationListSchema.safeParse([{
      ...createPage,
      operation_id: "tmp:operation",
    }]).success).toBe(false);
  });

  it("keeps server-resolved component insertion out of generic MCP preview operations", () => {
    expect(McpDesignOperationListSchema.safeParse([{
      type: "insert_component_instance",
      parent: { page_id: "page_mcpclone0001" },
      component_definition_id: "component_mcpbutton0001",
      component_version: 1,
      source_hash: "a".repeat(64),
      instance_id: "node_mcpinstance0001",
      active_state: "default",
    }]).success).toBe(false);
  });
});

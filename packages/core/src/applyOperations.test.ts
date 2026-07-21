import { describe, expect, it } from "vitest";

import {
  OperationApplicationError,
  DesignOperationSchema,
  applyOperations,
  createDesignDocument,
  createFrameNode,
  createRectangleNode,
  createSampleDocument,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
  type DesignOperation,
} from "./index.js";

describe("applyOperations", () => {
  it("atomically creates a page and a typed tree in one revision", () => {
    const ids = createSequentialIdFactory("createtree");
    const document = createDesignDocument({ idFactory: ids, now: "2026-07-19T10:00:00.000Z" });
    const pageId = ids("page");
    const text = createTextNode({ content: "Hello", name: "Greeting" }, ids);
    const frame = createFrameNode({ name: "Root", children: [text.id] }, ids);
    const operations: DesignOperation[] = [
      { type: "create_page", page: { id: pageId, name: "Main" } },
      { type: "create_tree", parent: { page_id: pageId }, root_ids: [frame.id], nodes: [frame, text] },
    ];

    const result = applyOperations(document, operations, {
      expectedRevision: 0,
      now: "2026-07-19T11:00:00.000Z",
      idFactory: ids,
    });

    expect(result.document.revision).toBe(1);
    expect(result.document.updated_at).toBe("2026-07-19T11:00:00.000Z");
    expect(result.document.pages[0]?.children).toEqual([frame.id]);
    expect(result.document.nodes[frame.id]).toEqual(frame);
    expect(result.created_ids.pages).toEqual([pageId]);
    expect(result.created_ids.nodes).toEqual([frame.id, text.id]);
    expect(document.pages).toEqual([]);
    expect(document.revision).toBe(0);
  });

  it("rolls the entire batch back when a later operation fails", () => {
    const ids = createSequentialIdFactory("rollback");
    const document = createSampleDocument({ idFactory: ids });
    const original = structuredClone(document);
    const title = Object.values(document.nodes).find((node) => node.type === "text" && node.name === "Title");
    const screen = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "screen");
    const card = Object.values(document.nodes).find((node) => node.type === "frame" && node.name === "Intro card");
    expect(title && screen && card).toBeTruthy();

    expect(() =>
      applyOperations(document, [
        { type: "update_node", node_id: title!.id, patch: { content: "Changed" } },
        { type: "move_node", node_id: screen!.id, parent: { node_id: card!.id } },
      ]),
    ).toThrow(OperationApplicationError);
    expect(document).toEqual(original);
  });

  it("updates common and node-specific fields without replacing the node", () => {
    const ids = createSequentialIdFactory("updateop");
    const document = createSampleDocument({ idFactory: ids });
    const title = Object.values(document.nodes).find((node) => node.type === "text" && node.name === "Title");
    expect(title?.type).toBe("text");

    const result = applyOperations(document, [
      {
        type: "update_node",
        node_id: title!.id,
        patch: {
          content: "Updated title",
          layout: { width: 300 },
          style: { color: "#ff0000" },
          metadata: { source: "test" },
        },
      },
    ]);
    const updated = result.document.nodes[title!.id];

    expect(updated?.type).toBe("text");
    expect(updated?.layout.width).toBe(300);
    expect(updated?.style.color).toBe("#ff0000");
    expect(updated?.metadata).toEqual({ source: "test" });
    if (updated?.type === "text") expect(updated.content).toBe("Updated title");
  });

  it("stores typed accessibility-label edits in the V1 compatibility metadata field", () => {
    const document = createStarterDocument({ idFactory: createSequentialIdFactory("a11ylabel") });
    const frameId = document.pages[0]!.children[0]!;
    document.nodes[frameId]!.metadata.nested = { source: "preserve" };

    const labeled = applyOperations(document, [{
      type: "update_node",
      node_id: frameId,
      patch: { accessibility_label: "Open checkout" },
    }]).document;
    expect(labeled.nodes[frameId]?.metadata.accessible_label).toBe("Open checkout");
    expect(labeled.nodes[frameId]?.metadata.nested).toEqual({ source: "preserve" });

    const cleared = applyOperations(labeled, [{
      type: "update_node",
      node_id: frameId,
      patch: { accessibility_label: null },
    }]).document;
    expect(cleared.nodes[frameId]?.metadata).not.toHaveProperty("accessible_label");
  });

  it("rejects a patch containing fields for another node type", () => {
    const ids = createSequentialIdFactory("badpatch");
    const document = createSampleDocument({ idFactory: ids });
    const frame = Object.values(document.nodes).find((node) => node.type === "frame");

    expect(() =>
      applyOperations(document, [{ type: "update_node", node_id: frame!.id, patch: { content: "Not valid" } }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_patch" }));
  });

  it("moves a node and rejects tree cycles", () => {
    const ids = createSequentialIdFactory("moveop");
    const document = createSampleDocument({ idFactory: ids });
    const screen = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "screen");
    const card = Object.values(document.nodes).find((node) => node.type === "frame" && node.name === "Intro card");
    const body = Object.values(document.nodes).find((node) => node.type === "text" && node.name === "Body");
    expect(screen && card && body).toBeTruthy();

    const moved = applyOperations(document, [
      { type: "move_node", node_id: body!.id, parent: { node_id: screen!.id }, index: 0, position: { x: 12, y: 16 } },
    ]).document;
    const movedScreen = moved.nodes[screen!.id];
    expect(movedScreen?.type === "frame" ? movedScreen.children[0] : undefined).toBe(body!.id);
    expect(moved.nodes[body!.id]?.layout.x).toBe(12);

    expect(() =>
      applyOperations(document, [{ type: "move_node", node_id: screen!.id, parent: { node_id: card!.id } }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_move" }));
  });

  it("archives a subtree and removes prototype links that reference it", () => {
    const ids = createSequentialIdFactory("archiveop");
    const document = createSampleDocument({ idFactory: ids });
    const page = document.pages[0]!;
    const button = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "button")!;
    const labelId = button.type === "frame" ? button.children[0]! : ids("node");
    const linkId = ids("link");
    const result = applyOperations(document, [
      {
        type: "set_prototype_link",
        link: {
          id: linkId,
          source_node_id: button.id,
          trigger: { type: "click" },
          action: { type: "navigate", page_id: page.id },
          metadata: {},
        },
      },
      { type: "archive_nodes", node_ids: [button.id] },
    ]);

    expect(result.document.nodes[button.id]?.archived).toBe(true);
    expect(result.document.nodes[labelId]?.archived).toBe(true);
    expect(result.document.prototype_links[linkId]).toBeUndefined();
  });

  it("upserts tokens and assets and reports their created ids", () => {
    const ids = createSequentialIdFactory("upsertop");
    const document = createStarterDocument({ idFactory: ids });
    const tokenId = ids("token");
    const assetId = ids("asset");
    const result = applyOperations(document, [
      {
        type: "upsert_token",
        token: { id: tokenId, name: "Accent", path: "color.accent", kind: "color", value: "#7c3aed", archived: false, metadata: {} },
      },
      {
        type: "upsert_asset",
        asset: { id: assetId, name: "Hero", kind: "image", mime_type: "image/png", size_bytes: 128, storage_key: "assets/hero.png", metadata: {} },
      },
    ]);

    expect(result.document.tokens[tokenId]?.value).toBe("#7c3aed");
    expect(result.document.assets[assetId]?.storage_key).toBe("assets/hero.png");
    expect(result.created_ids.tokens).toEqual([tokenId]);
    expect(result.created_ids.assets).toEqual([assetId]);
  });

  it("instantiates built-in templates with deterministic ids", () => {
    const ids = createSequentialIdFactory("template");
    const document = createStarterDocument({ idFactory: ids });
    const page = document.pages[0]!;
    const rootId = ids("node");
    const result = applyOperations(
      document,
      [
        {
          type: "insert_template",
          template: "button",
          parent: { page_id: page.id },
          overrides: { id: rootId, text: "Continue", name: "Continue button", layout: { x: 24, y: 24 } },
        },
      ],
      { idFactory: ids },
    );
    const button = result.document.nodes[rootId];

    expect(button?.type).toBe("frame");
    expect(button?.name).toBe("Continue button");
    expect(result.created_ids.nodes).toContain(rootId);
    expect(result.created_ids.nodes).toHaveLength(2);
  });

  it("sets metadata on supported target types", () => {
    const ids = createSequentialIdFactory("metadata");
    const document = createStarterDocument({ idFactory: ids });
    const frameId = document.pages[0]!.children[0]!;
    const result = applyOperations(document, [
      { type: "set_metadata", target: { kind: "document" }, metadata: { owner: "product" } },
      { type: "set_metadata", target: { kind: "node", id: frameId }, metadata: { generated: true } },
    ]);

    expect(result.document.metadata).toEqual({ owner: "product" });
    expect(result.document.nodes[frameId]?.metadata).toEqual({ preset: "web", generated: true });
  });

  it("enforces optimistic revision checks", () => {
    const document = createStarterDocument({ idFactory: createSequentialIdFactory("revision") });
    expect(() => applyOperations(document, [], { expectedRevision: 99 })).toThrowError(
      expect.objectContaining({ code: "revision_conflict", operation_index: -1 }),
    );
  });

  it("keeps no-op applications revision-stable and operation inputs strict", () => {
    const document = createStarterDocument({ idFactory: createSequentialIdFactory("noop") });
    const result = applyOperations(document, []);
    expect(result.document.revision).toBe(document.revision);
    expect(result.applied_operations).toBe(0);
    expect(
      DesignOperationSchema.safeParse({
        type: "archive_nodes",
        node_ids: [document.pages[0]!.children[0]!],
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed trees and duplicate token paths without mutating input", () => {
    const ids = createSequentialIdFactory("invalidops");
    const document = createStarterDocument({ idFactory: ids });
    const page = document.pages[0]!;
    const root = createFrameNode({}, ids);
    const missing = createRectangleNode({}, ids);

    expect(() =>
      applyOperations(document, [
        { type: "create_tree", parent: { page_id: page.id }, root_ids: [root.id], nodes: [{ ...root, children: [missing.id] }] },
      ]),
    ).toThrowError(expect.objectContaining({ code: "invalid_tree" }));

    const firstId = ids("token");
    const secondId = ids("token");
    expect(() =>
      applyOperations(document, [
        { type: "upsert_token", token: { id: firstId, name: "A", path: "color.same", kind: "color", value: "#000000", archived: false, metadata: {} } },
        { type: "upsert_token", token: { id: secondId, name: "B", path: "color.same", kind: "color", value: "#ffffff", archived: false, metadata: {} } },
      ]),
    ).toThrowError(expect.objectContaining({ code: "result_invalid" }));
    expect(document.tokens).toEqual({});
  });
});

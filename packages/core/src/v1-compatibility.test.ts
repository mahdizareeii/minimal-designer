import { describe, expect, it } from "vitest";

import {
  AnyDesignDocumentSchema,
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  createComponentNode,
  createDesignPage,
  createEllipseNode,
  createFrameNode,
  createGroupNode,
  createIconNode,
  createImageNode,
  createInstanceNode,
  createRectangleNode,
  createSequentialIdFactory,
  createTextNode,
  migrateDesignDocumentV1ToV2,
  toV1CompatibleDesignDocument,
  validateDesignDocument,
  type DesignDocument,
} from "./index.js";

function createV1CompatibilityCorpus(): DesignDocument {
  const ids = createSequentialIdFactory("v1corpus");
  const colorTokenId = ids("token");
  const spacingTokenId = ids("token");
  const numberTokenId = ids("token");
  const stringTokenId = ids("token");
  const fontFamilyTokenId = ids("token");
  const fontWeightTokenId = ids("token");
  const durationTokenId = ids("token");

  const rectangle = createRectangleNode({
    name: "Fractional rectangle",
    layout: {
      x: 12.25,
      y: 16.75,
      width: 120.5,
      height: 72.125,
      rotation: 17.5,
      min_width: 44,
      max_width: 240,
      horizontal_constraint: "left-right",
      vertical_constraint: "scale",
    },
    style: {
      fill: { token_id: colorTokenId },
      opacity: 0.875,
      border: { color: "#111827", width: 1.5, style: "dashed" },
      radius: { top_left: 4, top_right: 8, bottom_right: 12, bottom_left: 16 },
      shadows: [{ x: 0, y: 4, blur: 12, spread: 1, color: "rgba(0,0,0,0.2)" }],
      overflow: "hidden",
      cursor: "pointer",
    },
    tags: ["legacy", "fractional"],
    metadata: { source: "v1-corpus" },
  }, ids);
  const ellipse = createEllipseNode({
    name: "Ellipse",
    layout: { x: 180, y: 20, width: 80, height: 80 },
    style: { fill: "#22c55e", pointer_events: "none" },
  }, ids);
  const icon = createIconNode({
    name: "Bundled icon",
    icon_name: "arrow-right",
    label: "Continue",
    layout: { x: 280, y: 20, width: 24, height: 24 },
    style: { color: "#111827" },
  }, ids);
  const absoluteGroup = createGroupNode({
    name: "Absolute group",
    children: [rectangle.id, ellipse.id, icon.id],
    layout: { x: 32, y: 36, width: 360, height: 140, mode: "absolute" },
  }, ids);

  const ltrText = createTextNode({
    name: "Mixed direction text",
    content: "Order سفارش #42",
    direction: "auto",
    layout: { width: 240, height: 48, width_sizing: "fill", height_sizing: "hug" },
    style: {
      color: "#111827",
      typography: {
        font_family: { token_id: fontFamilyTokenId },
        font_size: 16,
        font_weight: { token_id: fontWeightTokenId },
        line_height: 24,
        letter_spacing: 0.1,
        text_align: "start",
      },
    },
  }, ids);
  const gridRectangle = createRectangleNode({
    name: "Grid item",
    layout: { width: 120, height: 64, width_sizing: "fill" },
    style: { fill: "#f3f4f6", radius: 10 },
  }, ids);
  const grid = createGroupNode({
    name: "Simple grid",
    children: [ltrText.id, gridRectangle.id],
    layout: {
      x: 32,
      y: 196,
      width: 560,
      height: 120,
      mode: "grid",
      columns: 2,
      row_gap: { token_id: spacingTokenId },
      column_gap: 20,
      padding: { top: 12, right: 16, bottom: 12, left: 16 },
      align_items: "center",
    },
  }, ids);

  const componentLabel = createTextNode({
    name: "Component label",
    content: "Save",
    layout: { width: 64, height: 24, width_sizing: "hug", height_sizing: "hug" },
    style: { color: "#ffffff", typography: { font_size: 15, font_weight: 600 } },
  }, ids);
  const component = createComponentNode({
    name: "Primary button",
    component_key: "button.primary",
    description: "Legacy project-local button definition.",
    children: [componentLabel.id],
    layout: {
      x: 32,
      y: 340,
      width: 160,
      height: 48,
      mode: "horizontal",
      gap: 8,
      padding: 12,
      align_items: "center",
      justify_content: "center",
    },
    style: { fill: { token_id: colorTokenId }, radius: 12 },
  }, ids);
  const instance = createInstanceNode({
    name: "Primary button instance",
    component_id: component.id,
    overrides: {
      label: "Continue",
      nested: { emphasis: true, count: 2 },
    },
    layout: { x: 216, y: 340, width: 160, height: 48 },
  }, ids);

  const pngAssetId = ids("asset");
  const gifAssetId = ids("asset");
  const fontAssetId = ids("asset");
  const videoAssetId = ids("asset");
  const binaryAssetId = ids("asset");
  const image = createImageNode({
    name: "Normalized image",
    asset_id: pngAssetId,
    alt: "A deterministic fixture",
    object_fit: "contain",
    layout: { x: 408, y: 340, width: 184, height: 120 },
    style: { object_position: "50% 25%", radius: 8 },
  }, ids);
  const webFrame = createFrameNode({
    name: "Web frame",
    role: "main",
    children: [absoluteGroup.id, grid.id, component.id, instance.id, image.id],
    clip_content: true,
    layout: { width: 1200, height: 800, mode: "absolute" },
    style: { fill: "#ffffff" },
    metadata: { locale: "en-GB", text_direction: "ltr", breakpoint: "desktop" },
  }, ids);

  const rtlText = createTextNode({
    name: "Persian heading",
    content: "بررسی سفارش",
    direction: "rtl",
    layout: { width: 320, height: 48, width_sizing: "fill", height_sizing: "hug" },
    style: {
      color: "#111827",
      typography: { font_family: "Vazirmatn", font_size: 28, font_weight: 700, text_align: "start" },
    },
  }, ids);
  const rtlFrame = createFrameNode({
    name: "RTL phone frame",
    role: "screen",
    children: [rtlText.id],
    clip_content: true,
    layout: {
      width: 390,
      height: 844,
      mode: "vertical",
      gap: { token_id: spacingTokenId },
      padding: { token_id: spacingTokenId },
      align_items: "stretch",
      justify_content: "start",
    },
    style: { fill: "#f8fafc", overflow: "clip" },
    metadata: { locale: "fa-IR", text_direction: "rtl" },
  }, ids);
  const archivedRectangle = createRectangleNode({
    name: "Archived detached node",
    archived: true,
    visible: false,
    locked: true,
    layout: { x: -10.5, y: -20.25, width: 10, height: 10 },
    metadata: { archived_reason: "fixture" },
  }, ids);

  const webPage = createDesignPage({
    name: "Desktop",
    children: [webFrame.id],
    background: { token_id: colorTokenId },
    viewport: { width: 1440, height: 900 },
    metadata: { locale: "en-GB", text_direction: "ltr" },
  }, ids);
  const rtlPage = createDesignPage({
    name: "Persian",
    children: [rtlFrame.id],
    background: "#e2e8f0",
    viewport: { width: 800, height: 1000 },
    metadata: { locale: "fa-IR", text_direction: "rtl" },
  }, ids);

  const navigateLinkId = ids("link");
  const overlayLinkId = ids("link");
  const backLinkId = ids("link");
  const urlLinkId = ids("link");
  const delayLinkId = ids("link");

  return DesignDocumentSchema.parse({
    schema_version: 1,
    id: ids("document"),
    name: "Complete V1 compatibility corpus",
    revision: 19,
    pages: [webPage, rtlPage],
    nodes: Object.fromEntries([
      webFrame,
      absoluteGroup,
      rectangle,
      ellipse,
      icon,
      grid,
      ltrText,
      gridRectangle,
      component,
      componentLabel,
      instance,
      image,
      rtlFrame,
      rtlText,
      archivedRectangle,
    ].map((node) => [node.id, node])),
    tokens: {
      [colorTokenId]: { id: colorTokenId, name: "Brand", path: "color.brand", kind: "color", value: "#2457ff", description: "Brand blue", archived: false, metadata: { source: "legacy" } },
      [spacingTokenId]: { id: spacingTokenId, name: "Spacing", path: "space.md", kind: "dimension", value: 16, archived: false, metadata: { unit: "px" } },
      [numberTokenId]: { id: numberTokenId, name: "Opacity", path: "opacity.muted", kind: "number", value: 0.64, archived: false, metadata: {} },
      [stringTokenId]: { id: stringTokenId, name: "Label", path: "content.cta", kind: "string", value: "Continue", archived: false, metadata: {} },
      [fontFamilyTokenId]: { id: fontFamilyTokenId, name: "Body font", path: "font.body", kind: "font_family", value: "Inter", archived: false, metadata: {} },
      [fontWeightTokenId]: { id: fontWeightTokenId, name: "Strong", path: "font.weight.strong", kind: "font_weight", value: 700, archived: false, metadata: {} },
      [durationTokenId]: { id: durationTokenId, name: "Fast", path: "motion.fast", kind: "duration", value: 160, archived: true, metadata: { unit: "ms" } },
    },
    assets: {
      [pngAssetId]: { id: pngAssetId, name: "photo.png", kind: "image", mime_type: "image/png", size_bytes: 128, storage_key: `asset:${pngAssetId}`, sha256: "a".repeat(64), width: 320, height: 180, metadata: { normalized: true } },
      [gifAssetId]: { id: gifAssetId, name: "legacy.gif", kind: "image", mime_type: "image/gif", size_bytes: 64, storage_key: "legacy/uploads/legacy.gif", sha256: "b".repeat(64), width: 24, height: 24, metadata: { animated: false } },
      [fontAssetId]: { id: fontAssetId, name: "legacy.woff2", kind: "font", mime_type: "font/woff2", size_bytes: 256, storage_key: "legacy/fonts/legacy.woff2", sha256: "c".repeat(64), metadata: { family: "Legacy Sans" } },
      [videoAssetId]: { id: videoAssetId, name: "walkthrough.mp4", kind: "video", mime_type: "video/mp4", size_bytes: 512, storage_key: "legacy/video/walkthrough.mp4", sha256: "d".repeat(64), metadata: {} },
      [binaryAssetId]: { id: binaryAssetId, name: "payload.bin", kind: "binary", mime_type: "application/octet-stream", size_bytes: 8, storage_key: "legacy/binary/payload.bin", metadata: { quarantined: true } },
    },
    prototype_links: {
      [navigateLinkId]: { id: navigateLinkId, source_node_id: component.id, trigger: { type: "click" }, action: { type: "navigate", page_id: rtlPage.id, node_id: rtlFrame.id }, transition: { type: "slide", duration_ms: 240, easing: "ease-out", direction: "left" }, metadata: { order: 1 } },
      [overlayLinkId]: { id: overlayLinkId, source_node_id: image.id, trigger: { type: "hover" }, action: { type: "open_overlay", page_id: rtlPage.id, node_id: rtlFrame.id }, transition: { type: "dissolve", duration_ms: 120, easing: "linear" }, metadata: {} },
      [backLinkId]: { id: backLinkId, source_node_id: icon.id, trigger: { type: "press" }, action: { type: "back" }, metadata: {} },
      [urlLinkId]: { id: urlLinkId, source_node_id: instance.id, trigger: { type: "drag" }, action: { type: "url", url: "https://example.com/handoff" }, metadata: {} },
      [delayLinkId]: { id: delayLinkId, source_node_id: rtlText.id, trigger: { type: "after_delay", delay_ms: 900 }, action: { type: "navigate", page_id: webPage.id, node_id: webFrame.id }, transition: { type: "instant", duration_ms: 0, easing: "ease" }, metadata: {} },
    },
    metadata: {
      product_brief: "Preserve every V1 field and stable identifier.",
      nested: { flags: [true, false, null], count: 2 },
    },
    created_at: "2025-01-02T03:04:05.000Z",
    updated_at: "2026-07-20T09:10:11.000Z",
  });
}

describe("strict V1 compatibility corpus", () => {
  it("reads a complete historical V1 document without normalizing fields or IDs", () => {
    const source = createV1CompatibilityCorpus();
    const serialized = JSON.stringify(source);
    const parsed = AnyDesignDocumentSchema.parse(JSON.parse(serialized) as unknown);

    expect(parsed.schema_version).toBe(1);
    expect(parsed).toEqual(source);
    expect(validateDesignDocument(parsed).success).toBe(true);
    expect(new Set(Object.values(parsed.nodes).map((node) => node.type))).toEqual(new Set([
      "frame",
      "group",
      "component",
      "instance",
      "rectangle",
      "ellipse",
      "text",
      "image",
      "icon",
    ]));
    expect(new Set(Object.values(parsed.tokens).map((token) => token.kind))).toEqual(new Set([
      "color",
      "dimension",
      "number",
      "string",
      "font_family",
      "font_weight",
      "duration",
    ]));
  });

  it("migrates deterministically and projects back byte-for-byte-equivalent V1 data", () => {
    const source = createV1CompatibilityCorpus();
    const options = {
      migratedAt: "2026-07-20T10:00:00.000Z",
      sourceRevisionId: "revision_v1corpus_00000001",
      sourceSnapshotHash: "e".repeat(64),
      verifiedBackupId: "backup_v1corpus_00000001",
    };
    const first = migrateDesignDocumentV1ToV2(source, options);
    const second = migrateDesignDocumentV1ToV2(source, options);

    expect(first).toEqual(second);
    expect(first.id).toBe(source.id);
    expect(first.revision).toBe(source.revision);
    expect(first.pages.map((page) => page.id)).toEqual(source.pages.map((page) => page.id));
    expect(Object.keys(first.nodes).sort()).toEqual(Object.keys(source.nodes).sort());
    expect(Object.keys(first.tokens).sort()).toEqual(Object.keys(source.tokens).sort());
    expect(Object.keys(first.assets).sort()).toEqual(Object.keys(source.assets).sort());
    expect(Object.keys(first.prototype_links).sort()).toEqual(Object.keys(source.prototype_links).sort());
    expect(first.migration?.quarantined_asset_ids.sort()).toEqual(
      Object.values(source.assets).filter((asset) => asset.mime_type !== "image/png").map((asset) => asset.id).sort(),
    );
    expect(first.migration?.diagnostics.filter((item) => item.code === "LEGACY_COMPONENT_OVERRIDES_QUARANTINED")).toHaveLength(1);
    expect(toV1CompatibleDesignDocument(first)).toEqual(source);
  });

  it("keeps unsupported legacy assets quarantined and forbids promoting them to ready", () => {
    const source = createV1CompatibilityCorpus();
    const migrated = migrateDesignDocumentV1ToV2(source, { migratedAt: "2026-07-20T10:00:00.000Z" });
    const font = Object.values(migrated.assets).find((asset) => asset.kind === "font");
    expect(font).toMatchObject({ kind: "font", mime_type: "font/woff2", status: "legacy_quarantined" });
    if (!font) throw new Error("Expected the V1 font asset to be preserved.");

    const invalid = structuredClone(migrated);
    invalid.assets[font.id] = { ...font, status: "ready", width: 1, height: 1, sha256: "f".repeat(64) };
    expect(DesignDocumentV2Schema.safeParse(invalid).success).toBe(false);
  });

  it("rejects V2 fields or arbitrary properties at nested V1 boundaries", () => {
    const source = createV1CompatibilityCorpus();
    const rootId = source.pages[0]!.children[0]!;
    const tokenId = Object.keys(source.tokens)[0]!;
    const assetId = Object.keys(source.assets)[0]!;
    const linkId = Object.keys(source.prototype_links)[0]!;

    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.component_definitions = {}; },
      (value) => { ((value.pages as Array<Record<string, unknown>>)[0]!).locale = "fa-IR"; },
      (value) => { ((value.nodes as Record<string, Record<string, unknown>>)[rootId]!).semantics = { role: "main" }; },
      (value) => { (((value.nodes as Record<string, Record<string, unknown>>)[rootId]!).layout as Record<string, unknown>).unknown_constraint = true; },
      (value) => { (((value.nodes as Record<string, Record<string, unknown>>)[rootId]!).style as Record<string, unknown>).gradient = []; },
      (value) => { ((value.tokens as Record<string, Record<string, unknown>>)[tokenId]!).layer = "primitive"; },
      (value) => { ((value.assets as Record<string, Record<string, unknown>>)[assetId]!).status = "ready"; },
      (value) => { ((value.prototype_links as Record<string, Record<string, unknown>>)[linkId]!).condition = "unsafe"; },
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(source) as unknown as Record<string, unknown>;
      mutate(candidate);
      expect(DesignDocumentSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("keeps semantic validation separate and rejects corrupt V1 graph references", () => {
    const source = createV1CompatibilityCorpus();
    const duplicateParent = structuredClone(source);
    duplicateParent.pages[1]!.children.push(duplicateParent.pages[0]!.children[0]!);
    const mismatch = structuredClone(source) as unknown as { nodes: Record<string, Record<string, unknown>> };
    const nodeId = Object.keys(mismatch.nodes)[0]!;
    mismatch.nodes[nodeId]!.id = "node_v1corpus_replaced";

    expect(DesignDocumentSchema.safeParse(duplicateParent).success).toBe(true);
    expect(validateDesignDocument(duplicateParent).diagnostics.some((item) => item.code === "multiple_parents")).toBe(true);
    expect(DesignDocumentSchema.safeParse(mismatch).success).toBe(true);
    expect(validateDesignDocument(mismatch).diagnostics.some((item) => item.code === "node_key_mismatch")).toBe(true);
  });
});

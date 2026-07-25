import { describe, expect, it } from "vitest";

import {
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  OperationApplicationError,
  ResponsiveBreakpointSchema,
  ResponsiveFrameVariantSchema,
  applyOperations,
  createDesignDocument,
  createDesignPage,
  createFrameNode,
  createRectangleNode,
  createSequentialIdFactory,
  mergeV1CompatibilityDocument,
  migrateDesignDocumentV1ToV2,
  toV1CompatibleDesignDocument,
  validateDesignDocument,
  type DesignDocument,
  type FrameNode,
  type NodeId,
  type ResponsiveFrameVariant,
} from "./index.js";

const GROUP_ID = "responsive_checkout_flow_01";

interface ResponsiveFixture {
  document: DesignDocument;
  frames: [FrameNode, FrameNode, FrameNode];
}

function relationship(
  frameIds: readonly NodeId[],
  breakpoint: ResponsiveFrameVariant["breakpoint"],
): ResponsiveFrameVariant {
  return {
    group_id: GROUP_ID,
    frame_ids: [...frameIds],
    breakpoint,
  };
}

function createResponsiveFixture(linked = true): ResponsiveFixture {
  const ids = createSequentialIdFactory("responsiveframes");
  const frameIds = [ids("node"), ids("node"), ids("node")] as const;
  const definitions = [
    { name: "Phone", width: 390, breakpoint: { min_width: 0, max_width: 600 } },
    { name: "Tablet", width: 834, breakpoint: { min_width: 600, max_width: 1_024 } },
    { name: "Desktop", width: 1_440, breakpoint: { min_width: 1_024 } },
  ] as const;
  const frames = definitions.map((definition, index) => createFrameNode({
    id: frameIds[index],
    name: definition.name,
    role: "screen",
    layout: { x: index * 1_600, width: definition.width, height: 900 },
    ...(linked ? { responsive_variant: relationship(frameIds, definition.breakpoint) } : {}),
  }, ids)) as [FrameNode, FrameNode, FrameNode];
  const page = createDesignPage({ name: "Checkout", children: [...frameIds] }, ids);
  const base = createDesignDocument({ name: "Responsive checkout", idFactory: ids, now: "2026-07-25T09:00:00.000Z" });
  const document = DesignDocumentSchema.parse({
    ...base,
    pages: [page],
    nodes: Object.fromEntries(frames.map((frame) => [frame.id, frame])),
  });
  return { document, frames };
}

function responsive(frame: FrameNode | undefined): ResponsiveFrameVariant {
  if (!frame?.responsive_variant) throw new Error("Expected a responsive frame relationship");
  return frame.responsive_variant;
}

describe("linked responsive frame variants", () => {
  it("strictly validates group IDs, ordered unique members, and breakpoint ranges", () => {
    const { frames } = createResponsiveFixture(false);
    const frameIds = frames.map((frame) => frame.id);
    expect(ResponsiveFrameVariantSchema.parse({
      group_id: GROUP_ID,
      frame_ids: frameIds,
    })).toEqual({
      group_id: GROUP_ID,
      frame_ids: frameIds,
      breakpoint: { min_width: 0 },
    });
    expect(ResponsiveFrameVariantSchema.safeParse({
      group_id: "group_invalid",
      frame_ids: frameIds,
      breakpoint: { min_width: 0 },
    }).success).toBe(false);
    expect(ResponsiveFrameVariantSchema.safeParse({
      group_id: GROUP_ID,
      frame_ids: [frameIds[0], frameIds[0]],
      breakpoint: { min_width: 0 },
    }).success).toBe(false);
    expect(ResponsiveBreakpointSchema.safeParse({ min_width: 600, max_width: 600 }).success).toBe(false);
    expect(ResponsiveBreakpointSchema.safeParse({ min_width: 0, max_width: 600, unit: "px" }).success).toBe(false);
  });

  it("requires reciprocal group membership and one identical member order", () => {
    const { document, frames } = createResponsiveFixture();
    expect(validateDesignDocument(document).success).toBe(true);

    const reversed = structuredClone(document);
    const reversedFrame = reversed.nodes[frames[1].id];
    if (!reversedFrame || reversedFrame.type !== "frame") throw new Error("Expected frame fixture");
    responsive(reversedFrame).frame_ids.reverse();
    expect(validateDesignDocument(reversed).diagnostics.map((item) => item.code))
      .toContain("responsive_frame_reciprocity_mismatch");

    const incomplete = structuredClone(document);
    for (const frameId of [frames[0].id, frames[1].id, frames[2].id]) {
      const frame = incomplete.nodes[frameId];
      if (!frame || frame.type !== "frame") throw new Error("Expected frame fixture");
      frame.responsive_variant = relationship([frames[0].id, frames[1].id], responsive(frame).breakpoint);
    }
    const codes = validateDesignDocument(incomplete).diagnostics.map((item) => item.code);
    expect(codes).toContain("responsive_frame_owner_missing");
    expect(codes).toContain("responsive_frame_membership_mismatch");
  });

  it("requires every linked frame to resolve to the same active page in V1 and V2", () => {
    const { document, frames } = createResponsiveFixture();
    const secondPage = createDesignPage({ name: "Other" }, createSequentialIdFactory("responsiveotherpage"));
    document.pages[0]!.children = document.pages[0]!.children.filter((id) => id !== frames[2].id);
    secondPage.children.push(frames[2].id);
    document.pages.push(secondPage);
    expect(validateDesignDocument(document).diagnostics.map((item) => item.code))
      .toContain("responsive_frame_page_mismatch");

    const validV2 = migrateDesignDocumentV1ToV2(createResponsiveFixture().document, {
      migratedAt: "2026-07-25T10:00:00.000Z",
    });
    const invalidV2 = structuredClone(validV2);
    const movedFrameId = invalidV2.pages[0]!.children.pop();
    if (!movedFrameId) throw new Error("Expected frame fixture");
    invalidV2.pages.push({
      id: secondPage.id,
      name: secondPage.name,
      children: [movedFrameId],
      background: secondPage.background,
      locale: "en",
      text_direction: "auto",
      archived: false,
      metadata: {},
    });
    expect(DesignDocumentV2Schema.safeParse(invalidV2).success).toBe(false);
  });

  it("treats breakpoint ranges as ordered half-open intervals", () => {
    const { document, frames } = createResponsiveFixture();
    expect(validateDesignDocument(document).success).toBe(true);

    const overlap = structuredClone(document);
    const phone = overlap.nodes[frames[0].id];
    if (!phone || phone.type !== "frame") throw new Error("Expected frame fixture");
    responsive(phone).breakpoint.max_width = 601;
    expect(validateDesignDocument(overlap).diagnostics.map((item) => item.code))
      .toContain("responsive_breakpoint_overlap");

    const openEndedBeforeFinal = structuredClone(document);
    const first = openEndedBeforeFinal.nodes[frames[0].id];
    if (!first || first.type !== "frame") throw new Error("Expected frame fixture");
    delete responsive(first).breakpoint.max_width;
    expect(validateDesignDocument(openEndedBeforeFinal).diagnostics.map((item) => item.code))
      .toContain("responsive_breakpoint_open_ended");

    const gapped = structuredClone(document);
    const tablet = gapped.nodes[frames[1].id];
    if (!tablet || tablet.type !== "frame") throw new Error("Expected frame fixture");
    responsive(tablet).breakpoint.min_width = 700;
    expect(validateDesignDocument(gapped).success).toBe(true);
  });

  it("deterministically removes archived members and clears a lone survivor", () => {
    const fixture = createResponsiveFixture();
    const reordered = structuredClone(fixture.document);
    reordered.nodes = Object.fromEntries(Object.entries(reordered.nodes).reverse());

    const archiveMiddle = [{ type: "archive_nodes" as const, node_ids: [fixture.frames[1].id] }];
    const first = applyOperations(fixture.document, archiveMiddle, { now: "2026-07-25T11:00:00.000Z" }).document;
    const second = applyOperations(reordered, archiveMiddle, { now: "2026-07-25T11:00:00.000Z" }).document;
    const survivingIds = [fixture.frames[0].id, fixture.frames[2].id];
    for (const frameId of survivingIds) {
      const firstFrame = first.nodes[frameId];
      const secondFrame = second.nodes[frameId];
      if (firstFrame?.type !== "frame" || secondFrame?.type !== "frame") throw new Error("Expected frame fixture");
      expect(responsive(firstFrame).frame_ids).toEqual(survivingIds);
      expect(responsive(secondFrame).frame_ids).toEqual(survivingIds);
    }
    const archivedMiddle = first.nodes[fixture.frames[1].id];
    expect(archivedMiddle).toMatchObject({ archived: true });
    if (archivedMiddle?.type !== "frame") throw new Error("Expected frame fixture");
    expect(responsive(archivedMiddle).frame_ids).toEqual(fixture.frames.map((frame) => frame.id));
    expect(validateDesignDocument(first).success).toBe(true);

    const lone = applyOperations(first, [{ type: "archive_nodes", node_ids: [fixture.frames[2].id] }], {
      now: "2026-07-25T12:00:00.000Z",
    }).document;
    const survivor = lone.nodes[fixture.frames[0].id];
    expect(survivor?.type).toBe("frame");
    if (survivor?.type === "frame") expect(survivor.responsive_variant).toBeUndefined();
    expect(validateDesignDocument(lone).success).toBe(true);
  });

  it("applies relationship updates atomically and rejects partial or incompatible patches", () => {
    const fixture = createResponsiveFixture(false);
    const frameIds = fixture.frames.map((frame) => frame.id);
    const variants = [
      relationship(frameIds, { min_width: 0, max_width: 600 }),
      relationship(frameIds, { min_width: 600, max_width: 1_024 }),
      relationship(frameIds, { min_width: 1_024 }),
    ];

    expect(() => applyOperations(fixture.document, [{
      type: "update_node",
      node_id: frameIds[0],
      patch: { responsive_variant: variants[0] },
    }])).toThrowError(expect.objectContaining({ code: "result_invalid" }));

    const linked = applyOperations(fixture.document, frameIds.map((nodeId, index) => ({
      type: "update_node" as const,
      node_id: nodeId,
      patch: { responsive_variant: variants[index] },
    })), { now: "2026-07-25T13:00:00.000Z" }).document;
    expect(validateDesignDocument(linked).success).toBe(true);

    const adjusted = applyOperations(linked, [{
      type: "update_node",
      node_id: frameIds[1],
      patch: { responsive_variant: relationship(frameIds, { min_width: 600, max_width: 900 }) },
    }], { now: "2026-07-25T14:00:00.000Z" }).document;
    const adjustedTablet = adjusted.nodes[frameIds[1]];
    if (adjustedTablet?.type !== "frame") throw new Error("Expected frame fixture");
    expect(responsive(adjustedTablet).breakpoint).toEqual({ min_width: 600, max_width: 900 });

    expect(() => applyOperations(linked, [{
      type: "update_node",
      node_id: frameIds[0],
      patch: { responsive_variant: relationship(frameIds, { min_width: 0, max_width: 601 }) },
    }])).toThrowError(expect.objectContaining({ code: "result_invalid" }));
    const unchangedPhone = linked.nodes[frameIds[0]];
    if (unchangedPhone?.type !== "frame") throw new Error("Expected frame fixture");
    expect(responsive(unchangedPhone).breakpoint.max_width).toBe(600);

    const rectangle = createRectangleNode({}, createSequentialIdFactory("responsivepatchrectangle"));
    const withRectangle = structuredClone(linked);
    withRectangle.nodes[rectangle.id] = rectangle;
    withRectangle.pages[0]!.children.push(rectangle.id);
    expect(() => applyOperations(withRectangle, [{
      type: "update_node",
      node_id: rectangle.id,
      patch: { responsive_variant: variants[0] },
    }])).toThrowError(expect.objectContaining({ code: "invalid_patch" }));

    const cleared = applyOperations(linked, frameIds.map((nodeId) => ({
      type: "update_node" as const,
      node_id: nodeId,
      patch: { responsive_variant: null },
    }))).document;
    expect(frameIds.every((frameId) => {
      const frame = cleared.nodes[frameId];
      return frame?.type === "frame" && frame.responsive_variant === undefined;
    })).toBe(true);
  });

  it("preserves relationships exactly through V1 migration and V2 projection", () => {
    const { document } = createResponsiveFixture();
    const migrated = migrateDesignDocumentV1ToV2(document, {
      migratedAt: "2026-07-25T15:00:00.000Z",
    });
    expect(toV1CompatibleDesignDocument(migrated)).toEqual(document);
    for (const [nodeId, sourceNode] of Object.entries(document.nodes)) {
      if (sourceNode.type !== "frame") continue;
      const migratedNode = migrated.nodes[nodeId];
      expect(migratedNode?.type).toBe("frame");
      if (migratedNode?.type === "frame") {
        expect(migratedNode.responsive_variant).toEqual(sourceNode.responsive_variant);
      }
    }
  });

  it("merges V1 responsive edits without discarding V2-only frame fields", () => {
    const fixture = createResponsiveFixture();
    const migrated = migrateDesignDocumentV1ToV2(fixture.document, {
      migratedAt: "2026-07-25T15:30:00.000Z",
    });
    const tabletId = fixture.frames[1].id;
    const v2Tablet = migrated.nodes[tabletId];
    if (v2Tablet?.type !== "frame") throw new Error("Expected frame fixture");
    v2Tablet.screen_purpose = "Preserve the checkout review purpose.";
    const strictBase = DesignDocumentV2Schema.parse(migrated);
    const projected = toV1CompatibleDesignDocument(strictBase);
    const edited = applyOperations(projected, [{
      type: "update_node",
      node_id: tabletId,
      patch: {
        responsive_variant: relationship(fixture.frames.map((frame) => frame.id), {
          min_width: 600,
          max_width: 960,
        }),
      },
    }], { now: "2026-07-25T16:00:00.000Z" }).document;

    const merged = mergeV1CompatibilityDocument(strictBase, edited);
    const mergedTablet = merged.nodes[tabletId];
    expect(mergedTablet?.type).toBe("frame");
    if (mergedTablet?.type === "frame") {
      expect(mergedTablet.screen_purpose).toBe("Preserve the checkout review purpose.");
      expect(mergedTablet.responsive_variant?.breakpoint).toEqual({ min_width: 600, max_width: 960 });
    }
    expect(toV1CompatibleDesignDocument(merged)).toEqual(edited);
  });

  it("surfaces operation failures as typed core errors", () => {
    const fixture = createResponsiveFixture(false);
    try {
      applyOperations(fixture.document, [{
        type: "update_node",
        node_id: fixture.frames[0].id,
        patch: {
          responsive_variant: relationship(fixture.frames.map((frame) => frame.id), {
            min_width: 0,
            max_width: 600,
          }),
        },
      }]);
      throw new Error("Expected a responsive relationship failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationApplicationError);
      expect(error).toMatchObject({ code: "result_invalid", operation_index: 0 });
    }
  });
});

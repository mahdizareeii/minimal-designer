import {
  DesignDocumentSchema,
  createDesignDocument,
  createDesignPage,
  createFrameNode,
  createRectangleNode,
  createSequentialIdFactory,
  createTextNode,
  type DesignDocument,
  type DesignNode,
  type DesignOperation,
  type NodeId,
} from "@designer/core";

export const PERFORMANCE_NODE_COUNT = 1_000;
export const PERFORMANCE_CARD_COUNT = 100;
export const PERFORMANCE_LEAF_COUNT = PERFORMANCE_NODE_COUNT - PERFORMANCE_CARD_COUNT - 1;
export const PERFORMANCE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export interface ThousandNodeFixture {
  document: DesignDocument;
  rootId: NodeId;
  mutableLeafIds: NodeId[];
}

function leavesInCard(cardIndex: number): number {
  return cardIndex === PERFORMANCE_CARD_COUNT - 1 ? 8 : 9;
}

export function createThousandNodeFixture(): ThousandNodeFixture {
  const idFactory = createSequentialIdFactory("perf1000");
  const document = createDesignDocument({
    name: "FormaSpec 1,000-node performance fixture",
    now: PERFORMANCE_TIMESTAMP,
    idFactory,
    withPage: false,
  });
  const root = createFrameNode({
    name: "Performance canvas",
    role: "screen",
    clip_content: true,
    layout: { width: 1_440, height: 900 },
    style: { fill: "#f3f4f6" },
    metadata: { fixture: "performance-1000", deterministic: true },
  }, idFactory);
  const nodes: Record<string, DesignNode> = { [root.id]: root };
  const mutableLeafIds: NodeId[] = [];
  let leafIndex = 0;

  for (let cardIndex = 0; cardIndex < PERFORMANCE_CARD_COUNT; cardIndex += 1) {
    const childIds: NodeId[] = [];
    for (let localIndex = 0; localIndex < leavesInCard(cardIndex); localIndex += 1) {
      const isText = leafIndex % 3 === 0;
      const leaf = isText
        ? createTextNode({
          name: `Label ${String(leafIndex + 1).padStart(4, "0")}`,
          content: `Item ${leafIndex + 1}`,
          direction: leafIndex % 12 === 0 ? "rtl" : "ltr",
          layout: {
            width: 124,
            height: 6,
            width_sizing: "fill",
            height_sizing: "fixed",
          },
          style: {
            color: "#111827",
            typography: { font_family: "Inter", font_size: 6, line_height: 6 },
          },
          metadata: { fixture_index: leafIndex },
        }, idFactory)
        : createRectangleNode({
          name: `Bar ${String(leafIndex + 1).padStart(4, "0")}`,
          layout: {
            width: 124,
            height: 6,
            width_sizing: "fill",
            height_sizing: "fixed",
          },
          style: {
            fill: leafIndex % 2 === 0 ? "#2563eb" : "#cbd5e1",
            radius: 2,
          },
          metadata: { fixture_index: leafIndex },
        }, idFactory);
      nodes[leaf.id] = leaf;
      childIds.push(leaf.id);
      if (mutableLeafIds.length < 25) mutableLeafIds.push(leaf.id);
      leafIndex += 1;
    }

    const card = createFrameNode({
      name: `Card ${String(cardIndex + 1).padStart(3, "0")}`,
      children: childIds,
      role: "section",
      layout: {
        x: 20 + (cardIndex % 10) * 140,
        y: 20 + Math.floor(cardIndex / 10) * 84,
        width: 132,
        height: 76,
        mode: "vertical",
        width_sizing: "fixed",
        height_sizing: "fixed",
        gap: 1,
        padding: 4,
        align_items: "stretch",
      },
      style: {
        fill: "#ffffff",
        radius: 6,
      },
      metadata: { fixture_card_index: cardIndex },
    }, idFactory);
    nodes[card.id] = card;
    root.children.push(card.id);
  }

  if (leafIndex !== PERFORMANCE_LEAF_COUNT) {
    throw new Error(`Performance fixture created ${leafIndex} leaves instead of ${PERFORMANCE_LEAF_COUNT}.`);
  }

  const page = createDesignPage({
    name: "Performance",
    children: [root.id],
    background: "#e5e7eb",
    viewport: { width: 1_440, height: 900 },
    metadata: { fixture: "performance-1000" },
  }, idFactory);
  const parsed = DesignDocumentSchema.parse({
    ...document,
    pages: [page],
    nodes,
  });
  const nodeCount = Object.keys(parsed.nodes).length;
  if (nodeCount !== PERFORMANCE_NODE_COUNT) {
    throw new Error(`Performance fixture created ${nodeCount} nodes instead of ${PERFORMANCE_NODE_COUNT}.`);
  }

  return { document: parsed, rootId: root.id, mutableLeafIds };
}

export function createCoreUpdateOperations(fixture: ThousandNodeFixture): DesignOperation[] {
  return fixture.mutableLeafIds.map((nodeId, index) => ({
    type: "update_node",
    node_id: nodeId,
    patch: {
      name: `Updated benchmark node ${String(index + 1).padStart(2, "0")}`,
      metadata: { benchmark_update: index + 1 },
    },
  }));
}

export function createServerTreeOperation(
  fixture: ThousandNodeFixture,
  targetRootId: NodeId,
): Extract<DesignOperation, { type: "create_tree" }> {
  const sourceRoot = fixture.document.nodes[fixture.rootId];
  if (sourceRoot?.type !== "frame") throw new Error("The performance fixture root must be a frame.");
  const nodes = Object.values(fixture.document.nodes).filter((node) => node.id !== fixture.rootId);
  return {
    type: "create_tree",
    parent: { node_id: targetRootId },
    root_ids: [...sourceRoot.children],
    nodes,
  };
}

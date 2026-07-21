import {
  createEllipseNode,
  createFrameNode,
  createGroupNode,
  createImageNode,
  createRectangleNode,
  createTextNode,
  type DesignDocument,
  type NodeId,
} from "@designer/core";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "playwright/test";

const ALIGNMENT_TOLERANCE_CSS_PX = 0.75;

interface FixtureDesign {
  designId: string;
  ltrNode: { id: NodeId; name: string };
  rtlNode: { id: NodeId; name: string };
  mixedNode: { id: NodeId; name: string };
  imageNode: { id: NodeId; name: string };
  rotatedRtlNode: { id: NodeId; name: string };
  frameNode: { id: NodeId; name: string };
  ellipseNode: { id: NodeId; name: string };
  rotatedMultiNodes: Array<{ id: NodeId; name: string }>;
  hiddenNode: { id: NodeId; name: string };
  lockedNode: { id: NodeId; name: string };
  multiNodes: Array<{ id: NodeId; name: string }>;
}

interface AutoLayoutFixture {
  designId: string;
  version: number;
  sourceId: NodeId;
  destinationId: NodeId;
  reorderNode: { id: NodeId; name: string; x: number; y: number };
  resizeNode: { id: NodeId; name: string; x: number; y: number; rotation: number };
  tailNode: { id: NodeId; name: string };
  destinationNode: { id: NodeId; name: string };
}

interface WrappedGridFixture {
  designId: string;
  version: number;
  sourceId: NodeId;
  gridId: NodeId;
  wrapId: NodeId;
  draggedNode: { id: NodeId; name: string; x: number; y: number; rotation: number };
  gridNodes: Array<{ id: NodeId; name: string }>;
  wrapNodes: Array<{ id: NodeId; name: string }>;
}

interface RevisionEnvelope {
  version: number;
  document: DesignDocument;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface AlignmentMeasurement {
  expected: Edges;
  actual: Edges;
  errors: Edges;
  maxError: number;
  candidateCount: number;
  devicePixelRatio: number;
}

const viewportCases = [
  { label: "12% negative fractional pan", zoom: 0.12, pan: { x: -140.375, y: 92.625 } },
  { label: "25% positive pan", zoom: 0.25, pan: { x: 100.25, y: 70.5 } },
  { label: "50% mixed fractional pan", zoom: 0.5, pan: { x: 38.125, y: -72.875 } },
  { label: "100% mixed pan", zoom: 1, pan: { x: -60.5, y: 80.25 } },
  { label: "149% reproduced-defect pan", zoom: 1.49, pan: { x: -110.25, y: 3.875 } },
  { label: "150% mixed pan", zoom: 1.5, pan: { x: 40.75, y: -40.5 } },
  { label: "200% negative pan", zoom: 2, pan: { x: -120.25, y: -100.75 } },
  { label: "320% positive fractional pan", zoom: 3.2, pan: { x: 82.375, y: 44.625 } },
] as const;

async function uploadAlignmentImage(request: APIRequestContext, designId: string): Promise<{
  designAsset: { id: string };
  operation: Record<string, unknown>;
}> {
  const response = await request.post(`/api/assets?designId=${encodeURIComponent(designId)}`, {
    multipart: {
      file: {
        name: "alignment-pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ designAsset: { id: string }; operation: Record<string, unknown> }>;
}

async function createFixture(request: APIRequestContext): Promise<FixtureDesign> {
  const createResponse = await request.post("/api/designs", {
    data: {
      name: `Selection alignment ${Date.now()}`,
      preset: "web",
      idempotencyKey: `alignment-create-${crypto.randomUUID()}`,
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const created = await createResponse.json() as RevisionEnvelope;
  const frameId = created.document.pages[0]?.children[0];
  expect(frameId).toBeTruthy();
  const uploadedImage = await uploadAlignmentImage(request, created.document.id);

  const ltrNode = createTextNode({
    name: "Alignment LTR",
    content: "Checkout total",
    direction: "ltr",
    layout: {
      x: 100.25,
      y: 120.5,
      width: 190.75,
      height: 64.25,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: {
      color: "#101828",
      typography: {
        font_family: "Inter",
        font_size: 24,
        font_weight: 650,
        line_height: 32,
      },
    },
  });
  const rtlNode = createTextNode({
    name: "Alignment RTL",
    content: "مبلغ نهایی خرید",
    direction: "rtl",
    layout: {
      x: 420.5,
      y: 250.75,
      width: 220.5,
      height: 72.25,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: {
      color: "#101828",
      typography: {
        font_family: "Vazirmatn",
        font_size: 25,
        font_weight: 650,
        line_height: 36,
      },
    },
  });
  const mixedNode = createTextNode({
    name: "Alignment mixed direction",
    content: "Product سلام · نسخه ۲",
    direction: "auto",
    layout: {
      x: 720.375,
      y: 270.625,
      width: 250.25,
      height: 68.375,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: {
      color: "#101828",
      typography: {
        font_family: "Vazirmatn",
        font_size: 23,
        font_weight: 620,
        line_height: 34,
      },
    },
  });
  const imageNode = createImageNode({
    name: "Alignment normalized uploaded image",
    asset_id: uploadedImage.designAsset.id as never,
    alt: "Deterministic normalized uploaded image",
    layout: {
      x: 1010.1875,
      y: 140.3125,
      width: 132.625,
      height: 94.375,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
  });
  const rotatedRtlNode = createTextNode({
    name: "Alignment rotated RTL nested",
    content: "پرداخت امن",
    direction: "rtl",
    layout: {
      x: 31.3125,
      y: 28.6875,
      width: 172.375,
      height: 78.625,
      rotation: 27.5,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: {
      color: "#101828",
      typography: {
        font_family: "Vazirmatn",
        font_size: 24,
        font_weight: 680,
        line_height: 36,
      },
    },
  });
  const nestedGroup = createGroupNode({
    name: "Alignment nested absolute group",
    children: [rotatedRtlNode.id],
    layout: {
      x: 690.4375,
      y: 390.1875,
      width: 260.75,
      height: 160.5,
      mode: "absolute",
    },
    style: { fill: "#f7f5ff", radius: 14 },
  });
  const hiddenNode = createEllipseNode({
    name: "Alignment hidden exclusion",
    visible: false,
    layout: { x: 1020.25, y: 350.5, width: 90.25, height: 90.25 },
  });
  const lockedNode = createRectangleNode({
    name: "Alignment locked exclusion",
    locked: true,
    layout: { x: 1140.625, y: 350.375, width: 110.375, height: 80.625 },
  });
  const frameNode = createFrameNode({
    name: "Alignment selectable frame",
    role: "section",
    clip_content: true,
    layout: {
      x: 980.4375,
      y: 510.1875,
      width: 220.625,
      height: 148.375,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#f2f4f7", radius: 16 },
  });
  const ellipseNode = createEllipseNode({
    name: "Alignment selectable ellipse",
    layout: {
      x: 600.3125,
      y: 610.5625,
      width: 128.4375,
      height: 86.625,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#fec84b" },
  });
  const rotatedMultiNode = createRectangleNode({
    name: "Alignment rotated multi peer",
    layout: {
      x: 790.6875,
      y: 640.3125,
      width: 156.375,
      height: 92.625,
      rotation: -18.25,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#fda29b", radius: 12 },
  });
  const multiNodeA = createRectangleNode({
    name: "Alignment multi A",
    layout: {
      x: 140.3125,
      y: 340.1875,
      width: 120.4375,
      height: 60.3125,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#d7d2ff", radius: 12 },
  });
  const multiNodeB = createRectangleNode({
    name: "Alignment multi B",
    layout: {
      x: 350.6875,
      y: 400.5625,
      width: 140.1875,
      height: 60.4375,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#bde7d2", radius: 12 },
  });

  const commitResponse = await request.post(`/api/designs/${created.document.id}/revisions`, {
    data: {
      baseVersion: created.version,
      operations: [uploadedImage.operation, {
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: [
          ltrNode.id,
          rtlNode.id,
          mixedNode.id,
          imageNode.id,
          nestedGroup.id,
          frameNode.id,
          ellipseNode.id,
          rotatedMultiNode.id,
          hiddenNode.id,
          lockedNode.id,
          multiNodeA.id,
          multiNodeB.id,
        ],
        nodes: [
          ltrNode,
          rtlNode,
          mixedNode,
          imageNode,
          nestedGroup,
          rotatedRtlNode,
          frameNode,
          ellipseNode,
          rotatedMultiNode,
          hiddenNode,
          lockedNode,
          multiNodeA,
          multiNodeB,
        ],
      }],
      idempotencyKey: `alignment-commit-${crypto.randomUUID()}`,
      message: "Add deterministic LTR and RTL alignment fixtures",
    },
  });
  expect(commitResponse.ok(), await commitResponse.text()).toBe(true);

  return {
    designId: created.document.id,
    ltrNode: { id: ltrNode.id, name: ltrNode.name },
    rtlNode: { id: rtlNode.id, name: rtlNode.name },
    mixedNode: { id: mixedNode.id, name: mixedNode.name },
    imageNode: { id: imageNode.id, name: imageNode.name },
    rotatedRtlNode: { id: rotatedRtlNode.id, name: rotatedRtlNode.name },
    frameNode: { id: frameNode.id, name: frameNode.name },
    ellipseNode: { id: ellipseNode.id, name: ellipseNode.name },
    rotatedMultiNodes: [
      { id: rotatedRtlNode.id, name: rotatedRtlNode.name },
      { id: rotatedMultiNode.id, name: rotatedMultiNode.name },
    ],
    hiddenNode: { id: hiddenNode.id, name: hiddenNode.name },
    lockedNode: { id: lockedNode.id, name: lockedNode.name },
    multiNodes: [
      { id: multiNodeA.id, name: multiNodeA.name },
      { id: multiNodeB.id, name: multiNodeB.name },
    ],
  };
}

async function createAutoLayoutFixture(request: APIRequestContext): Promise<AutoLayoutFixture> {
  const createResponse = await request.post("/api/designs", {
    data: {
      name: `Auto-layout gestures ${Date.now()}`,
      preset: "web",
      idempotencyKey: `auto-layout-create-${crypto.randomUUID()}`,
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const created = await createResponse.json() as RevisionEnvelope;
  const frameId = created.document.pages[0]?.children[0];
  expect(frameId).toBeTruthy();

  const reorderNode = createRectangleNode({
    name: "Gesture reorder",
    layout: { x: 11.125, y: 17.875, width: 210, height: 54, rotation: 5.5 },
    style: { fill: "#d7d2ff", radius: 10 },
  });
  const resizeNode = createRectangleNode({
    name: "Gesture resize",
    layout: {
      x: 23.25,
      y: 29.5,
      width: 210,
      height: 54,
      rotation: 7.25,
      width_sizing: "fill",
      height_sizing: "fixed",
    },
    style: { fill: "#bde7d2", radius: 10 },
  });
  const tailNode = createRectangleNode({
    name: "Gesture tail",
    layout: { width: 210, height: 54 },
    style: { fill: "#f5d9a8", radius: 10 },
  });
  const destinationNode = createRectangleNode({
    name: "Gesture destination child",
    layout: { width: 210, height: 54 },
    style: { fill: "#bad7f5", radius: 10 },
  });
  const source = createGroupNode({
    name: "Gesture source stack",
    children: [reorderNode.id, resizeNode.id, tailNode.id],
    layout: {
      x: 90,
      y: 100,
      width: 260,
      height: 300,
      mode: "vertical",
      gap: 14,
      padding: 18,
    },
    style: { fill: "#ffffff", radius: 14 },
  });
  const destination = createGroupNode({
    name: "Gesture destination stack",
    children: [destinationNode.id],
    layout: {
      x: 470,
      y: 100,
      width: 260,
      height: 300,
      mode: "vertical",
      gap: 14,
      padding: 18,
    },
    style: { fill: "#ffffff", radius: 14 },
  });

  const commitResponse = await request.post(`/api/designs/${created.document.id}/revisions`, {
    data: {
      baseVersion: created.version,
      operations: [{
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: [source.id, destination.id],
        nodes: [source, destination, reorderNode, resizeNode, tailNode, destinationNode],
      }],
      idempotencyKey: `auto-layout-commit-${crypto.randomUUID()}`,
      message: "Add deterministic auto-layout gesture fixtures",
    },
  });
  expect(commitResponse.ok(), await commitResponse.text()).toBe(true);
  const committed = await commitResponse.json() as RevisionEnvelope;
  return {
    designId: created.document.id,
    version: committed.version,
    sourceId: source.id,
    destinationId: destination.id,
    reorderNode: { id: reorderNode.id, name: reorderNode.name, x: reorderNode.layout.x, y: reorderNode.layout.y },
    resizeNode: {
      id: resizeNode.id,
      name: resizeNode.name,
      x: resizeNode.layout.x,
      y: resizeNode.layout.y,
      rotation: resizeNode.layout.rotation ?? 0,
    },
    tailNode: { id: tailNode.id, name: tailNode.name },
    destinationNode: { id: destinationNode.id, name: destinationNode.name },
  };
}

async function createWrappedGridFixture(request: APIRequestContext): Promise<WrappedGridFixture> {
  const createResponse = await request.post("/api/designs", {
    data: {
      name: `Wrapped and grid gestures ${Date.now()}`,
      preset: "web",
      idempotencyKey: `wrapped-grid-create-${crypto.randomUUID()}`,
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBe(true);
  const created = await createResponse.json() as RevisionEnvelope;
  const frameId = created.document.pages[0]?.children[0];
  expect(frameId).toBeTruthy();

  const draggedNode = createRectangleNode({
    name: "Wrapped grid dragged node",
    layout: { x: 13.375, y: 19.625, width: 112, height: 58, rotation: 4.75 },
    style: { fill: "#675cff", radius: 10 },
  });
  const source = createGroupNode({
    name: "Wrapped grid source",
    children: [draggedNode.id],
    layout: { x: 20, y: 90, width: 150, height: 180, mode: "vertical", gap: 12, padding: 16 },
    style: { fill: "#ffffff", radius: 14 },
  });
  const gridNodes = ["A", "B", "C", "D"].map((suffix, index) => createRectangleNode({
    name: `Grid target ${suffix}`,
    layout: { width: 112, height: 58 },
    style: { fill: index % 2 === 0 ? "#bde7d2" : "#bad7f5", radius: 10 },
  }));
  const grid = createGroupNode({
    name: "Gesture grid destination",
    children: gridNodes.map((node) => node.id),
    layout: {
      x: 190,
      y: 90,
      width: 280,
      height: 250,
      mode: "grid",
      columns: 2,
      row_gap: 12,
      column_gap: 12,
      padding: 16,
    },
    style: { fill: "#ffffff", radius: 14 },
  });
  const wrapNodes = ["A", "B", "C"].map((suffix, index) => createRectangleNode({
    name: `Wrap target ${suffix}`,
    layout: { width: 112, height: 58 },
    style: { fill: index % 2 === 0 ? "#f5d9a8" : "#d7d2ff", radius: 10 },
  }));
  const wrap = createGroupNode({
    name: "Gesture wrapped destination",
    children: wrapNodes.map((node) => node.id),
    layout: {
      x: 500,
      y: 90,
      width: 280,
      height: 250,
      mode: "horizontal",
      wrap: true,
      gap: 12,
      padding: 16,
      align_items: "start",
    },
    style: { fill: "#ffffff", radius: 14 },
  });

  const commitResponse = await request.post(`/api/designs/${created.document.id}/revisions`, {
    data: {
      baseVersion: created.version,
      operations: [{
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: [source.id, grid.id, wrap.id],
        nodes: [source, draggedNode, grid, ...gridNodes, wrap, ...wrapNodes],
      }],
      idempotencyKey: `wrapped-grid-commit-${crypto.randomUUID()}`,
      message: "Add deterministic wrapped and grid gesture fixtures",
    },
  });
  expect(commitResponse.ok(), await commitResponse.text()).toBe(true);
  const committed = await commitResponse.json() as RevisionEnvelope;
  return {
    designId: created.document.id,
    version: committed.version,
    sourceId: source.id,
    gridId: grid.id,
    wrapId: wrap.id,
    draggedNode: {
      id: draggedNode.id,
      name: draggedNode.name,
      x: draggedNode.layout.x,
      y: draggedNode.layout.y,
      rotation: draggedNode.layout.rotation ?? 0,
    },
    gridNodes: gridNodes.map((node) => ({ id: node.id, name: node.name })),
    wrapNodes: wrapNodes.map((node) => ({ id: node.id, name: node.name })),
  };
}

async function readDesign(request: APIRequestContext, designId: string): Promise<RevisionEnvelope> {
  const response = await request.get(`/api/designs/${designId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<RevisionEnvelope>;
}

async function dragCenterTo(page: Page, nodeId: NodeId, point: { x: number; y: number }): Promise<void> {
  const box = await page.locator(`[data-node-id="${nodeId}"]`).boundingBox();
  if (!box) throw new Error(`Node ${nodeId} has no browser geometry.`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.up();
  await waitForGeometryFrame(page);
}

async function waitForGeometryFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function readViewportTransform(page: Page): Promise<{ zoom: number; pan: { x: number; y: number } }> {
  return page.locator(".canvas-layer").evaluate((layer) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
    return { zoom: matrix.a, pan: { x: matrix.e, y: matrix.f } };
  });
}

async function setViewport(
  page: Page,
  desired: { zoom: number; pan: { x: number; y: number } },
): Promise<void> {
  const viewport = page.locator(".canvas-editor-root");
  await viewport.evaluate((element, desiredZoom) => {
    const layer = element.querySelector<HTMLElement>(".canvas-layer");
    if (!layer) throw new Error("Canvas layer is unavailable.");
    const current = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
      deltaY: -Math.log(desiredZoom / current.a) / 0.002,
    }));
  }, desired.zoom);

  await expect.poll(async () => Math.abs((await readViewportTransform(page)).zoom - desired.zoom)).toBeLessThan(0.001);

  await viewport.evaluate((element, desiredPan) => {
    const layer = element.querySelector<HTMLElement>(".canvas-layer");
    if (!layer) throw new Error("Canvas layer is unavailable.");
    const current = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
      deltaX: current.e - desiredPan.x,
      deltaY: current.f - desiredPan.y,
    }));
  }, desired.pan);

  await expect.poll(async () => {
    const current = await readViewportTransform(page);
    return Math.max(
      Math.abs(current.pan.x - desired.pan.x),
      Math.abs(current.pan.y - desired.pan.y),
    );
  }).toBeLessThan(0.001);
  await waitForGeometryFrame(page);
}

function layerRow(page: Page, name: string) {
  return page.locator(".layer-row").filter({
    has: page.locator(".layer-name", { hasText: name }),
  });
}

async function selectNodes(page: Page, nodes: ReadonlyArray<{ id: NodeId; name: string }>): Promise<void> {
  expect(nodes.length).toBeGreaterThan(0);
  await layerRow(page, nodes[0]!.name).click();
  for (const node of nodes.slice(1)) {
    await layerRow(page, node.name).click({ modifiers: ["Shift"] });
  }
  await expect(page.locator(".designer-node.is-selected")).toHaveCount(nodes.length);
  await waitForGeometryFrame(page);
}

async function measureRotatedAlignment(page: Page, nodeId: NodeId): Promise<AlignmentMeasurement> {
  return page.evaluate((id) => {
    const target = document.querySelector<HTMLElement>(`.designer-node[data-node-id="${CSS.escape(id)}"]`);
    if (!target) throw new Error(`Missing rotated target node ${id}.`);
    const targetRect = target.getBoundingClientRect();
    const expected = {
      left: targetRect.left,
      top: targetRect.top,
      right: targetRect.right,
      bottom: targetRect.bottom,
    };
    const candidates = [...document.querySelectorAll<HTMLElement>(".canvas-interaction-overlay .moveable-control-box")]
      .flatMap((controlBox) => {
        const controls = ["nw", "ne", "sw", "se"].map((direction) =>
          controlBox.querySelector<HTMLElement>(`:scope .moveable-control[data-direction="${direction}"]`));
        if (controls.some((control) => !control)) return [];
        const centers = controls.map((control) => {
          const rect = control!.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        const actual = {
          left: Math.min(...centers.map((point) => point.x)),
          top: Math.min(...centers.map((point) => point.y)),
          right: Math.max(...centers.map((point) => point.x)),
          bottom: Math.max(...centers.map((point) => point.y)),
        };
        const errors = {
          left: Math.abs(actual.left - expected.left),
          top: Math.abs(actual.top - expected.top),
          right: Math.abs(actual.right - expected.right),
          bottom: Math.abs(actual.bottom - expected.bottom),
        };
        return [{ actual, errors, maxError: Math.max(...Object.values(errors)) }];
      });
    if (candidates.length === 0) throw new Error("Moveable did not render four rotated resize controls.");
    const closest = candidates.sort((left, right) => left.maxError - right.maxError)[0]!;
    return {
      expected,
      actual: closest.actual,
      errors: closest.errors,
      maxError: closest.maxError,
      candidateCount: candidates.length,
      devicePixelRatio: window.devicePixelRatio,
    };
  }, nodeId);
}

async function expectRotatedAligned(page: Page, nodeId: NodeId, label: string): Promise<void> {
  let measurement: AlignmentMeasurement | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForGeometryFrame(page);
    measurement = await measureRotatedAlignment(page, nodeId);
    if (measurement.maxError <= ALIGNMENT_TOLERANCE_CSS_PX) return;
  }
  expect(
    measurement?.maxError,
    `${label}: rotated Moveable corner centers differ from the target envelope by more than ${ALIGNMENT_TOLERANCE_CSS_PX} CSS px.\n${JSON.stringify(measurement, null, 2)}`,
  ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_CSS_PX);
}

async function shiftCanvasWithoutInvalidation(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x: nextX, y: nextY }) => {
    let style = document.querySelector<HTMLStyleElement>("style[data-formaspec-alignment-shift]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.formaspecAlignmentShift = "true";
      document.head.append(style);
    }
    style.textContent = `.canvas-layer { margin-left: ${nextX}px !important; margin-top: ${nextY}px !important; }`;
  }, { x, y });
}

async function measureAlignment(page: Page, nodeIds: readonly NodeId[]): Promise<AlignmentMeasurement> {
  return page.evaluate((ids) => {
    const targetRects = ids.map((id) => {
      const target = document.querySelector<HTMLElement>(`.designer-node[data-node-id="${CSS.escape(id)}"]`);
      if (!target) throw new Error(`Missing target node ${id}.`);
      return target.getBoundingClientRect();
    });
    const expected = {
      left: Math.min(...targetRects.map((rect) => rect.left)),
      top: Math.min(...targetRects.map((rect) => rect.top)),
      right: Math.max(...targetRects.map((rect) => rect.right)),
      bottom: Math.max(...targetRects.map((rect) => rect.bottom)),
    };

    if (ids.length > 1) {
      const preciseBounds = document.querySelector<HTMLElement>("[data-formaspec-selection-bounds=\"multi\"]");
      if (!preciseBounds) throw new Error("FormaSpec did not render precise multi-selection bounds.");
      const rect = preciseBounds.getBoundingClientRect();
      const actual = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      const errors = {
        left: Math.abs(actual.left - expected.left),
        top: Math.abs(actual.top - expected.top),
        right: Math.abs(actual.right - expected.right),
        bottom: Math.abs(actual.bottom - expected.bottom),
      };
      return {
        expected,
        actual,
        errors,
        maxError: Math.max(...Object.values(errors)),
        candidateCount: 1,
        devicePixelRatio: window.devicePixelRatio,
      };
    }

    const candidates = [...document.querySelectorAll<HTMLElement>(".canvas-interaction-overlay .moveable-control-box")]
      .flatMap((controlBox) => {
        const lines = [0, 1, 2, 3].map((index) =>
          controlBox.querySelector<HTMLElement>(`:scope > [data-line-key="render-line-${index}"]`));
        if (lines.some((line) => !line)) return [];
        const [topLine, rightLine, bottomLine, leftLine] = lines.map((line) => line!.getBoundingClientRect());
        const actual = {
          left: leftLine.left + leftLine.width / 2,
          top: topLine.top + topLine.height / 2,
          right: rightLine.left + rightLine.width / 2,
          bottom: bottomLine.top + bottomLine.height / 2,
        };
        const errors = {
          left: Math.abs(actual.left - expected.left),
          top: Math.abs(actual.top - expected.top),
          right: Math.abs(actual.right - expected.right),
          bottom: Math.abs(actual.bottom - expected.bottom),
        };
        return [{ actual, errors, maxError: Math.max(...Object.values(errors)) }];
      });
    if (candidates.length === 0) throw new Error("Moveable did not render a measurable control box.");
    const closest = candidates.sort((left, right) => left.maxError - right.maxError)[0]!;
    return {
      expected,
      actual: closest.actual,
      errors: closest.errors,
      maxError: closest.maxError,
      candidateCount: candidates.length,
      devicePixelRatio: window.devicePixelRatio,
    };
  }, [...nodeIds]);
}

async function expectAligned(page: Page, nodeIds: readonly NodeId[], label: string): Promise<void> {
  let measurement: AlignmentMeasurement | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForGeometryFrame(page);
    measurement = await measureAlignment(page, nodeIds);
    if (measurement.maxError <= ALIGNMENT_TOLERANCE_CSS_PX) return;
  }
  expect(
    measurement?.maxError,
    `${label}: Moveable differs from the selected target union by more than ${ALIGNMENT_TOLERANCE_CSS_PX} CSS px.\n${JSON.stringify(measurement, null, 2)}`,
  ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_CSS_PX);
}

test("Moveable remains aligned after zoom, pan, direction, and selection changes", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request);
  await page.goto(`/design/${fixture.designId}`);
  await expect(page.locator(`[data-node-id="${fixture.ltrNode.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-node-id="${fixture.rtlNode.id}"]`)).toHaveAttribute("dir", "rtl");
  await expect(page.locator(`[data-node-id="${fixture.mixedNode.id}"]`)).toHaveAttribute("dir", "auto");
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(testInfo.project.use.deviceScaleFactor);

  await selectNodes(page, [fixture.ltrNode]);
  for (const viewportCase of viewportCases) {
    await setViewport(page, viewportCase);
    await expectAligned(page, [fixture.ltrNode.id], `${viewportCase.label}, LTR single selection`);

    await selectNodes(page, [fixture.rtlNode]);
    await expectAligned(page, [fixture.rtlNode.id], `${viewportCase.label}, RTL single selection`);

    await selectNodes(page, [fixture.mixedNode]);
    await expectAligned(page, [fixture.mixedNode.id], `${viewportCase.label}, mixed-direction single selection`);

    await selectNodes(page, fixture.multiNodes);
    await expectAligned(page, fixture.multiNodes.map((node) => node.id), `${viewportCase.label}, multi-selection`);

    const nudged = {
      zoom: viewportCase.zoom,
      pan: { x: viewportCase.pan.x + 16.25, y: viewportCase.pan.y - 11.5 },
    };
    await setViewport(page, nudged);
    await expectAligned(page, fixture.multiNodes.map((node) => node.id), `${viewportCase.label}, multi-selection after pan`);
    await setViewport(page, viewportCase);

    // Keep a single target selected while the next case changes both pan and zoom.
    await selectNodes(page, [fixture.ltrNode]);
  }
});

test("nested rotation, image geometry, exclusions, and asynchronous invalidation stay aligned", async ({ page, request }) => {
  const fixture = await createFixture(request);
  await page.goto(`/design/${fixture.designId}`);
  await expect(page.locator(`[data-node-id="${fixture.rotatedRtlNode.id}"]`)).toHaveAttribute("dir", "rtl");
  await expect(page.locator(`[data-node-id="${fixture.imageNode.id}"]`)).toHaveAttribute("data-node-type", "image");
  await expect(page.locator(`[data-node-id="${fixture.imageNode.id}"] img`)).toBeVisible();
  await expect.poll(() => page.locator(`[data-node-id="${fixture.imageNode.id}"] img`).evaluate((image) => ({
    complete: (image as HTMLImageElement).complete,
    naturalWidth: (image as HTMLImageElement).naturalWidth,
  }))).toEqual({ complete: true, naturalWidth: 1 });
  await expect(page.locator(`[data-node-id="${fixture.frameNode.id}"]`)).toHaveAttribute("data-node-type", "frame");
  await expect(page.locator(`[data-node-id="${fixture.ellipseNode.id}"]`)).toHaveAttribute("data-node-type", "ellipse");

  await selectNodes(page, [fixture.rotatedRtlNode]);
  for (const viewportCase of viewportCases.filter(({ zoom }) => zoom === 1.49 || zoom === 3.2)) {
    await setViewport(page, viewportCase);
    await expectRotatedAligned(page, fixture.rotatedRtlNode.id, `${viewportCase.label}, nested rotated RTL`);
  }

  await selectNodes(page, [fixture.imageNode]);
  await setViewport(page, viewportCases.find(({ zoom }) => zoom === 1.49)!);
  await expectAligned(page, [fixture.imageNode.id], "149%, image placeholder node");

  for (const viewportCase of viewportCases.filter(({ zoom }) => zoom === 1.49 || zoom === 3.2)) {
    await setViewport(page, viewportCase);
    await selectNodes(page, [fixture.frameNode]);
    await expectAligned(page, [fixture.frameNode.id], `${viewportCase.label}, selectable frame`);
    await selectNodes(page, [fixture.ellipseNode]);
    await expectAligned(page, [fixture.ellipseNode.id], `${viewportCase.label}, selectable ellipse`);
    await selectNodes(page, fixture.rotatedMultiNodes);
    await expectAligned(
      page,
      fixture.rotatedMultiNodes.map((node) => node.id),
      `${viewportCase.label}, rotated multi-selection union`,
    );
  }

  await layerRow(page, fixture.hiddenNode.name).click();
  await expect(page.locator(".designer-node.is-selected")).toHaveCount(0);
  await expect(page.locator("[data-formaspec-selection-bounds=\"multi\"]")).toHaveCount(0);
  await layerRow(page, fixture.lockedNode.name).click();
  await expect(page.locator(".designer-node.is-selected")).toHaveCount(0);
  await expect(page.locator(`[data-node-id="${fixture.hiddenNode.id}"]`)).toBeHidden();
  await expect(page.locator(`[data-node-id="${fixture.lockedNode.id}"]`)).toHaveClass(/is-locked/);

  await selectNodes(page, [fixture.ltrNode]);
  await expectAligned(page, [fixture.ltrNode.id], "before font/image/scroll invalidation");

  await shiftCanvasWithoutInvalidation(page, 83, 57);
  expect((await measureAlignment(page, [fixture.ltrNode.id])).maxError).toBeGreaterThan(10);
  await page.evaluate(() => document.fonts.dispatchEvent(new Event("loadingdone")));
  await expectAligned(page, [fixture.ltrNode.id], "after font readiness event");

  await page.evaluate(() => {
    const canvasLayer = document.querySelector<HTMLElement>(".canvas-layer");
    if (!canvasLayer) throw new Error("Canvas layer is unavailable for the image invalidation probe.");
    const image = document.createElement("img");
    image.dataset.formaspecAlignmentImageProbe = "true";
    image.alt = "";
    image.style.display = "none";
    canvasLayer.append(image);
  });
  await waitForGeometryFrame(page);
  await shiftCanvasWithoutInvalidation(page, 131, 79);
  expect((await measureAlignment(page, [fixture.ltrNode.id])).maxError).toBeGreaterThan(10);
  await page.locator("img[data-formaspec-alignment-image-probe]").evaluate((image) => {
    image.dispatchEvent(new Event("load"));
  });
  await expectAligned(page, [fixture.ltrNode.id], "after image load event");

  const nestedScroll = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".editor-stage-content");
    const root = document.querySelector<HTMLElement>(".canvas-editor-root");
    if (!stage || !root) throw new Error("Editor scroll containers are unavailable.");
    stage.style.overflow = "auto";
    root.style.height = `${stage.clientHeight + 360}px`;
    stage.scrollTop = 140;
    return { top: stage.scrollTop, scrollHeight: stage.scrollHeight, clientHeight: stage.clientHeight };
  });
  expect(nestedScroll.scrollHeight).toBeGreaterThan(nestedScroll.clientHeight);
  expect(nestedScroll.top).toBeGreaterThan(0);
  await expectAligned(page, [fixture.ltrNode.id], "after nested scroll capture");
});

test("real delayed bundled-font completion refreshes stale selection geometry", async ({ page, request }) => {
  let releaseFonts = (): void => undefined;
  const fontGate = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });
  let delayedFontRequests = 0;
  await page.route("**/*.woff2", async (route) => {
    delayedFontRequests += 1;
    await fontGate;
    await route.continue();
  });
  const fixture = await createFixture(request);

  try {
    await page.goto(`/design/${fixture.designId}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(`[data-node-id="${fixture.ltrNode.id}"]`)).toBeVisible();
    await expect.poll(() => delayedFontRequests).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loading");
    await selectNodes(page, [fixture.ltrNode]);
    await setViewport(page, { zoom: 1.49, pan: { x: -92.375, y: 34.625 } });
    await expectAligned(page, [fixture.ltrNode.id], "while bundled fonts are delayed");

    await shiftCanvasWithoutInvalidation(page, 97, 63);
    expect((await measureAlignment(page, [fixture.ltrNode.id])).maxError).toBeGreaterThan(10);
    releaseFonts();
    await page.evaluate(() => document.fonts.ready);
    await expectAligned(page, [fixture.ltrNode.id], "after real bundled-font completion");
  } finally {
    releaseFonts();
    await page.unroute("**/*.woff2");
  }
});

test("fractional multi-root drag commits one revision and preserves equal precise deltas", async ({ page, request }) => {
  const fixture = await createFixture(request);
  const before = await readDesign(request, fixture.designId);
  const [firstNode, secondNode] = fixture.multiNodes;
  if (!firstNode || !secondNode) throw new Error("Expected two multi-selection fixtures.");
  const firstBefore = before.document.nodes[firstNode.id]!.layout;
  const secondBefore = before.document.nodes[secondNode.id]!.layout;

  await page.goto(`/design/${fixture.designId}`);
  await setViewport(page, { zoom: 1.49, pan: { x: 20.375, y: 31.625 } });
  await selectNodes(page, fixture.multiNodes);
  await expectAligned(page, fixture.multiNodes.map((node) => node.id), "fractional group before drag");
  const firstBox = await page.locator(`[data-node-id="${firstNode.id}"]`).boundingBox();
  if (!firstBox) throw new Error("Fractional group target has no browser geometry.");
  await dragCenterTo(page, firstNode.id, {
    x: firstBox.x + firstBox.width / 2 + 43.375,
    y: firstBox.y + firstBox.height / 2 - 28.625,
  });

  await expect.poll(async () => (await readDesign(request, fixture.designId)).version).toBe(before.version + 1);
  const after = await readDesign(request, fixture.designId);
  const firstAfter = after.document.nodes[firstNode.id]!.layout;
  const secondAfter = after.document.nodes[secondNode.id]!.layout;
  const firstDelta = { x: firstAfter.x - firstBefore.x, y: firstAfter.y - firstBefore.y };
  const secondDelta = { x: secondAfter.x - secondBefore.x, y: secondAfter.y - secondBefore.y };
  expect(Math.abs(firstDelta.x)).toBeGreaterThan(1);
  expect(Math.abs(firstDelta.y)).toBeGreaterThan(1);
  expect(secondDelta.x).toBeCloseTo(firstDelta.x, 4);
  expect(secondDelta.y).toBeCloseTo(firstDelta.y, 4);
  expect(firstAfter.x).not.toBe(Math.round(firstAfter.x));
  expect(firstAfter.y).not.toBe(Math.round(firstAfter.y));
});

test("auto-layout gestures reorder, reparent, and resize constraints without writing x/y", async ({ page, request }) => {
  const fixture = await createAutoLayoutFixture(request);
  await page.goto(`/design/${fixture.designId}`);
  await expect(page.locator(`[data-node-id="${fixture.sourceId}"]`)).toBeVisible();
  await setViewport(page, { zoom: 1.49, pan: { x: 18.375, y: 42.625 } });

  await selectNodes(page, [fixture.reorderNode]);
  const tailBox = await page.locator(`[data-node-id="${fixture.tailNode.id}"]`).boundingBox();
  if (!tailBox) throw new Error("Tail node has no browser geometry.");
  await dragCenterTo(page, fixture.reorderNode.id, {
    x: tailBox.x + tailBox.width / 2,
    y: tailBox.y + tailBox.height - 2,
  });
  await expect.poll(async () => {
    const design = await readDesign(request, fixture.designId);
    const source = design.document.nodes[fixture.sourceId];
    return source?.type === "group" ? source.children.join(",") : "";
  }).toBe([fixture.resizeNode.id, fixture.tailNode.id, fixture.reorderNode.id].join(","));
  await expect.poll(async () => (await readDesign(request, fixture.designId)).version).toBe(fixture.version + 1);

  const destinationBox = await page.locator(`[data-node-id="${fixture.destinationId}"]`).boundingBox();
  if (!destinationBox) throw new Error("Destination stack has no browser geometry.");
  await dragCenterTo(page, fixture.reorderNode.id, {
    x: destinationBox.x + destinationBox.width / 2,
    y: destinationBox.y + destinationBox.height - 24,
  });
  await expect.poll(async () => {
    const design = await readDesign(request, fixture.designId);
    const destination = design.document.nodes[fixture.destinationId];
    return destination?.type === "group" ? destination.children.join(",") : "";
  }).toBe([fixture.destinationNode.id, fixture.reorderNode.id].join(","));
  await expect.poll(async () => (await readDesign(request, fixture.designId)).version).toBe(fixture.version + 2);

  await selectNodes(page, [fixture.resizeNode]);
  const resizeHandle = page.locator('.canvas-interaction-overlay .moveable-control[data-direction="se"]').first();
  await expect(resizeHandle).toBeVisible();
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error("Resize handle has no browser geometry.");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 36.375, handleBox.y + handleBox.height / 2 + 18.625, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => {
    const design = await readDesign(request, fixture.designId);
    return design.document.nodes[fixture.resizeNode.id]?.layout.width_sizing;
  }).toBe("fixed");
  const finalDesign = await readDesign(request, fixture.designId);
  expect(finalDesign.version).toBe(fixture.version + 3);
  expect(finalDesign.document.nodes[fixture.reorderNode.id]?.layout).toMatchObject({
    x: fixture.reorderNode.x,
    y: fixture.reorderNode.y,
    rotation: 5.5,
  });
  expect(finalDesign.document.nodes[fixture.resizeNode.id]?.layout).toMatchObject({
    x: fixture.resizeNode.x,
    y: fixture.resizeNode.y,
    rotation: fixture.resizeNode.rotation,
    width_sizing: "fixed",
  });
});

test("wrapped and grid auto-layout gestures use row-aware insertion without writing x/y", async ({ page, request }) => {
  const fixture = await createWrappedGridFixture(request);
  await page.goto(`/design/${fixture.designId}`);
  await expect(page.locator(`[data-node-id="${fixture.gridId}"]`)).toBeVisible();
  await expect(page.locator(`[data-node-id="${fixture.wrapId}"]`)).toBeVisible();
  await setViewport(page, { zoom: 1.49, pan: { x: 26.375, y: 38.625 } });

  await selectNodes(page, [fixture.draggedNode]);
  const gridTarget = await page.locator(`[data-node-id="${fixture.gridNodes[2]!.id}"]`).boundingBox();
  if (!gridTarget) throw new Error("Grid row target has no browser geometry.");
  await dragCenterTo(page, fixture.draggedNode.id, {
    x: gridTarget.x + 2,
    y: gridTarget.y + gridTarget.height / 2,
  });
  await expect.poll(async () => {
    const design = await readDesign(request, fixture.designId);
    const grid = design.document.nodes[fixture.gridId];
    return grid?.type === "group" ? grid.children.join(",") : "";
  }).toBe([
    fixture.gridNodes[0]!.id,
    fixture.gridNodes[1]!.id,
    fixture.draggedNode.id,
    fixture.gridNodes[2]!.id,
    fixture.gridNodes[3]!.id,
  ].join(","));
  await expect.poll(async () => (await readDesign(request, fixture.designId)).version).toBe(fixture.version + 1);

  await selectNodes(page, [fixture.draggedNode]);
  const wrapTarget = await page.locator(`[data-node-id="${fixture.wrapNodes[2]!.id}"]`).boundingBox();
  if (!wrapTarget) throw new Error("Wrapped row target has no browser geometry.");
  await dragCenterTo(page, fixture.draggedNode.id, {
    x: wrapTarget.x + wrapTarget.width - 2,
    y: wrapTarget.y + wrapTarget.height / 2,
  });
  await expect.poll(async () => {
    const design = await readDesign(request, fixture.designId);
    const wrap = design.document.nodes[fixture.wrapId];
    return wrap?.type === "group" ? wrap.children.join(",") : "";
  }).toBe([...fixture.wrapNodes.map((node) => node.id), fixture.draggedNode.id].join(","));

  const finalDesign = await readDesign(request, fixture.designId);
  expect(finalDesign.version).toBe(fixture.version + 2);
  expect(finalDesign.document.nodes[fixture.sourceId]).toMatchObject({ type: "group", children: [] });
  expect(finalDesign.document.nodes[fixture.draggedNode.id]?.layout).toMatchObject({
    x: fixture.draggedNode.x,
    y: fixture.draggedNode.y,
    rotation: fixture.draggedNode.rotation,
  });
});

import {
  createGroupNode,
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
  { label: "25% positive pan", zoom: 0.25, pan: { x: 100.25, y: 70.5 } },
  { label: "100% mixed pan", zoom: 1, pan: { x: -60.5, y: 80.25 } },
  { label: "150% mixed pan", zoom: 1.5, pan: { x: 40.75, y: -40.5 } },
  { label: "200% negative pan", zoom: 2, pan: { x: -120.25, y: -100.75 } },
] as const;

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
  const multiNodeA = createRectangleNode({
    name: "Alignment multi A",
    layout: {
      x: 140,
      y: 340,
      width: 120,
      height: 60,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#d7d2ff", radius: 12 },
  });
  const multiNodeB = createRectangleNode({
    name: "Alignment multi B",
    layout: {
      x: 350,
      y: 400,
      width: 140,
      height: 60,
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { fill: "#bde7d2", radius: 12 },
  });

  const commitResponse = await request.post(`/api/designs/${created.document.id}/revisions`, {
    data: {
      baseVersion: created.version,
      operations: [{
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: [ltrNode.id, rtlNode.id, multiNodeA.id, multiNodeB.id],
        nodes: [ltrNode, rtlNode, multiNodeA, multiNodeB],
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

async function selectNodes(page: Page, nodes: ReadonlyArray<{ id: NodeId; name: string }>): Promise<void> {
  expect(nodes.length).toBeGreaterThan(0);
  const layerRow = (name: string) => page.locator(".layer-row").filter({
    has: page.locator(".layer-name", { hasText: name }),
  });
  await layerRow(nodes[0]!.name).click();
  for (const node of nodes.slice(1)) {
    await layerRow(node.name).click({ modifiers: ["Shift"] });
  }
  await expect(page.locator(".designer-node.is-selected")).toHaveCount(nodes.length);
  await waitForGeometryFrame(page);
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
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(testInfo.project.use.deviceScaleFactor);

  await selectNodes(page, [fixture.ltrNode]);
  for (const viewportCase of viewportCases) {
    await setViewport(page, viewportCase);
    await expectAligned(page, [fixture.ltrNode.id], `${viewportCase.label}, LTR single selection`);

    await selectNodes(page, [fixture.rtlNode]);
    await expectAligned(page, [fixture.rtlNode.id], `${viewportCase.label}, RTL single selection`);

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

test("auto-layout gestures reorder, reparent, and resize constraints without writing x/y", async ({ page, request }) => {
  const fixture = await createAutoLayoutFixture(request);
  await page.goto(`/design/${fixture.designId}`);
  await expect(page.locator(`[data-node-id="${fixture.sourceId}"]`)).toBeVisible();

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

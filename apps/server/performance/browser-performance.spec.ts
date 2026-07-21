import { performance as nodePerformance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import type { DesignDocument, DesignNode, NodeId } from "@designer/core";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "playwright/test";

import {
  PERFORMANCE_NODE_COUNT,
  createServerTreeOperation,
  createThousandNodeFixture,
} from "./fixture.js";
import { summarizeTimings, type TimingSummary } from "./stats.js";

const INTERACTIVE_MARK = "formaspec:editor-interactive";
const NOMINAL_REFRESH_INTERVAL_MS = 1_000 / 60;
const RELEASE_BUDGETS_MS = {
  initialInteractiveLoad: 2_500,
  selectionResponse: 50,
  gestureFrameP95: 16.7,
  gestureFrameMax: 50,
  localCommit: 500,
  historyLoad: 1_000,
  previewValidation: 1_000,
  chromiumRender: 5_000,
  chromiumRenderHardTimeout: 15_000,
} as const;

function environmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

const SETTINGS = {
  iterations: environmentInteger("FORMASPEC_BROWSER_PERF_ITERATIONS", 20, 20, 100),
  warmupIterations: environmentInteger("FORMASPEC_BROWSER_PERF_WARMUP_ITERATIONS", 2, 1, 10),
  gestureFramesPerIteration: environmentInteger("FORMASPEC_BROWSER_PERF_GESTURE_FRAMES", 15, 8, 60),
} as const;

interface RevisionEnvelope {
  version: number;
  revisionId: string;
  document: DesignDocument;
}

interface PerformanceFixture {
  designId: string;
  rootId: NodeId;
  selectionIds: NodeId[];
  mutableNodeId: NodeId;
  version: number;
  operationBytes: number;
}

interface InteractiveSample {
  durationMs: number;
  renderedNodeCount: number;
  readyRevision: number;
}

interface FrameSample {
  workDurationsMs: number[];
  intervalDurationsMs: number[];
  startPan: { x: number; y: number };
  endPan: { x: number; y: number };
}

interface MetricBudget {
  p95Ms: number;
  maxMs?: number;
}

interface BrowserPerformanceMetric {
  id: string;
  description: string;
  samplesMs: number[];
  summary: TimingSummary;
  budget: MetricBudget;
  passed: boolean;
}

interface BrowserPerformanceReport {
  schemaVersion: 1;
  suite: "formaspec-1000-node-browser-release";
  releaseEvidence: true;
  fixture: {
    nodeCount: number;
    rootWidth: number;
    rootHeight: number;
    operationBytes: number;
    historyRows: number;
  };
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
    browserName: "chromium";
    browserVersion: string;
    devicePixelRatio: number;
    viewport: { width: number; height: number };
  };
  settings: {
    iterations: number;
    warmupIterations: number;
    gestureFramesPerIteration: number;
    initialLoadCache: "cleared-before-each-sample";
    renderHardTimeoutMs: number;
  };
  renderer: {
    modes: string[];
    warnings: string[];
    width: number;
    height: number;
    pinnedChromium: boolean;
  };
  autosave: {
    observed: boolean;
    debounceMs: number;
    measuredCommitModes: Array<"autosave" | "explicit">;
  };
  gesture: {
    intervalSummary: TimingSummary;
    intervalSamplesMs: number[];
    workSummary: TimingSummary;
    workSamplesMs: number[];
    framesOver50Ms: number;
  };
  preview: {
    rendered: false;
    statuses: string[];
  };
  metrics: BrowserPerformanceMetric[];
  passed: boolean;
  notes: string[];
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function cadenceNormalizedFrameBudget(intervalMs: number): number {
  const presentedIntervals = Math.max(1, Math.round(intervalMs / NOMINAL_REFRESH_INTERVAL_MS));
  return presentedIntervals * RELEASE_BUDGETS_MS.gestureFrameP95;
}

function metric(
  id: string,
  description: string,
  durationsMs: readonly number[],
  budget: MetricBudget,
): BrowserPerformanceMetric {
  const summary = summarizeTimings(durationsMs);
  const passed = summary.p95Ms <= budget.p95Ms
    && (budget.maxMs === undefined || summary.maxMs <= budget.maxMs);
  return {
    id,
    description,
    samplesMs: durationsMs.map(round),
    summary: {
      samples: summary.samples,
      minMs: round(summary.minMs),
      p50Ms: round(summary.p50Ms),
      p95Ms: round(summary.p95Ms),
      maxMs: round(summary.maxMs),
    },
    budget,
    passed,
  };
}

function reportTable(metrics: readonly BrowserPerformanceMetric[]): string {
  const lines = [
    "FormaSpec deterministic 1,000-node browser release gate",
    "metric                                      samples       p50 ms       p95 ms       max ms  result",
  ];
  for (const item of metrics) {
    lines.push(
      `${item.id.padEnd(44)}${String(item.summary.samples).padStart(7)}${item.summary.p50Ms.toFixed(2).padStart(13)}${item.summary.p95Ms.toFixed(2).padStart(13)}${item.summary.maxMs.toFixed(2).padStart(13)}  ${item.passed ? "PASS" : "FAIL"}`,
    );
  }
  return lines.join("\n");
}

async function jsonResponse<T>(response: APIResponse): Promise<T> {
  const text = await response.text();
  if (!response.ok()) throw new Error(`Request failed with ${response.status()}: ${text.slice(0, 2_000)}`);
  return JSON.parse(text) as T;
}

function cardNodes(document: DesignDocument): DesignNode[] {
  return Object.values(document.nodes)
    .filter((node) => node.type === "frame" && typeof node.metadata.fixture_card_index === "number")
    .sort((left, right) => Number(left.metadata.fixture_card_index) - Number(right.metadata.fixture_card_index));
}

async function createBrowserFixture(request: APIRequestContext): Promise<PerformanceFixture> {
  const source = createThousandNodeFixture();
  const createResponse = await request.post("/api/designs", {
    data: {
      name: "FormaSpec deterministic browser performance fixture",
      preset: "web",
      idempotencyKey: `browser-perf-create-${crypto.randomUUID()}`,
    },
  });
  const created = await jsonResponse<RevisionEnvelope>(createResponse);
  const rootId = created.document.pages[0]?.children[0];
  if (!rootId) throw new Error("The browser performance design has no root frame.");
  const operation = createServerTreeOperation(source, rootId);
  const operationBytes = Buffer.byteLength(JSON.stringify([operation]), "utf8");
  const commitResponse = await request.post(`/api/designs/${encodeURIComponent(created.document.id)}/revisions`, {
    data: {
      baseVersion: created.version,
      operations: [operation],
      idempotencyKey: `browser-perf-seed-${crypto.randomUUID()}`,
      message: "Seed deterministic 1,000-node browser performance fixture",
    },
  });
  const committed = await jsonResponse<RevisionEnvelope>(commitResponse);
  if (Object.keys(committed.document.nodes).length !== PERFORMANCE_NODE_COUNT) {
    throw new Error(`The committed browser fixture contains ${Object.keys(committed.document.nodes).length} nodes.`);
  }
  const cards = cardNodes(committed.document);
  if (cards.length !== 100) throw new Error(`The browser fixture contains ${cards.length} cards instead of 100.`);
  return {
    designId: committed.document.id,
    rootId,
    selectionIds: cards.map((node) => node.id),
    mutableNodeId: cards[0]!.id,
    version: committed.version,
    operationBytes,
  };
}

async function waitForInteractive(page: Page): Promise<InteractiveSample> {
  const handle = await page.waitForFunction((markName) => {
    const root = document.querySelector<HTMLElement>(".canvas-editor-root[data-formaspec-editor-ready='true']");
    const mark = performance.getEntriesByName(markName).at(-1);
    if (!root || !mark) return null;
    const renderedNodeCount = Number(root.dataset.formaspecRenderedNodeCount);
    const readyRevision = Number(root.dataset.formaspecReadyRevision);
    if (!Number.isFinite(renderedNodeCount) || !Number.isFinite(readyRevision)) return null;
    return { durationMs: mark.startTime, renderedNodeCount, readyRevision };
  }, INTERACTIVE_MARK, { timeout: RELEASE_BUDGETS_MS.chromiumRenderHardTimeout });
  return await handle.jsonValue() as InteractiveSample;
}

async function measureColdInteractiveLoad(context: BrowserContext, url: string): Promise<InteractiveSample> {
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    await session.send("Network.enable");
    await session.send("Network.clearBrowserCache");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: RELEASE_BUDGETS_MS.chromiumRenderHardTimeout });
    return await waitForInteractive(page);
  } finally {
    await session.detach().catch(() => undefined);
    await page.close();
  }
}

async function measureSelectionResponse(page: Page, nodeId: NodeId): Promise<number> {
  return page.evaluate(async (id) => {
    const row = document.querySelector<HTMLElement>(`.layer-row[data-layer-node-id="${CSS.escape(id)}"]`);
    if (!row) throw new Error(`Layer row ${id} is unavailable.`);
    const startedAt = performance.now();
    row.click();
    const deadline = startedAt + 5_000;
    while (performance.now() < deadline) {
      const selected = document.querySelectorAll(".designer-node.is-selected");
      const target = document.querySelector<HTMLElement>(`.designer-node[data-node-id="${CSS.escape(id)}"].is-selected`);
      const moveable = document.querySelector(".canvas-interaction-overlay .moveable-control-box");
      if (selected.length === 1 && target && moveable) return performance.now() - startedAt;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(`Selection ${id} did not become interactive within 5 seconds.`);
  }, nodeId);
}

async function measurePanFrames(page: Page, frameCount: number, direction: 1 | -1): Promise<FrameSample> {
  return page.evaluate(async ({ frames, direction }) => {
    const viewport = document.querySelector<HTMLElement>(".canvas-editor-root");
    const layer = document.querySelector<HTMLElement>(".canvas-layer");
    if (!viewport || !layer) throw new Error("The canvas viewport is unavailable.");
    const readPan = () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
      return { x: matrix.e, y: matrix.f };
    };
    const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    await nextFrame();
    let previous = await nextFrame();
    const startPan = readPan();
    const workDurationsMs: number[] = [];
    const intervalDurationsMs: number[] = [];
    const bounds = viewport.getBoundingClientRect();
    for (let index = 0; index < frames; index += 1) {
      const workStartedAt = performance.now();
      viewport.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaX: direction * 1.25,
        deltaY: direction * 0.5,
      }));
      await Promise.resolve();
      getComputedStyle(layer).transform;
      layer.getBoundingClientRect();
      workDurationsMs.push(performance.now() - workStartedAt);
      const timestamp = await nextFrame();
      intervalDurationsMs.push(timestamp - previous);
      previous = timestamp;
    }
    await nextFrame();
    return { workDurationsMs, intervalDurationsMs, startPan, endPan: readPan() };
  }, { frames: frameCount, direction });
}

async function waitForSaveState(page: Page, state: "dirty" | "saving" | "saved"): Promise<void> {
  await page.locator(`.save-status.is-${state}`).waitFor({ state: "visible", timeout: 10_000 });
}

async function editX(page: Page, delta: number): Promise<void> {
  const field = page.locator("label.inspector-field").filter({
    has: page.locator("span", { hasText: /^X$/ }),
  }).locator("input[type='number']").first();
  const current = Number(await field.inputValue());
  if (!Number.isFinite(current)) throw new Error("The selected node X field is not numeric.");
  await field.fill(String(current + delta));
  await waitForSaveState(page, "dirty");
}

async function measureAutosaveCommit(page: Page): Promise<{ durationMs: number; debounceMs: number }> {
  return page.evaluate(async () => {
    const observedAt = performance.now();
    let savingAt: number | null = null;
    const deadline = observedAt + 10_000;
    while (performance.now() < deadline) {
      if (document.querySelector(".save-status.is-saving")) savingAt ??= performance.now();
      if (savingAt !== null && document.querySelector(".save-status.is-saved")) {
        return { durationMs: performance.now() - savingAt, debounceMs: savingAt - observedAt };
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error("The editor autosave cycle did not finish within 10 seconds.");
  });
}

async function measureExplicitCommit(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>("button[title='Save now']");
    if (!button || button.disabled) throw new Error("The Save now button is unavailable.");
    const startedAt = performance.now();
    button.click();
    const deadline = startedAt + 10_000;
    while (performance.now() < deadline) {
      if (document.querySelector(".save-status.is-saved")) return performance.now() - startedAt;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error("The explicit editor commit did not finish within 10 seconds.");
  });
}

async function measureHistoryAction(page: Page, action: "open" | "refresh"): Promise<{ durationMs: number; rows: number }> {
  return page.evaluate(async (kind) => {
    performance.clearResourceTimings();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const button = kind === "open"
      ? buttons.find((candidate) => candidate.closest("nav[aria-label='Inspector utilities']")
        && candidate.textContent?.trim().toLowerCase() === "history")
      : buttons.find((candidate) => candidate.textContent?.includes("Refresh history"));
    if (!button) throw new Error(`The ${kind} history button is unavailable.`);
    const startedAt = performance.now();
    button.click();
    const deadline = startedAt + 10_000;
    while (performance.now() < deadline) {
      const requestFinished = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .some((entry) => entry.name.includes("/api/designs/") && entry.name.includes("/history") && entry.responseEnd > 0);
      const rows = document.querySelectorAll(".history-list .history-row").length;
      const loading = document.querySelector(".panel-loading");
      if (requestFinished && rows > 0 && !loading) return { durationMs: performance.now() - startedAt, rows };
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(`The ${kind} history request did not finish within 10 seconds.`);
  }, action);
}

async function currentRevision(request: APIRequestContext, designId: string): Promise<RevisionEnvelope> {
  return jsonResponse<RevisionEnvelope>(await request.get(`/api/designs/${encodeURIComponent(designId)}`));
}

async function measurePreviewValidation(
  request: APIRequestContext,
  fixture: PerformanceFixture,
  baseVersion: number,
  sample: number,
): Promise<{ durationMs: number; status: string }> {
  const startedAt = nodePerformance.now();
  const response = await request.post(`/api/designs/${encodeURIComponent(fixture.designId)}/previews`, {
    data: {
      baseVersion,
      operations: [{
        type: "update_node",
        node_id: fixture.mutableNodeId,
        patch: { metadata: { browser_performance_preview_sample: sample } },
      }],
    },
  });
  const result = await jsonResponse<Record<string, unknown>>(response);
  const durationMs = nodePerformance.now() - startedAt;
  if (result.canCommit !== true || result.status !== "ready") {
    throw new Error(`Preview sample ${sample} was not committable: ${JSON.stringify(result.diagnostics ?? null)}`);
  }
  return { durationMs, status: String(result.status) };
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("The render endpoint did not return a PNG file.");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function measureChromiumRender(
  request: APIRequestContext,
  fixture: PerformanceFixture,
): Promise<{ durationMs: number; mode: string; warning: string; width: number; height: number }> {
  const query = new URLSearchParams({ nodeId: fixture.rootId, maxSize: "1440" });
  const startedAt = nodePerformance.now();
  const response = await request.get(
    `/api/designs/${encodeURIComponent(fixture.designId)}/render.png?${query.toString()}`,
    { timeout: RELEASE_BUDGETS_MS.chromiumRenderHardTimeout },
  );
  if (!response.ok()) throw new Error(`Render failed with ${response.status()}: ${(await response.text()).slice(0, 2_000)}`);
  const png = await response.body();
  const durationMs = nodePerformance.now() - startedAt;
  const dimensions = pngDimensions(png);
  const headers = response.headers();
  await response.dispose();
  return {
    durationMs,
    mode: headers["x-designer-renderer"] ?? "missing",
    warning: headers["x-designer-render-warnings"] ?? "",
    ...dimensions,
  };
}

test("meets every 1,000-node browser interaction and Chromium render release budget", async ({
  browser,
  context,
  page,
  request,
}) => {
  test.slow();
  const fixture = await test.step("seed the deterministic 1,000-node project", () => createBrowserFixture(request));
  const designUrl = `/design/${encodeURIComponent(fixture.designId)}`;

  const initialSamples: InteractiveSample[] = [];
  await test.step("measure cold initial interactive load", async () => {
    for (let index = 0; index < SETTINGS.warmupIterations; index += 1) {
      await measureColdInteractiveLoad(context, designUrl);
    }
    for (let index = 0; index < SETTINGS.iterations; index += 1) {
      initialSamples.push(await measureColdInteractiveLoad(context, designUrl));
    }
  });

  await page.goto(designUrl, { waitUntil: "domcontentloaded" });
  const activePageReady = await waitForInteractive(page);
  expect(activePageReady.renderedNodeCount).toBe(PERFORMANCE_NODE_COUNT);

  const selectionDurations: number[] = [];
  await test.step("measure UI selection response", async () => {
    for (let index = 0; index < SETTINGS.warmupIterations; index += 1) {
      await measureSelectionResponse(page, fixture.selectionIds[index]!);
    }
    for (let index = 0; index < SETTINGS.iterations; index += 1) {
      selectionDurations.push(await measureSelectionResponse(
        page,
        fixture.selectionIds[index + SETTINGS.warmupIterations]!,
      ));
    }
  });

  const frameWorkDurations: number[] = [];
  const frameIntervals: number[] = [];
  const panMovements: number[] = [];
  await test.step("measure gesture frame pacing while panning the 1,000-node canvas", async () => {
    for (let index = 0; index < SETTINGS.warmupIterations; index += 1) {
      await measurePanFrames(page, SETTINGS.gestureFramesPerIteration, index % 2 === 0 ? 1 : -1);
    }
    for (let index = 0; index < SETTINGS.iterations; index += 1) {
      const sample = await measurePanFrames(page, SETTINGS.gestureFramesPerIteration, index % 2 === 0 ? 1 : -1);
      frameWorkDurations.push(...sample.workDurationsMs);
      frameIntervals.push(...sample.intervalDurationsMs);
      panMovements.push(Math.hypot(sample.endPan.x - sample.startPan.x, sample.endPan.y - sample.startPan.y));
    }
  });

  await measureSelectionResponse(page, fixture.mutableNodeId);
  const commitDurations: number[] = [];
  const commitModes: Array<"autosave" | "explicit"> = [];
  let autosaveDebounceMs = 0;
  await test.step("measure the editor commit pipeline and observe autosave", async () => {
    await editX(page, 0.125);
    const autosave = await measureAutosaveCommit(page);
    commitDurations.push(autosave.durationMs);
    commitModes.push("autosave");
    autosaveDebounceMs = autosave.debounceMs;

    for (let index = 1; index < SETTINGS.iterations; index += 1) {
      await editX(page, 0.125);
      commitDurations.push(await measureExplicitCommit(page));
      commitModes.push("explicit");
    }
  });

  const historyDurations: number[] = [];
  let historyRows = 0;
  await test.step("measure immutable history loading", async () => {
    const opened = await measureHistoryAction(page, "open");
    historyDurations.push(opened.durationMs);
    historyRows = opened.rows;
    for (let index = 1; index < SETTINGS.iterations; index += 1) {
      const refreshed = await measureHistoryAction(page, "refresh");
      historyDurations.push(refreshed.durationMs);
      historyRows = refreshed.rows;
    }
  });

  const latest = await currentRevision(request, fixture.designId);
  const previewDurations: number[] = [];
  const previewStatuses: string[] = [];
  await test.step("measure preview validation without rendering", async () => {
    for (let index = 0; index < SETTINGS.warmupIterations; index += 1) {
      await measurePreviewValidation(request, fixture, latest.version, -index - 1);
    }
    for (let index = 0; index < SETTINGS.iterations; index += 1) {
      const sample = await measurePreviewValidation(request, fixture, latest.version, index);
      previewDurations.push(sample.durationMs);
      previewStatuses.push(sample.status);
    }
  });

  const renderDurations: number[] = [];
  const rendererModes = new Set<string>();
  const rendererWarnings = new Set<string>();
  let renderWidth = 0;
  let renderHeight = 0;
  await test.step("measure full 1440 by 900 Chromium rendering", async () => {
    for (let index = 0; index < SETTINGS.warmupIterations; index += 1) {
      await measureChromiumRender(request, fixture);
    }
    for (let index = 0; index < SETTINGS.iterations; index += 1) {
      const sample = await measureChromiumRender(request, fixture);
      renderDurations.push(sample.durationMs);
      rendererModes.add(sample.mode);
      if (sample.warning) rendererWarnings.add(sample.warning);
      renderWidth = sample.width;
      renderHeight = sample.height;
    }
  });

  const root = latest.document.nodes[fixture.rootId];
  if (!root) throw new Error("The performance root frame disappeared.");
  const metrics = [
    metric(
      "browser.initial_interactive_load",
      "Cold navigation start through fonts and two painted editor frames",
      initialSamples.map((sample) => sample.durationMs),
      { p95Ms: RELEASE_BUDGETS_MS.initialInteractiveLoad },
    ),
    metric(
      "browser.selection_response",
      "Layer click through selected DOM state and Moveable controls",
      selectionDurations,
      { p95Ms: RELEASE_BUDGETS_MS.selectionResponse },
    ),
    metric(
      "browser.gesture_frame_budget",
      "Cadence-normalized presented-frame budget while wheel-pan updates are painted",
      frameIntervals.map(cadenceNormalizedFrameBudget),
      { p95Ms: RELEASE_BUDGETS_MS.gestureFrameP95, maxMs: RELEASE_BUDGETS_MS.gestureFrameMax },
    ),
    metric(
      "editor.local_commit_autosave",
      "Autosave/explicit editor save start through saved DOM state",
      commitDurations,
      { p95Ms: RELEASE_BUDGETS_MS.localCommit },
    ),
    metric(
      "editor.history_load",
      "History action through completed HTTP response and rendered revision rows",
      historyDurations,
      { p95Ms: RELEASE_BUDGETS_MS.historyLoad },
    ),
    metric(
      "server.preview_validation_without_render",
      "Preview HTTP validation, canonical snapshot persistence, and JSON response; no render request",
      previewDurations,
      { p95Ms: RELEASE_BUDGETS_MS.previewValidation },
    ),
    metric(
      "server.chromium_render_1440x900",
      "Full Playwright Chromium render request and PNG transfer",
      renderDurations,
      { p95Ms: RELEASE_BUDGETS_MS.chromiumRender, maxMs: RELEASE_BUDGETS_MS.chromiumRenderHardTimeout },
    ),
  ];

  const modes = [...rendererModes].sort();
  const warnings = [...rendererWarnings].sort();
  const frameIntervalSummary = summarizeTimings(frameIntervals);
  const frameWorkSummary = summarizeTimings(frameWorkDurations);
  const invariantsPassed = initialSamples.every((sample) => sample.renderedNodeCount === PERFORMANCE_NODE_COUNT)
    && panMovements.every((distance) => distance > 0)
    && frameIntervalSummary.maxMs <= RELEASE_BUDGETS_MS.gestureFrameMax
    && autosaveDebounceMs >= 700
    && autosaveDebounceMs <= 2_000
    && historyRows >= SETTINGS.iterations + 2
    && previewStatuses.every((status) => status === "ready")
    && modes.length === 1
    && modes[0] === "playwright"
    && warnings.length === 0
    && renderWidth === 1_440
    && renderHeight === 900;
  const report: BrowserPerformanceReport = {
    schemaVersion: 1,
    suite: "formaspec-1000-node-browser-release",
    releaseEvidence: true,
    fixture: {
      nodeCount: Object.keys(latest.document.nodes).length,
      rootWidth: root.layout.width,
      rootHeight: root.layout.height,
      operationBytes: fixture.operationBytes,
      historyRows,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      browserName: "chromium",
      browserVersion: browser.version(),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      viewport: page.viewportSize() ?? { width: 0, height: 0 },
    },
    settings: {
      iterations: SETTINGS.iterations,
      warmupIterations: SETTINGS.warmupIterations,
      gestureFramesPerIteration: SETTINGS.gestureFramesPerIteration,
      initialLoadCache: "cleared-before-each-sample",
      renderHardTimeoutMs: RELEASE_BUDGETS_MS.chromiumRenderHardTimeout,
    },
    renderer: {
      modes,
      warnings,
      width: renderWidth,
      height: renderHeight,
      pinnedChromium: modes.length === 1 && modes[0] === "playwright" && warnings.length === 0,
    },
    autosave: {
      observed: commitModes[0] === "autosave",
      debounceMs: round(autosaveDebounceMs),
      measuredCommitModes: commitModes,
    },
    gesture: {
      intervalSummary: {
        samples: frameIntervalSummary.samples,
        minMs: round(frameIntervalSummary.minMs),
        p50Ms: round(frameIntervalSummary.p50Ms),
        p95Ms: round(frameIntervalSummary.p95Ms),
        maxMs: round(frameIntervalSummary.maxMs),
      },
      intervalSamplesMs: frameIntervals.map(round),
      workSummary: {
        samples: frameWorkSummary.samples,
        minMs: round(frameWorkSummary.minMs),
        p50Ms: round(frameWorkSummary.p50Ms),
        p95Ms: round(frameWorkSummary.p95Ms),
        maxMs: round(frameWorkSummary.maxMs),
      },
      workSamplesMs: frameWorkDurations.map(round),
      framesOver50Ms: frameIntervals.filter((duration) => duration > RELEASE_BUDGETS_MS.gestureFrameMax).length,
    },
    preview: {
      rendered: false,
      statuses: previewStatuses,
    },
    metrics,
    passed: invariantsPassed && metrics.every((item) => item.passed),
    notes: [
      "Every percentile uses deterministic nearest-rank calculation with at least 20 measured samples.",
      "Initial-load samples clear Chromium's browser cache before navigation; setup and fixture creation are excluded.",
      "The autosave debounce is observed but excluded from the 500 ms commit budget; the measured path begins when saving starts.",
      "Gesture p95 uses 60 Hz cadence-normalized presentation budgets so sub-vsync scheduler jitter does not look like dropped work; raw rAF intervals and main-thread input/React/layout work are retained separately, and no raw frame may exceed 50 ms.",
      "Preview samples call only the preview endpoint and never call either render endpoint.",
      "The render gate rejects software fallback, system-Chrome fallback warnings, wrong PNG dimensions, and requests exceeding 15 seconds.",
    ],
  };

  const reportPath = test.info().outputPath("formaspec-browser-performance-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await test.info().attach("formaspec-browser-performance-report", {
    path: reportPath,
    contentType: "application/json",
  });
  process.stdout.write(`\n${reportTable(metrics)}\nOverall browser release gate: ${report.passed ? "PASS" : "FAIL"}\n`);

  expect.soft(report.fixture.nodeCount, "The measured project must contain exactly 1,000 nodes.").toBe(PERFORMANCE_NODE_COUNT);
  expect.soft(report.fixture.rootWidth).toBe(1_440);
  expect.soft(report.fixture.rootHeight).toBe(900);
  expect.soft(initialSamples.every((sample) => sample.renderedNodeCount === PERFORMANCE_NODE_COUNT), "Every load must render all 1,000 nodes before the interactive mark.").toBe(true);
  expect.soft(panMovements.every((distance) => distance > 0), "Every gesture sample must move the transformed canvas.").toBe(true);
  expect.soft(report.gesture.framesOver50Ms, "Raw gesture pacing must contain no frame over 50 ms.").toBe(0);
  expect.soft(report.autosave.observed, "At least one measured commit must be initiated by the real autosave timer.").toBe(true);
  expect.soft(report.autosave.debounceMs, "Autosave must start near its intentional 950 ms debounce.").toBeGreaterThanOrEqual(700);
  expect.soft(report.autosave.debounceMs, "Autosave must start near its intentional 950 ms debounce.").toBeLessThanOrEqual(2_000);
  expect.soft(historyRows, "History must include the fixture revisions and measured editor commits.").toBeGreaterThanOrEqual(SETTINGS.iterations + 2);
  expect.soft(previewStatuses.every((status) => status === "ready"), "Every preview validation must be committable.").toBe(true);
  expect.soft(modes, "The release render gate requires the Playwright renderer.").toEqual(["playwright"]);
  expect.soft(warnings, "Pinned Chromium must run without a system-browser or software fallback warning.").toEqual([]);
  expect.soft({ width: renderWidth, height: renderHeight }).toEqual({ width: 1_440, height: 900 });
  for (const item of metrics) {
    expect.soft(
      item.summary.p95Ms,
      `${item.id} p95 ${item.summary.p95Ms} ms exceeds ${item.budget.p95Ms} ms. Samples: ${JSON.stringify(item.samplesMs)}`,
    ).toBeLessThanOrEqual(item.budget.p95Ms);
    if (item.budget.maxMs !== undefined) {
      expect.soft(
        item.summary.maxMs,
        `${item.id} max ${item.summary.maxMs} ms exceeds ${item.budget.maxMs} ms. Samples: ${JSON.stringify(item.samplesMs)}`,
      ).toBeLessThanOrEqual(item.budget.maxMs);
    }
  }
  expect(report.passed, `Browser performance release report failed:\n${JSON.stringify(report, null, 2)}`).toBe(true);
});

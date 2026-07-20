import process from "node:process";

import {
  applyOperations,
  validateDesignDocument,
  type DesignDocument,
} from "@designer/core";

import { DesignerDatabase } from "../src/db/database.js";
import { EventHub } from "../src/events.js";
import { PngRenderer, type RenderResult } from "../src/render.js";
import { DesignerService, type PreviewResult } from "../src/service.js";
import {
  PERFORMANCE_NODE_COUNT,
  PERFORMANCE_TIMESTAMP,
  createCoreUpdateOperations,
  createServerTreeOperation,
  createThousandNodeFixture,
} from "./fixture.js";
import { sampleTask, summarizeTimings, type TimingSummary } from "./stats.js";

const FOUNDATION_CEILINGS_MS = {
  coreValidation: 1_500,
  coreApply: 4_000,
  serverPreview: 5_000,
  serverRender: 15_000,
} as const;

interface BenchmarkMetric {
  id: string;
  description: string;
  summary: TimingSummary;
  foundationCeilingMs: number;
  passed: boolean;
}

interface BenchmarkReport {
  schemaVersion: 1;
  suite: "formaspec-1000-node-foundation";
  releaseEvidence: false;
  fixture: {
    nodeCount: number;
    operationCount: number;
    operationBytes: number;
  };
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  settings: {
    warmupIterations: number;
    iterations: number;
    renderIterations: number;
    renderSkipped: boolean;
  };
  renderer: null | {
    mode: RenderResult["renderer"];
    width: number;
    height: number;
    warnings: string[];
  };
  metrics: BenchmarkMetric[];
  passed: boolean;
  notes: string[];
}

function hasArgument(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function environmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function environmentCeiling(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new Error(`${name} must be greater than 0 and at most 120000 milliseconds.`);
  }
  return parsed;
}

function metric(
  id: string,
  description: string,
  durationsMs: readonly number[],
  foundationCeilingMs: number,
): BenchmarkMetric {
  const summary = summarizeTimings(durationsMs);
  return {
    id,
    description,
    summary,
    foundationCeilingMs,
    passed: summary.p95Ms <= foundationCeilingMs,
  };
}

function milliseconds(value: number): string {
  return value.toFixed(2).padStart(10);
}

function printTextReport(report: BenchmarkReport): void {
  process.stdout.write("FormaSpec deterministic 1,000-node performance foundation\n");
  process.stdout.write(`Fixture: ${report.fixture.nodeCount} nodes; server create_tree payload: ${report.fixture.operationCount} operation, ${report.fixture.operationBytes} bytes\n`);
  process.stdout.write(`Samples: ${report.settings.iterations} measured after ${report.settings.warmupIterations} warmup; render samples: ${report.settings.renderSkipped ? "skipped" : report.settings.renderIterations}\n\n`);
  process.stdout.write("metric                               samples        p50 ms        p95 ms    ceiling ms  result\n");
  for (const item of report.metrics) {
    process.stdout.write(
      `${item.id.padEnd(36)}${String(item.summary.samples).padStart(7)}${milliseconds(item.summary.p50Ms)}${milliseconds(item.summary.p95Ms)}${milliseconds(item.foundationCeilingMs)}  ${item.passed ? "PASS" : "FAIL"}\n`,
    );
  }
  if (report.renderer) {
    process.stdout.write(`\nRenderer: ${report.renderer.mode}, ${report.renderer.width}x${report.renderer.height}\n`);
    for (const warning of report.renderer.warnings) process.stdout.write(`Renderer warning: ${warning}\n`);
  }
  process.stdout.write("\nThese are coarse regression ceilings for a service/core harness, not release-grade browser interaction evidence.\n");
  process.stdout.write(`Overall foundation gate: ${report.passed ? "PASS" : "FAIL"}\n`);
}

async function main(): Promise<void> {
  if (hasArgument("--help")) {
    process.stdout.write([
      "Usage: pnpm test:performance -- [--skip-render] [--json]",
      "",
      "Environment:",
      "  FORMASPEC_PERF_ITERATIONS=7               measured core/preview samples (3-30)",
      "  FORMASPEC_PERF_WARMUP_ITERATIONS=2        warmup samples (0-10)",
      "  FORMASPEC_PERF_RENDER_ITERATIONS=3        measured render samples (1-10)",
      "  FORMASPEC_PERF_VALIDATE_P95_MS=1500       foundation ceiling",
      "  FORMASPEC_PERF_APPLY_P95_MS=4000          foundation ceiling",
      "  FORMASPEC_PERF_PREVIEW_P95_MS=5000        foundation ceiling",
      "  FORMASPEC_PERF_RENDER_P95_MS=15000        foundation ceiling",
      "",
    ].join("\n"));
    return;
  }

  const settings = {
    warmupIterations: environmentInteger("FORMASPEC_PERF_WARMUP_ITERATIONS", 2, 0, 10),
    iterations: environmentInteger("FORMASPEC_PERF_ITERATIONS", 7, 3, 30),
    renderIterations: environmentInteger("FORMASPEC_PERF_RENDER_ITERATIONS", 3, 1, 10),
    renderSkipped: hasArgument("--skip-render"),
  };
  const ceilings = {
    coreValidation: environmentCeiling("FORMASPEC_PERF_VALIDATE_P95_MS", FOUNDATION_CEILINGS_MS.coreValidation),
    coreApply: environmentCeiling("FORMASPEC_PERF_APPLY_P95_MS", FOUNDATION_CEILINGS_MS.coreApply),
    serverPreview: environmentCeiling("FORMASPEC_PERF_PREVIEW_P95_MS", FOUNDATION_CEILINGS_MS.serverPreview),
    serverRender: environmentCeiling("FORMASPEC_PERF_RENDER_P95_MS", FOUNDATION_CEILINGS_MS.serverRender),
  };
  const fixture = createThousandNodeFixture();
  const operations = createCoreUpdateOperations(fixture);
  const sourceValidation = validateDesignDocument(fixture.document);
  if (!sourceValidation.success) throw new Error("The deterministic performance fixture is invalid.");

  const validationSamples = await sampleTask(
    () => validateDesignDocument(fixture.document),
    settings,
  );
  if (!validationSamples.lastValue.success) throw new Error("Core validation rejected the performance fixture.");

  const applySamples = await sampleTask(
    () => applyOperations(fixture.document, operations, {
      expectedRevision: fixture.document.revision,
      now: PERFORMANCE_TIMESTAMP,
    }),
    settings,
  );
  if (Object.keys(applySamples.lastValue.document.nodes).length !== PERFORMANCE_NODE_COUNT) {
    throw new Error("Core operations changed the fixture node count.");
  }

  const database = new DesignerDatabase(":memory:");
  const events = new EventHub();
  const service = new DesignerService(database, events, 900);
  let renderer: PngRenderer | undefined;
  try {
    const created = service.createDesign("performance-actor", {
      name: "FormaSpec performance service fixture",
      preset: "web",
      idempotencyKey: "performance-create-0001",
    });
    const targetRootId = created.document.pages[0]?.children[0];
    if (!targetRootId) throw new Error("The server performance design has no root frame.");
    const treeOperation = createServerTreeOperation(fixture, targetRootId);
    const operationBytes = Buffer.byteLength(JSON.stringify([treeOperation]), "utf8");
    if (operationBytes > 1_048_576) {
      throw new Error(`The deterministic server preview payload is ${operationBytes} bytes and exceeds 1 MiB.`);
    }

    const previewSamples = await sampleTask(
      () => service.createPreview("performance-actor", created.document.id, {
        baseVersion: created.design.version,
        operations: [treeOperation],
      }),
      settings,
    );
    const preview: PreviewResult = previewSamples.lastValue;
    if (!preview.canCommit || Object.keys(preview.document.nodes).length !== PERFORMANCE_NODE_COUNT) {
      throw new Error("The server preview did not produce a committable 1,000-node document.");
    }

    const metrics: BenchmarkMetric[] = [
      metric("core.validate_document", "Strict schema and structural lint", validationSamples.durationsMs, ceilings.coreValidation),
      metric("core.apply_25_updates", "Command application plus result validation", applySamples.durationsMs, ceilings.coreApply),
      metric("server.preview_validate_persist", "Authorization, validation, snapshot, diagnostics, and preview persistence", previewSamples.durationsMs, ceilings.serverPreview),
    ];
    let rendererReport: BenchmarkReport["renderer"] = null;

    if (!settings.renderSkipped) {
      renderer = new PngRenderer({
        timeoutMs: 15_000,
        maxPixels: 2_000_000,
        concurrency: 1,
        queueLimit: 1,
        allowSoftwareFallback: true,
        allowSystemChrome: false,
      });
      const renderSamples = await sampleTask(
        () => renderer!.render(preview.document, { nodeId: targetRootId, maxSize: 512 }, () => null),
        { warmupIterations: 1, iterations: settings.renderIterations },
      );
      metrics.push(metric(
        "server.render_512px",
        "Deterministic server render with external requests blocked",
        renderSamples.durationsMs,
        ceilings.serverRender,
      ));
      rendererReport = {
        mode: renderSamples.lastValue.renderer,
        width: renderSamples.lastValue.width,
        height: renderSamples.lastValue.height,
        warnings: renderSamples.lastValue.warnings,
      };
    }

    const report: BenchmarkReport = {
      schemaVersion: 1,
      suite: "formaspec-1000-node-foundation",
      releaseEvidence: false,
      fixture: {
        nodeCount: PERFORMANCE_NODE_COUNT,
        operationCount: 1,
        operationBytes,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      settings,
      renderer: rendererReport,
      metrics,
      passed: metrics.every((item) => item.passed),
      notes: [
        "The fixture and operation payload are deterministic; wall-clock timing remains machine-dependent.",
        "The preview metric exercises the service layer and SQLite persistence without HTTP transport.",
        "The render metric reports whether Playwright or the development-only software fallback was measured.",
        "Canvas load, selection latency, gesture frames, DPR, and visual-regression budgets require browser E2E instrumentation.",
      ],
    };

    if (hasArgument("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printTextReport(report);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await renderer?.close();
    database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`FormaSpec performance foundation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export type { BenchmarkReport };

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createImageNode,
  createSequentialIdFactory,
  createStarterDocument,
  type DesignDocument,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { PngRenderer, type RenderHealth, type RenderOptions, type RenderResult } from "./render.js";
import { RendererSocketClient, startRendererWorker, type RendererWorkerHandle } from "./renderer-ipc.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const onePixelDataUrl = `data:image/png;base64,${onePixelPng.toString("base64")}`;
const normalizationLimits = Object.freeze({ maxBytes: 1024, maxPixels: 100 });

function documentWithImage(): { document: DesignDocument; assetId: string } {
  const ids = createSequentialIdFactory("renderer-ipc");
  const document = createStarterDocument({ preset: "phone", idFactory: ids });
  const assetId = ids("asset");
  const image = createImageNode({ asset_id: assetId, layout: { width: 32, height: 32 } }, ids);
  const frame = document.nodes[document.pages[0]?.children[0] as string];
  if (!frame || !("children" in frame)) throw new Error("Expected starter frame.");
  frame.children.push(image.id);
  document.nodes[image.id] = image;
  document.assets[assetId] = {
    id: assetId,
    name: "avatar.png",
    kind: "image",
    mime_type: "image/png",
    size_bytes: onePixelPng.length,
    storage_key: `sha256/${"a".repeat(64)}.png`,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    metadata: {},
  };
  return { document, assetId };
}

describe("renderer worker IPC", () => {
  const workers: RendererWorkerHandle[] = [];
  const applications: DesignerApplication[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((application) => application.app.close()));
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
  });

  async function socketPath(): Promise<string> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-render-ipc-"));
    temporaryDirectories.push(directory);
    return path.join(directory, "renderer.sock");
  }

  it("round-trips health, documents, options, referenced assets, and PNG output", async () => {
    const socket = await socketPath();
    const { document, assetId } = documentWithImage();
    let observedAsset: string | null | undefined;
    const backend = {
      async health(): Promise<RenderHealth> {
        return { ok: true, mode: "in-process", renderer: "playwright", softwareFallback: false, warnings: [] };
      },
      async render(
        receivedDocument: DesignDocument,
        options: RenderOptions,
        assetDataUrl: (id: string) => string | null,
      ): Promise<RenderResult> {
        expect(receivedDocument.id).toBe(document.id);
        expect(options).toEqual({
          pageIds: [document.pages[0]!.id, document.pages[1]!.id],
          maxSize: 512,
        });
        observedAsset = assetDataUrl(assetId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { png: onePixelPng, width: 1, height: 1, renderer: "playwright", warnings: [] };
      },
      async normalizeRaster(data: Buffer) {
        expect(data).toEqual(onePixelPng);
        return { data: onePixelPng, mimeType: "image/png" as const, width: 1, height: 1 };
      },
      async close() {},
    };
    workers.push(await startRendererWorker({
      socketPath: socket,
      renderer: backend,
      timeoutMs: 2_000,
      normalizationLimits,
    }));
    const renderer = new PngRenderer({
      socketPath: socket,
      timeoutMs: 2_000,
      allowSoftwareFallback: true,
    });

    await expect(renderer.health()).resolves.toMatchObject({
      ok: true,
      mode: "worker",
      renderer: "playwright",
      contract: {
        ipcProtocolVersion: 2,
        rendererVersion: "3",
        rasterNormalizerVersion: "1",
        maxBytes: normalizationLimits.maxBytes,
        maxPixels: normalizationLimits.maxPixels,
      },
    });
    document.pages.push({
      id: "page_renderer_ipc_contact_sheet_0001",
      name: "Second IPC page",
      children: [],
      background: "#ffffff",
      viewport: { width: 390, height: 844 },
      archived: false,
      metadata: {},
    });
    const result = await renderer.render(document, {
      pageIds: [document.pages[0]!.id, document.pages[1]!.id],
      maxSize: 512,
    }, (id) => id === assetId ? onePixelDataUrl : null);

    expect(observedAsset).toBe(onePixelDataUrl);
    expect(result.png).toEqual(onePixelPng);
    expect(result.renderer).toBe("playwright");
    await expect(renderer.normalizeRaster(onePixelPng, {
      sourceMimeType: "image/png",
      sourceWidth: 1,
      sourceHeight: 1,
      maxBytes: normalizationLimits.maxBytes,
      maxPixels: normalizationLimits.maxPixels,
    })).resolves.toMatchObject({ data: onePixelPng, mimeType: "image/png", width: 1, height: 1 });
  });

  it("preserves structured worker failures and never falls back when the socket disappears", async () => {
    const socket = await socketPath();
    const { document } = documentWithImage();
    const backend = {
      async health(): Promise<RenderHealth> {
        return { ok: true, mode: "in-process", renderer: "playwright", softwareFallback: false, warnings: [] };
      },
      async render(): Promise<RenderResult> {
        throw new DomainError("RATE_LIMITED", "Worker queue is full.", 429, { retryable: true });
      },
      async normalizeRaster() {
        throw new DomainError("UNSUPPORTED_ASSET", "Raster decode failed.", 422);
      },
      async close() {},
    };
    const worker = await startRendererWorker({
      socketPath: socket,
      renderer: backend,
      timeoutMs: 2_000,
      normalizationLimits,
    });
    workers.push(worker);
    const renderer = new PngRenderer({ socketPath: socket, timeoutMs: 2_000, allowSoftwareFallback: true });

    await expect(renderer.render(document, {}, () => null)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      retryable: true,
    });
    await expect(renderer.normalizeRaster(onePixelPng, {
      sourceMimeType: "image/png",
      sourceWidth: 1,
      sourceHeight: 1,
      maxBytes: normalizationLimits.maxBytes,
      maxPixels: normalizationLimits.maxPixels,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_ASSET", statusCode: 422 });

    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    await expect(renderer.render(document, {}, () => null)).rejects.toMatchObject({
      code: "RENDER_FAILED",
      statusCode: 503,
    });
  });

  it("rejects IPC requests above the configured frame limit before connecting", async () => {
    const socket = await socketPath();
    const { document } = documentWithImage();
    const client = new RendererSocketClient({ socketPath: socket, timeoutMs: 1_000, maxMessageBytes: 512 });

    await expect(client.render(document, {}, {})).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("fails explicitly when API and worker raster limits diverge", async () => {
    const socket = await socketPath();
    let normalizeCalls = 0;
    const backend = {
      async health(): Promise<RenderHealth> {
        return { ok: true, mode: "in-process", renderer: "playwright", softwareFallback: false, warnings: [] };
      },
      async render(): Promise<RenderResult> {
        return { png: onePixelPng, width: 1, height: 1, renderer: "playwright", warnings: [] };
      },
      async normalizeRaster() {
        normalizeCalls += 1;
        return { data: onePixelPng, mimeType: "image/png" as const, width: 1, height: 1 };
      },
      async close() {},
    };
    workers.push(await startRendererWorker({
      socketPath: socket,
      renderer: backend,
      timeoutMs: 2_000,
      normalizationLimits,
    }));
    const client = new RendererSocketClient({ socketPath: socket, timeoutMs: 2_000 });

    await expect(client.normalizeRaster(onePixelPng, {
      sourceMimeType: "image/png",
      sourceWidth: 1,
      sourceHeight: 1,
      maxBytes: normalizationLimits.maxBytes / 2,
      maxPixels: normalizationLimits.maxPixels,
    })).rejects.toMatchObject({
      code: "RENDER_FAILED",
      statusCode: 503,
      message: expect.stringMatching(/do not match the API configuration/),
      details: {
        worker: normalizationLimits,
        api: { maxBytes: normalizationLimits.maxBytes / 2, maxPixels: normalizationLimits.maxPixels },
      },
    });
    expect(normalizeCalls).toBe(0);
  });

  it("reports worker readiness and fails API readiness when the worker is unavailable", async () => {
    const socket = await socketPath();
    const backend = {
      async health(): Promise<RenderHealth> {
        return { ok: true, mode: "in-process", renderer: "playwright", softwareFallback: false, warnings: [] };
      },
      async render(): Promise<RenderResult> {
        return { png: onePixelPng, width: 1, height: 1, renderer: "playwright", warnings: [] };
      },
      async normalizeRaster() {
        return { data: onePixelPng, mimeType: "image/png" as const, width: 1, height: 1 };
      },
      async close() {},
    };
    const worker = await startRendererWorker({
      socketPath: socket,
      renderer: backend,
      timeoutMs: 2_000,
      normalizationLimits,
    });
    workers.push(worker);
    const application = await buildApplication(loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: path.dirname(socket),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_RENDER_SOCKET: socket,
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);
    await application.app.ready();

    const healthy = await application.app.inject({ method: "GET", url: "/health/render" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({ ok: true, mode: "worker", renderer: "playwright" });

    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    const renderUnavailable = await application.app.inject({ method: "GET", url: "/health/render" });
    expect(renderUnavailable.statusCode).toBe(503);
    expect(renderUnavailable.json()).toMatchObject({ ok: false, mode: "worker", renderer: "unavailable" });
    const readinessUnavailable = await application.app.inject({ method: "GET", url: "/health/ready" });
    expect(readinessUnavailable.statusCode).toBe(503);
    expect(readinessUnavailable.json()).toMatchObject({ ok: false, database: "ready" });
  });

  it("survives a client timeout while an accepted render is still completing", async () => {
    const socket = await socketPath();
    const { document } = documentWithImage();
    const backend = {
      async health(): Promise<RenderHealth> {
        return { ok: true, mode: "in-process", renderer: "playwright", softwareFallback: false, warnings: [] };
      },
      async render(): Promise<RenderResult> {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { png: onePixelPng, width: 1, height: 1, renderer: "playwright", warnings: [] };
      },
      async normalizeRaster() {
        return { data: onePixelPng, mimeType: "image/png" as const, width: 1, height: 1 };
      },
      async close() {},
    };
    workers.push(await startRendererWorker({
      socketPath: socket,
      renderer: backend,
      timeoutMs: 1_000,
      normalizationLimits,
    }));
    const impatientClient = new RendererSocketClient({ socketPath: socket, timeoutMs: 25 });

    await expect(impatientClient.render(document, {}, {})).rejects.toMatchObject({ code: "RENDER_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 125));
    await expect(impatientClient.health()).resolves.toMatchObject({ ok: true, mode: "worker" });
  });
});

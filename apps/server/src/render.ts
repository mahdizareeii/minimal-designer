import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import {
  V2CompatibilityError,
  nodeToCss,
  toV1CompatibleDesignDocument,
  type AnyDesignDocument,
  type CssStyle,
  type DesignDocument,
  type DesignNode,
  type LayoutMode,
} from "@designer/core";

import type {
  NormalizedImageAsset,
  RasterNormalizationContext,
  RasterNormalizationOptions,
} from "./assets.js";
import { DomainError } from "./errors.js";
import { hashPayload } from "./ids.js";
import { RendererSocketClient } from "./renderer-ipc.js";
import type { RenderJobFailureRecord, RenderJobRecorder } from "./render-job-store.js";

export interface RenderOptions {
  pageId?: string;
  nodeId?: string;
  maxSize?: number;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  renderer: "playwright" | "software";
  warnings: string[];
}

export interface RenderHealth {
  ok: true;
  mode: "in-process" | "worker";
  renderer: "playwright" | "software";
  softwareFallback: boolean;
  warnings: string[];
}

export interface PngRendererOptions {
  timeoutMs?: number;
  maxPixels?: number;
  concurrency?: number;
  queueLimit?: number;
  allowSoftwareFallback?: boolean;
  allowSystemChrome?: boolean;
  socketPath?: string;
  ipcMaxMessageBytes?: number;
  jobRecorder?: RenderJobRecorder;
}

interface BrowserNormalizedRaster {
  ok: true;
  width: number;
  height: number;
  pngBase64: string;
}

type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function tiffOrientation(data: Buffer): ExifOrientation {
  const tiffOffset = data.subarray(0, 6).equals(Buffer.from("Exif\0\0", "binary")) ? 6 : 0;
  if (data.length < tiffOffset + 8) return 1;
  const littleEndian = data[tiffOffset] === 0x49 && data[tiffOffset + 1] === 0x49;
  const bigEndian = data[tiffOffset] === 0x4d && data[tiffOffset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return 1;
  const readUInt16 = (offset: number): number | undefined => {
    if (offset < 0 || offset + 2 > data.length) return undefined;
    return littleEndian ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
  };
  const readUInt32 = (offset: number): number | undefined => {
    if (offset < 0 || offset + 4 > data.length) return undefined;
    return littleEndian ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  };
  if (readUInt16(tiffOffset + 2) !== 42) return 1;
  const relativeIfdOffset = readUInt32(tiffOffset + 4);
  if (relativeIfdOffset === undefined) return 1;
  const ifdOffset = tiffOffset + relativeIfdOffset;
  const entryCount = readUInt16(ifdOffset);
  if (entryCount === undefined || entryCount > 4_096) return 1;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > data.length) return 1;
    if (readUInt16(entryOffset) !== 0x0112) continue;
    const type = readUInt16(entryOffset + 2);
    const count = readUInt32(entryOffset + 4);
    if (type !== 3 || count !== 1) return 1;
    const orientation = readUInt16(entryOffset + 8);
    return orientation !== undefined && orientation >= 1 && orientation <= 8
      ? orientation as ExifOrientation
      : 1;
  }
  return 1;
}

function webpExifOrientation(data: Buffer): ExifOrientation {
  if (data.length < 12
    || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP") return 1;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + length;
    const nextOffset = payloadEnd + (length % 2);
    if (payloadEnd > data.length || nextOffset > data.length) return 1;
    if (type === "EXIF") return tiffOrientation(data.subarray(payloadOffset, payloadEnd));
    offset = nextOffset;
  }
  return 1;
}

type Color = [number, number, number, number];

let embeddedFontCss: string | undefined;

function findFont(assetsDirectory: string, prefix: string): string | undefined {
  if (!fs.existsSync(assetsDirectory)) return undefined;
  const filename = fs.readdirSync(assetsDirectory).find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".woff2"));
  return filename ? path.join(assetsDirectory, filename) : undefined;
}

function fontDataUrl(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  return `data:font/woff2;base64,${fs.readFileSync(filename).toString("base64")}`;
}

function fontFaces(): string {
  if (embeddedFontCss !== undefined) return embeddedFontCss;
  const assetsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/assets");
  const inter = fontDataUrl(findFont(assetsDirectory, "inter-latin-wght-normal-"));
  const vazirmatnArabic = fontDataUrl(findFont(assetsDirectory, "vazirmatn-arabic-wght-normal-"));
  const vazirmatnLatin = fontDataUrl(findFont(assetsDirectory, "vazirmatn-latin-wght-normal-"));
  embeddedFontCss = [
    inter
      ? `@font-face{font-family:Inter;font-style:normal;font-display:block;font-weight:100 900;src:url("${inter}") format("woff2");unicode-range:U+0000-024F}`
      : '@font-face{font-family:Inter;src:local("Inter")}',
    vazirmatnArabic
      ? `@font-face{font-family:Vazirmatn;font-style:normal;font-display:block;font-weight:100 900;src:url("${vazirmatnArabic}") format("woff2");unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF}`
      : '@font-face{font-family:Vazirmatn;src:local("Vazirmatn")}',
    vazirmatnLatin
      ? `@font-face{font-family:Vazirmatn;font-style:normal;font-display:block;font-weight:100 900;src:url("${vazirmatnLatin}") format("woff2");unicode-range:U+0000-024F}`
      : "",
  ].join("");
  return embeddedFontCss;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function literal<T>(value: T | { token_id: string } | undefined, document: DesignDocument, fallback: T): T {
  if (value && typeof value === "object" && "token_id" in value) {
    const token = document.tokens[value.token_id];
    return (token?.value as T | undefined) ?? fallback;
  }
  return (value as T | undefined) ?? fallback;
}

function colorValue(value: unknown, document: DesignDocument, fallback = "transparent"): string {
  const resolved = literal(value as string | { token_id: string } | undefined, document, fallback);
  if (typeof resolved !== "string") return fallback;
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,% ]+\)|hsla?\([0-9.,% deg]+\)|transparent|white|black)$/.test(resolved)) return resolved;
  return fallback;
}

function numberValue(value: unknown, document: DesignDocument, fallback = 0): number {
  const resolved = literal(value as number | { token_id: string } | undefined, document, fallback);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : fallback;
}

const allowedCssProperties = new Set([
  "position", "left", "top", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "transform", "display", "flexDirection", "gap", "rowGap", "columnGap", "flexWrap",
  "gridTemplateColumns", "padding", "alignItems", "justifyContent", "backgroundColor", "color", "opacity",
  "border", "borderRadius", "boxShadow", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "letterSpacing", "textAlign", "textDecoration", "textTransform", "fontStyle", "overflow",
  "objectPosition", "cursor", "pointerEvents", "objectFit",
]);

function safeCssValue(property: string, value: string | number): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (/[;{}\u0000-\u001f]/.test(value) || /url\s*\(|@import|expression\s*\(/i.test(value)) return null;
  if (property === "fontFamily" && !/^[\p{L}\p{N} _,'"-]+$/u.test(value)) return null;
  return value;
}

function cssPropertyName(property: string): string {
  return property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function cssDeclarations(style: CssStyle): string {
  const declarations: string[] = [];
  for (const [property, value] of Object.entries(style)) {
    if (!allowedCssProperties.has(property)) continue;
    const safe = safeCssValue(property, value);
    if (safe !== null) declarations.push(`${cssPropertyName(property)}:${safe}`);
  }
  declarations.push("box-sizing:border-box", "isolation:isolate");
  return declarations.join(";");
}

function renderNode(
  nodeId: string,
  document: DesignDocument,
  assetDataUrl: (id: string) => string | null,
  parentLayoutMode: LayoutMode = "absolute",
  isRoot = false,
): string {
  const node = document.nodes[nodeId];
  if (!node) return "";
  const children = "children" in node
    ? node.children.map((childId) => renderNode(childId, document, assetDataUrl, node.layout.mode)).join("")
    : "";
  let content = children;
  let attributes = "";
  const containerDirection = node.metadata.text_direction;
  if ((containerDirection === "ltr" || containerDirection === "rtl") && node.type !== "text") {
    attributes = ` dir="${containerDirection}"`;
  }
  if (node.type === "text") {
    const direction = node.direction ?? "auto";
    attributes = ` dir="${direction}"`;
    content = `<span style="white-space:pre-wrap;overflow-wrap:anywhere;width:100%">${escapeHtml(node.content)}</span>`;
  }
  if (node.type === "image" && node.asset_id) {
    const source = assetDataUrl(node.asset_id);
    content = source
      ? `<img src="${source}" alt="${escapeHtml(node.alt)}" style="width:100%;height:100%;object-fit:${node.object_fit}" />`
      : `<span style="margin:auto;color:#6b7280">Missing image</span>`;
  }
  if (node.type === "icon") content = `<span aria-label="${escapeHtml(node.label ?? node.icon_name)}" style="margin:auto;font-size:24px">◇</span>`;
  if (node.type === "instance") content = `<span style="margin:auto;color:#6b7280">${escapeHtml(node.name)}</span>`;
  const css = nodeToCss(node, document, {
    parentLayoutMode,
    includePosition: !isRoot,
  });
  if (node.archived) css.display = "none";
  if (isRoot) {
    css.position = "relative";
    css.left = "0";
    css.top = "0";
    css.width = `${node.layout.width}px`;
    css.height = `${node.layout.height}px`;
  }
  return `<div data-node-id="${escapeHtml(node.id)}"${attributes} style="${escapeHtml(cssDeclarations(css))}">${content}</div>`;
}

function renderHtml(document: DesignDocument, options: RenderOptions, assetDataUrl: (id: string) => string | null): { html: string; width: number; height: number } {
  const page = options.pageId ? document.pages.find((candidate) => candidate.id === options.pageId) : document.pages.find((candidate) => !candidate.archived);
  if (!page) throw new DomainError("RENDER_FAILED", "The design has no renderable page.", 422);
  const target = options.nodeId ? document.nodes[options.nodeId] : undefined;
  if (options.nodeId && !target) throw new DomainError("NOT_FOUND", "Render target node not found.", 404);
  const naturalWidth = target?.layout.width ?? page.viewport?.width ?? 1440;
  const naturalHeight = target?.layout.height ?? page.viewport?.height ?? 900;
  const maxSize = Math.max(64, Math.min(options.maxSize ?? 2048, 4096));
  const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const body = target
    ? renderNode(target.id, document, assetDataUrl, "absolute", true)
    : page.children.map((nodeId) => renderNode(nodeId, document, assetDataUrl, "absolute")).join("");
  return {
    width,
    height,
    html: `<!doctype html><html${page.metadata.text_direction === "ltr" || page.metadata.text_direction === "rtl" ? ` dir="${page.metadata.text_direction}"` : ""}><head><meta charset="utf-8"><style>${fontFaces()}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:${colorValue(page.background, document, "#ffffff")};transform-origin:top left;transform:scale(${scale});width:${naturalWidth}px;height:${naturalHeight}px;font-family:Inter,Vazirmatn,system-ui,sans-serif}</style></head><body>${body}</body></html>`,
  };
}

function parseColor(value: unknown, document: DesignDocument, fallback: Color): Color {
  const raw = colorValue(value, document, "");
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(raw);
  if (!match?.[1]) return fallback;
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
    match[2] ? Number.parseInt(match[2], 16) : 255,
  ];
}

function drawRect(pixels: Buffer, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Color): void {
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(width, Math.ceil(x + rectWidth));
  const endY = Math.min(height, Math.ceil(y + rectHeight));
  for (let row = startY; row < endY; row += 1) {
    for (let column = startX; column < endX; column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (width * 4 + 1);
    scanlines[destination] = 0;
    rgba.copy(scanlines, destination + 1, row * width * 4, (row + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function softwareRender(document: DesignDocument, options: RenderOptions): RenderResult {
  const page = options.pageId ? document.pages.find((candidate) => candidate.id === options.pageId) : document.pages.find((candidate) => !candidate.archived);
  if (!page) throw new DomainError("RENDER_FAILED", "The design has no renderable page.", 422);
  const target = options.nodeId ? document.nodes[options.nodeId] : undefined;
  const naturalWidth = target?.layout.width ?? page.viewport?.width ?? 1440;
  const naturalHeight = target?.layout.height ?? page.viewport?.height ?? 900;
  const maxSize = Math.max(64, Math.min(options.maxSize ?? 2048, 4096));
  const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const pixels = Buffer.alloc(width * height * 4);
  drawRect(pixels, width, height, 0, 0, width, height, parseColor(page.background, document, [255, 255, 255, 255]));

  const visit = (nodeId: string, parentX: number, parentY: number, root = false): void => {
    const node = document.nodes[nodeId];
    if (!node || node.archived || !node.visible) return;
    const x = root ? 0 : parentX + node.layout.x;
    const y = root ? 0 : parentY + node.layout.y;
    let fill = parseColor(node.style.fill, document, [0, 0, 0, 0]);
    if (node.type === "text" && fill[3] === 0) fill = parseColor(node.style.color, document, [31, 41, 55, 255]);
    drawRect(pixels, width, height, x * scale, y * scale, node.layout.width * scale, node.layout.height * scale, fill);
    if ("children" in node) for (const childId of node.children) visit(childId, x, y);
  };
  if (target) visit(target.id, 0, 0, true);
  else for (const rootId of page.children) visit(rootId, 0, 0);
  return {
    png: encodeRgbaPng(width, height, pixels),
    width,
    height,
    renderer: "software",
    warnings: ["Chromium rendering was unavailable; a simplified software preview was returned. Run `pnpm exec playwright install chromium` or install Google Chrome for full-fidelity renders."],
  };
}

function boundedJobText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function renderJobFailure(error: unknown): RenderJobFailureRecord {
  if (error instanceof DomainError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The render job failed unexpectedly.",
    retryable: true,
  };
}

export class PngRenderer {
  #browser: Browser | null = null;
  #playwrightUnavailable = false;
  #browserWarning: string | null = null;
  readonly #timeoutMs: number;
  readonly #maxPixels: number;
  readonly #concurrency: number;
  readonly #queueLimit: number;
  readonly #allowSoftwareFallback: boolean;
  readonly #allowSystemChrome: boolean;
  readonly #remoteClient: RendererSocketClient | null;
  readonly #jobRecorder: RenderJobRecorder | null;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(options: PngRendererOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxPixels = options.maxPixels ?? 32_000_000;
    this.#concurrency = options.concurrency ?? 2;
    this.#queueLimit = options.queueLimit ?? 32;
    this.#allowSoftwareFallback = options.allowSoftwareFallback ?? false;
    this.#allowSystemChrome = options.allowSystemChrome ?? false;
    this.#jobRecorder = options.jobRecorder ?? null;
    this.#remoteClient = options.socketPath
      ? new RendererSocketClient({
        socketPath: options.socketPath,
        timeoutMs: this.#timeoutMs + 1_000,
        ...(options.ipcMaxMessageBytes === undefined ? {} : { maxMessageBytes: options.ipcMaxMessageBytes }),
      })
      : null;
  }

  async render(
    document: AnyDesignDocument,
    options: RenderOptions,
    assetDataUrl: (id: string) => string | null,
  ): Promise<RenderResult> {
    const documentSha256 = hashPayload(document);
    const jobId = this.#jobRecorder?.queue({
      kind: "render",
      requestHash: hashPayload({ kind: "render", documentSha256, options }),
      requestMetadata: {
        documentSha256,
        schemaVersion: document.schema_version,
        options: {
          ...(options.pageId === undefined ? {} : { pageId: boundedJobText(options.pageId) }),
          ...(options.nodeId === undefined ? {} : { nodeId: boundedJobText(options.nodeId) }),
          ...(options.maxSize === undefined ? {} : { maxSize: options.maxSize }),
        },
      },
      documentId: document.id,
      documentRevision: document.revision,
    }) ?? null;
    try {
      const result = await this.#render(document, options, assetDataUrl, () => {
        if (jobId) this.#jobRecorder!.start(jobId);
      });
      if (jobId) {
        this.#jobRecorder!.succeed(jobId, {
          output: result.png,
          width: result.width,
          height: result.height,
          renderer: result.renderer,
          warnings: result.warnings,
        });
      }
      return result;
    } catch (error) {
      if (jobId) {
        try {
          this.#jobRecorder!.fail(jobId, renderJobFailure(error));
        } catch (recordingError) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "FormaSpec could not persist the render-job terminal state.",
            500,
            { retryable: true, cause: recordingError },
          );
        }
      }
      throw error;
    }
  }

  async #acquire(): Promise<() => void> {
    if (this.#active >= this.#concurrency) {
      if (this.#waiters.length >= this.#queueLimit) {
        throw new DomainError("RATE_LIMITED", "The render queue is full; retry later.", 429, { retryable: true });
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiters.shift()?.();
    };
  }

  async #ensureBrowser(): Promise<Browser | null> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#browser = null;
    if (this.#playwrightUnavailable) return null;
    try {
      this.#browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-domain-reliability",
          "--disable-features=MediaRouter,OptimizationHints,Translate",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-first-run",
        ],
      });
      this.#browserWarning = null;
      return this.#browser;
    } catch {
      if (this.#allowSystemChrome) try {
        this.#browser = await chromium.launch({ headless: true, channel: "chrome" });
        this.#browserWarning = "Using system Chrome because Playwright-managed Chromium is not installed.";
        return this.#browser;
      } catch {
        this.#playwrightUnavailable = true;
        return null;
      }
      this.#playwrightUnavailable = true;
      return null;
    }
  }

  async #render(
    document: AnyDesignDocument,
    options: RenderOptions,
    assetDataUrl: (id: string) => string | null,
    onStarted: () => void,
  ): Promise<RenderResult> {
    if (this.#remoteClient) {
      const assets: Record<string, string | null> = {};
      for (const node of Object.values(document.nodes)) {
        if (node.type === "image" && node.asset_id && !(node.asset_id in assets)) {
          assets[node.asset_id] = assetDataUrl(node.asset_id);
        }
      }
      onStarted();
      return this.#remoteClient.render(document, options, assets);
    }
    let compatibleDocument: DesignDocument;
    try {
      compatibleDocument = toV1CompatibleDesignDocument(document);
    } catch (error) {
      if (error instanceof V2CompatibilityError) {
        throw new DomainError("UNSUPPORTED_DOCUMENT_FEATURE", error.message, 422, {
          details: { issues: error.issues },
        });
      }
      throw error;
    }
    const release = await this.#acquire();
    let context: BrowserContext | null = null;
    try {
      onStarted();
      const browser = await this.#ensureBrowser();
      if (!browser) {
        if (this.#allowSoftwareFallback) return softwareRender(compatibleDocument, options);
        throw new DomainError("RENDER_FAILED", "Pinned Chromium is unavailable.", 503, { retryable: true });
      }
      const rendered = renderHtml(compatibleDocument, options, assetDataUrl);
      if (rendered.width * rendered.height > this.#maxPixels) {
        throw new DomainError("PAYLOAD_TOO_LARGE", `Render exceeds the ${this.#maxPixels} pixel limit.`, 413, {
          details: { width: rendered.width, height: rendered.height },
        });
      }
      context = await browser.newContext({
        viewport: { width: rendered.width, height: rendered.height },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(this.#timeoutMs);
      await context.route("**/*", async (route) => {
        const protocol = new URL(route.request().url()).protocol;
        if (protocol === "data:" || protocol === "blob:" || protocol === "about:") await route.continue();
        else await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      const renderJob = async (): Promise<RenderResult> => {
        await page.setContent(rendered.html, { waitUntil: "load", timeout: this.#timeoutMs });
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        await page.evaluate(async () => {
          await globalThis.document.fonts.ready;
          await Promise.all([...globalThis.document.images].map(async (image) => {
            if (image.complete) return image.decode().catch(() => undefined);
            await new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            });
            await image.decode().catch(() => undefined);
          }));
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const png = await page.screenshot({ type: "png", animations: "disabled", timeout: this.#timeoutMs });
        return {
          png,
          width: rendered.width,
          height: rendered.height,
          renderer: "playwright",
          warnings: this.#browserWarning ? [this.#browserWarning] : [],
        };
      };
      return await Promise.race([
        renderJob(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new DomainError("RENDER_TIMEOUT", `Render exceeded ${this.#timeoutMs}ms.`, 504, { retryable: true })), this.#timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (this.#browser && !this.#browser.isConnected()) {
        this.#browser = null;
        this.#playwrightUnavailable = false;
      }
      if (this.#allowSoftwareFallback) {
        const fallback = softwareRender(compatibleDocument, options);
        fallback.warnings.unshift("Browser rendering failed; development-only software fallback was used.");
        return fallback;
      }
      throw new DomainError("RENDER_FAILED", "Chromium could not render the design.", 503, { retryable: true, cause: error });
    } finally {
      await context?.close().catch(() => undefined);
      release();
    }
  }

  async normalizeRaster(
    data: Buffer,
    options: RasterNormalizationOptions,
    context?: RasterNormalizationContext,
  ): Promise<NormalizedImageAsset> {
    const sourceSha256 = createHash("sha256").update(data).digest("hex");
    const jobId = this.#jobRecorder?.queue({
      kind: "normalize_raster",
      requestHash: hashPayload({ kind: "normalize_raster", sourceSha256, options }),
      requestMetadata: {
        sourceSha256,
        sourceBytes: data.length,
        sourceMimeType: boundedJobText(options.sourceMimeType),
        sourceWidth: options.sourceWidth,
        sourceHeight: options.sourceHeight,
        maxBytes: options.maxBytes,
        maxPixels: options.maxPixels,
      },
      scope: context?.scope === "organization"
        ? {
          kind: "organization",
          organizationId: context.organizationId,
          ...(context.designId === undefined ? {} : { designId: context.designId }),
          operation: context.operation,
        }
        : { kind: "internal", operation: context?.operation ?? "raster_normalization" },
    }) ?? null;
    try {
      const result = await this.#normalizeRaster(data, options, () => {
        if (jobId) this.#jobRecorder!.start(jobId);
      });
      if (jobId) {
        this.#jobRecorder!.succeed(jobId, {
          output: result.data,
          width: result.width,
          height: result.height,
          renderer: "chromium",
        });
      }
      return result;
    } catch (error) {
      if (jobId) {
        try {
          this.#jobRecorder!.fail(jobId, renderJobFailure(error));
        } catch (recordingError) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "FormaSpec could not persist the raster-normalization job terminal state.",
            500,
            { retryable: true, cause: recordingError },
          );
        }
      }
      throw error;
    }
  }

  async #normalizeRaster(
    data: Buffer,
    options: RasterNormalizationOptions,
    onStarted: () => void,
  ): Promise<NormalizedImageAsset> {
    if (this.#remoteClient) {
      onStarted();
      return this.#remoteClient.normalizeRaster(data, options);
    }
    if (data.length < 1) throw new DomainError("UNSUPPORTED_ASSET", "The uploaded asset is empty.", 422);
    if (data.length > options.maxBytes) {
      throw new DomainError("PAYLOAD_TOO_LARGE", `Asset exceeds the ${options.maxBytes} byte limit.`, 413);
    }
    const sourcePixels = options.sourceWidth * options.sourceHeight;
    const effectiveMaxPixels = Math.min(options.maxPixels, this.#maxPixels);
    if (!Number.isSafeInteger(sourcePixels) || sourcePixels < 1 || sourcePixels > effectiveMaxPixels) {
      throw new DomainError("PAYLOAD_TOO_LARGE", `Image exceeds the ${effectiveMaxPixels} pixel limit.`, 413);
    }

    const release = await this.#acquire();
    let context: BrowserContext | null = null;
    try {
      onStarted();
      const browser = await this.#ensureBrowser();
      if (!browser) {
        throw new DomainError(
          "TEMPORARILY_UNAVAILABLE",
          "Pinned Chromium is unavailable for isolated raster normalization.",
          503,
          { retryable: true },
        );
      }
      context = await browser.newContext({
        viewport: { width: 1, height: 1 },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(this.#timeoutMs);
      await context.route("**/*", async (route) => {
        const protocol = new URL(route.request().url()).protocol;
        if (protocol === "data:" || protocol === "blob:" || protocol === "about:") await route.continue();
        else await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      const manualOrientation = options.sourceMimeType === "image/webp" ? webpExifOrientation(data) : 1;
      const normalizeJob = page.evaluate(async ({ inputBase64, mimeType, maxPixels, orientation }) => {
        const inputBinary = atob(inputBase64);
        const input = new Uint8Array(inputBinary.length);
        for (let index = 0; index < inputBinary.length; index += 1) input[index] = inputBinary.charCodeAt(index);
        const blob = new Blob([input], { type: mimeType });
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: "from-image",
          premultiplyAlpha: "default",
          colorSpaceConversion: "default",
        });
        try {
          const swapsDimensions = orientation >= 5;
          const width = swapsDimensions ? bitmap.height : bitmap.width;
          const height = swapsDimensions ? bitmap.width : bitmap.height;
          const pixels = width * height;
          if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > maxPixels) {
            throw new Error(`PIXEL_LIMIT:${width}:${height}`);
          }
          const canvas = new OffscreenCanvas(width, height);
          const context2d = canvas.getContext("2d", { alpha: true, colorSpace: "srgb" });
          if (!context2d) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
          context2d.clearRect(0, 0, width, height);
          if (orientation === 2) context2d.setTransform(-1, 0, 0, 1, width, 0);
          else if (orientation === 3) context2d.setTransform(-1, 0, 0, -1, width, height);
          else if (orientation === 4) context2d.setTransform(1, 0, 0, -1, 0, height);
          else if (orientation === 5) context2d.setTransform(0, 1, 1, 0, 0, 0);
          else if (orientation === 6) context2d.setTransform(0, 1, -1, 0, width, 0);
          else if (orientation === 7) context2d.setTransform(0, -1, -1, 0, width, height);
          else if (orientation === 8) context2d.setTransform(0, -1, 1, 0, 0, height);
          context2d.drawImage(bitmap, 0, 0);
          const output = await canvas.convertToBlob({ type: "image/png" });
          const bytes = new Uint8Array(await output.arrayBuffer());
          let binary = "";
          const chunkSize = 32_768;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
          }
          return { ok: true as const, width, height, pngBase64: btoa(binary) };
        } finally {
          bitmap.close();
        }
      }, {
        inputBase64: data.toString("base64"),
        mimeType: options.sourceMimeType,
        maxPixels: effectiveMaxPixels,
        orientation: manualOrientation,
      }) as Promise<BrowserNormalizedRaster>;

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DomainError(
          "RENDER_TIMEOUT",
          `Raster normalization exceeded ${this.#timeoutMs}ms.`,
          504,
          { retryable: true },
        )), this.#timeoutMs);
        timer.unref?.();
      });
      const normalized = await Promise.race([normalizeJob, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const png = Buffer.from(normalized.pngBase64, "base64");
      if (png.length > options.maxBytes) {
        throw new DomainError("PAYLOAD_TOO_LARGE", `Normalized asset exceeds the ${options.maxBytes} byte limit.`, 413);
      }
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new DomainError("INTERNAL_ERROR", "Chromium returned an invalid normalized PNG.", 500);
      }
      return { data: png, mimeType: "image/png", width: normalized.width, height: normalized.height };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (this.#browser && !this.#browser.isConnected()) {
        this.#browser = null;
        this.#playwrightUnavailable = false;
      }
      const message = error instanceof Error ? error.message : "";
      if (message.includes("PIXEL_LIMIT:")) {
        throw new DomainError("PAYLOAD_TOO_LARGE", `Image exceeds the ${effectiveMaxPixels} pixel limit.`, 413);
      }
      throw new DomainError("UNSUPPORTED_ASSET", "Chromium could not fully decode the raster image.", 422, { cause: error });
    } finally {
      await context?.close().catch(() => undefined);
      release();
    }
  }

  async health(): Promise<RenderHealth> {
    if (this.#remoteClient) return this.#remoteClient.health();
    const browser = await this.#ensureBrowser();
    if (browser) {
      return {
        ok: true,
        mode: "in-process",
        renderer: "playwright",
        softwareFallback: false,
        warnings: this.#browserWarning ? [this.#browserWarning] : [],
      };
    }
    if (this.#allowSoftwareFallback) {
      return {
        ok: true,
        mode: "in-process",
        renderer: "software",
        softwareFallback: true,
        warnings: ["Development-only software renderer is active because Chromium is unavailable."],
      };
    }
    throw new DomainError("RENDER_FAILED", "Pinned Chromium is unavailable.", 503, { retryable: true });
  }

  get remote(): boolean {
    return this.#remoteClient !== null;
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}

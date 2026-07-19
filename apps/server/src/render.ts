import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import type { Browser } from "playwright";
import { chromium } from "playwright";
import { nodeToCss, type CssStyle, type DesignDocument, type DesignNode, type LayoutMode } from "@designer/core";

import { DomainError } from "./errors.js";

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
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:${colorValue(page.background, document, "#ffffff")};transform-origin:top left;transform:scale(${scale});width:${naturalWidth}px;height:${naturalHeight}px;font-family:Inter,Vazirmatn,system-ui,sans-serif}</style></head><body>${body}</body></html>`,
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

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
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
    png: encodePng(width, height, pixels),
    width,
    height,
    renderer: "software",
    warnings: ["Chromium rendering was unavailable; a simplified software preview was returned. Run `pnpm exec playwright install chromium` or install Google Chrome for full-fidelity renders."],
  };
}

export class PngRenderer {
  #browser: Browser | null = null;
  #playwrightUnavailable = false;
  #browserWarning: string | null = null;

  async #ensureBrowser(): Promise<Browser | null> {
    if (this.#browser) return this.#browser;
    if (this.#playwrightUnavailable) return null;
    try {
      this.#browser = await chromium.launch({ headless: true });
      this.#browserWarning = null;
      return this.#browser;
    } catch {
      try {
        this.#browser = await chromium.launch({ headless: true, channel: "chrome" });
        this.#browserWarning = "Using system Chrome because Playwright-managed Chromium is not installed.";
        return this.#browser;
      } catch {
        this.#playwrightUnavailable = true;
        return null;
      }
    }
  }

  async render(
    document: DesignDocument,
    options: RenderOptions,
    assetDataUrl: (id: string) => string | null,
  ): Promise<RenderResult> {
    const browser = await this.#ensureBrowser();
    if (browser) {
      try {
        const rendered = renderHtml(document, options, assetDataUrl);
        const page = await browser.newPage({ viewport: { width: rendered.width, height: rendered.height }, deviceScaleFactor: 1 });
        try {
          await page.setContent(rendered.html, { waitUntil: "load", timeout: 10_000 });
          await page.evaluate(async () => globalThis.document.fonts.ready);
          const png = await page.screenshot({ type: "png", animations: "disabled" });
          return {
            png,
            width: rendered.width,
            height: rendered.height,
            renderer: "playwright",
            warnings: this.#browserWarning ? [this.#browserWarning] : [],
          };
        } finally {
          await page.close();
        }
      } catch {
        if (!browser.isConnected()) {
          this.#browser = null;
          this.#playwrightUnavailable = false;
        }
        const fallback = softwareRender(document, options);
        fallback.warnings.unshift("Browser rendering failed for this document; returned a software preview.");
        return fallback;
      }
    }
    return softwareRender(document, options);
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}

import { createHash } from "node:crypto";

import {
  NodeIdSchema,
  PageIdSchema,
  type AnyDesignDocument,
} from "@designer/core";
import { z } from "zod";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

export const PREVIEW_RENDER_METADATA_MAX_BYTES = 65_536;
export const PREVIEW_RENDER_MAX_SIZE = 4_096;

export const PreviewRenderOptionsSchema = z.object({
  pageId: PageIdSchema.optional(),
  nodeId: NodeIdSchema.optional(),
  maxSize: z.number().int().min(64).max(PREVIEW_RENDER_MAX_SIZE),
}).strict();

export const PreviewRenderMetadataSchema = z.object({
  options: PreviewRenderOptionsSchema,
  width: z.number().int().positive().max(PREVIEW_RENDER_MAX_SIZE),
  height: z.number().int().positive().max(PREVIEW_RENDER_MAX_SIZE),
  renderer: z.enum(["playwright", "software"]),
  warnings: z.array(z.string().max(4_000)).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type PreviewRenderOptions = z.infer<typeof PreviewRenderOptionsSchema>;
export type PreviewRenderMetadata = z.infer<typeof PreviewRenderMetadataSchema>;

export interface PreviewRenderCapture {
  options: unknown;
  png: Buffer;
  width: unknown;
  height: unknown;
  renderer: unknown;
  warnings: unknown;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalidRenderMetadata(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("VALIDATION_FAILED", message, 422, details ? { details } : {});
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24
    || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || png.toString("ascii", 12, 16) !== "IHDR") {
    throw invalidRenderMetadata("Preview render output must be a valid PNG with an IHDR header.");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw invalidRenderMetadata("Preview render output must have positive PNG dimensions.");
  }
  return { width, height };
}

export function buildPreviewRenderMetadata(
  document: AnyDesignDocument,
  capture: PreviewRenderCapture,
): PreviewRenderMetadata {
  const options = PreviewRenderOptionsSchema.safeParse(capture.options);
  if (!options.success) {
    throw invalidRenderMetadata("Preview render options are invalid.", { issues: options.error.issues });
  }
  if (options.data.pageId !== undefined
    && !document.pages.some((page) => page.id === options.data.pageId)) {
    throw invalidRenderMetadata("Preview render page does not exist in the exact preview document.", {
      pageId: options.data.pageId,
    });
  }
  if (options.data.nodeId !== undefined && document.nodes[options.data.nodeId] === undefined) {
    throw invalidRenderMetadata("Preview render node does not exist in the exact preview document.", {
      nodeId: options.data.nodeId,
    });
  }
  if (!Buffer.isBuffer(capture.png)) {
    throw invalidRenderMetadata("Preview render output must be PNG bytes.");
  }
  const dimensions = pngDimensions(capture.png);
  const candidate = PreviewRenderMetadataSchema.safeParse({
    options: options.data,
    width: capture.width,
    height: capture.height,
    renderer: capture.renderer,
    warnings: capture.warnings,
    sha256: createHash("sha256").update(capture.png).digest("hex"),
  });
  if (!candidate.success) {
    throw invalidRenderMetadata("Preview render metadata is invalid.", { issues: candidate.error.issues });
  }
  if (candidate.data.width !== dimensions.width || candidate.data.height !== dimensions.height) {
    throw invalidRenderMetadata("Preview render dimensions do not match the PNG IHDR dimensions.", {
      metadataWidth: candidate.data.width,
      metadataHeight: candidate.data.height,
      pngWidth: dimensions.width,
      pngHeight: dimensions.height,
    });
  }
  if (candidate.data.width > candidate.data.options.maxSize
    || candidate.data.height > candidate.data.options.maxSize) {
    throw invalidRenderMetadata("Preview render dimensions exceed the requested maximum size.");
  }
  const bytes = Buffer.byteLength(canonicalJson(candidate.data), "utf8");
  if (bytes > PREVIEW_RENDER_METADATA_MAX_BYTES) {
    throw new DomainError(
      "PAYLOAD_TOO_LARGE",
      `Preview render metadata exceeds ${PREVIEW_RENDER_METADATA_MAX_BYTES} bytes.`,
      413,
      { details: { bytes, maxBytes: PREVIEW_RENDER_METADATA_MAX_BYTES } },
    );
  }
  return candidate.data;
}

export function parsePreviewRenderMetadata(value: string): PreviewRenderMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Stored preview render metadata is invalid JSON.", 500, {
      cause: error,
    });
  }
  const result = PreviewRenderMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new DomainError("INTERNAL_ERROR", "Stored preview render metadata is schema-invalid.", 500, {
      cause: result.error,
    });
  }
  if (Buffer.byteLength(value, "utf8") > PREVIEW_RENDER_METADATA_MAX_BYTES) {
    throw new DomainError("INTERNAL_ERROR", "Stored preview render metadata exceeds its size limit.", 500);
  }
  return result.data;
}

import {
  RASTER_NORMALIZER_VERSION,
  RENDERER_IPC_PROTOCOL_VERSION,
  RENDERER_VERSION,
} from "@designer/core";

export const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_RASTER_NORMALIZATION_BYTES = 64 * 1024 * 1024;
export const DEFAULT_RENDER_MAX_PIXELS = 32_000_000;
export const MAX_RASTER_NORMALIZATION_PIXELS = 64_000_000;
export const DEFAULT_RENDER_IPC_MAX_BYTES = 96 * 1024 * 1024;
export const MIN_RENDER_IPC_MAX_BYTES = 1024 * 1024;
export const MAX_RENDER_IPC_MAX_BYTES = 256 * 1024 * 1024;

// Reserve room for the JSON envelope, UUID, MIME type, dimensions, limits,
// version fields, and future additive diagnostics around a base64 payload.
export const RASTER_IPC_ENVELOPE_RESERVE_BYTES = 4 * 1024;

export interface RasterNormalizationLimits {
  maxBytes: number;
  maxPixels: number;
}

export interface RendererWorkerContract extends RasterNormalizationLimits {
  ipcProtocolVersion: typeof RENDERER_IPC_PROTOCOL_VERSION;
  rendererVersion: typeof RENDERER_VERSION;
  rasterNormalizerVersion: typeof RASTER_NORMALIZER_VERSION;
  maxMessageBytes: number;
}

export function base64EncodedBytes(rawBytes: number): number {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) {
    throw new RangeError("Raster byte limit must be a non-negative safe integer.");
  }
  return 4 * Math.ceil(rawBytes / 3);
}

export function requiredRasterIpcMessageBytes(maxAssetBytes: number): number {
  return base64EncodedBytes(maxAssetBytes) + RASTER_IPC_ENVELOPE_RESERVE_BYTES;
}

export function validateRendererLimitParity(input: {
  maxAssetBytes: number;
  maxAssetPixels: number;
  renderMaxPixels: number;
  renderIpcMaxBytes: number;
}): void {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  if (
    input.renderIpcMaxBytes < MIN_RENDER_IPC_MAX_BYTES
    || input.renderIpcMaxBytes > MAX_RENDER_IPC_MAX_BYTES
  ) {
    throw new Error(
      `Renderer IPC limit must be between ${MIN_RENDER_IPC_MAX_BYTES} and ${MAX_RENDER_IPC_MAX_BYTES} bytes.`,
    );
  }
  if (input.maxAssetBytes > MAX_RASTER_NORMALIZATION_BYTES) {
    throw new Error(
      `Asset byte limit cannot exceed the renderer normalizer hard cap of ${MAX_RASTER_NORMALIZATION_BYTES} bytes.`,
    );
  }
  if (input.maxAssetPixels > MAX_RASTER_NORMALIZATION_PIXELS) {
    throw new Error(
      `Asset pixel limit cannot exceed the renderer normalizer hard cap of ${MAX_RASTER_NORMALIZATION_PIXELS} pixels.`,
    );
  }
  if (input.renderMaxPixels > MAX_RASTER_NORMALIZATION_PIXELS) {
    throw new Error(
      `Renderer pixel limit cannot exceed the hard cap of ${MAX_RASTER_NORMALIZATION_PIXELS} pixels.`,
    );
  }
  if (input.maxAssetPixels > input.renderMaxPixels) {
    throw new Error(
      "DESIGNER_MAX_ASSET_PIXELS cannot exceed FORMASPEC_RENDER_MAX_PIXELS; local and worker normalization must use the same effective pixel limit.",
    );
  }
  const requiredMessageBytes = requiredRasterIpcMessageBytes(input.maxAssetBytes);
  if (input.renderIpcMaxBytes < requiredMessageBytes) {
    throw new Error(
      `FORMASPEC_RENDER_IPC_MAX_BYTES must be at least ${requiredMessageBytes} bytes to carry the configured asset byte limit after base64 framing.`,
    );
  }
}

export function createRendererWorkerContract(input: RasterNormalizationLimits & {
  maxMessageBytes: number;
}): RendererWorkerContract {
  validateRendererLimitParity({
    maxAssetBytes: input.maxBytes,
    maxAssetPixels: input.maxPixels,
    renderMaxPixels: input.maxPixels,
    renderIpcMaxBytes: input.maxMessageBytes,
  });
  return Object.freeze({
    ipcProtocolVersion: RENDERER_IPC_PROTOCOL_VERSION,
    rendererVersion: RENDERER_VERSION,
    rasterNormalizerVersion: RASTER_NORMALIZER_VERSION,
    maxMessageBytes: input.maxMessageBytes,
    maxBytes: input.maxBytes,
    maxPixels: input.maxPixels,
  });
}

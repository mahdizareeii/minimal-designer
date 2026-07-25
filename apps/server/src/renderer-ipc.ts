import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";

import {
  AnyDesignDocumentSchema,
  RASTER_NORMALIZER_VERSION,
  RENDERER_IPC_PROTOCOL_VERSION,
  RENDERER_VERSION,
  type AnyDesignDocument,
} from "@designer/core";
import { z } from "zod";

import type { NormalizedImageAsset, RasterNormalizationOptions } from "./assets.js";
import { DomainError, type DomainErrorCode } from "./errors.js";
import type { PngRenderer, RenderHealth, RenderOptions, RenderResult } from "./render.js";
import {
  createRendererWorkerContract,
  DEFAULT_RENDER_IPC_MAX_BYTES,
  MAX_RASTER_NORMALIZATION_BYTES,
  MAX_RASTER_NORMALIZATION_PIXELS,
  type RasterNormalizationLimits,
  type RendererWorkerContract,
} from "./renderer-contract.js";
import { rendererEndpointKind } from "./renderer-endpoint.js";

export { DEFAULT_RENDER_IPC_MAX_BYTES } from "./renderer-contract.js";
export const RendererIpcDocumentSchema: z.ZodTypeAny = AnyDesignDocumentSchema;

const CONTRACT_ENVELOPE = Object.freeze({
  protocol: RENDERER_IPC_PROTOCOL_VERSION,
  rendererVersion: RENDERER_VERSION,
  rasterNormalizerVersion: RASTER_NORMALIZER_VERSION,
});

const contractEnvelopeSchema = {
  protocol: z.literal(RENDERER_IPC_PROTOCOL_VERSION),
  rendererVersion: z.literal(RENDERER_VERSION),
  rasterNormalizerVersion: z.literal(RASTER_NORMALIZER_VERSION),
};

const renderOptionsSchema = z.object({
  pageId: z.string().min(1).max(240).optional(),
  pageIds: z.array(z.string().min(1).max(240)).min(2).max(20).optional(),
  nodeId: z.string().min(1).max(240).optional(),
  maxSize: z.number().int().min(64).max(4_096).optional(),
}).strict().superRefine((options, context) => {
  if (options.pageIds !== undefined && (options.pageId !== undefined || options.nodeId !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageIds"],
      message: "A contact-sheet render cannot also target one page or node.",
    });
  }
  if (options.pageIds !== undefined && new Set(options.pageIds).size !== options.pageIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageIds"],
      message: "Contact-sheet page IDs must be unique.",
    });
  }
});

const safeImageDataUrlSchema = z.string().refine(
  (value) => /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value),
  "Only normalized PNG, JPEG, and WebP data URLs are accepted.",
);

const base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const rasterNormalizationOptionsSchema = z.object({
  sourceMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sourceWidth: z.number().int().positive().max(100_000),
  sourceHeight: z.number().int().positive().max(100_000),
  maxBytes: z.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES),
  maxPixels: z.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS),
}).strict();

const requestSchema = z.discriminatedUnion("method", [
  z.object({
    ...contractEnvelopeSchema,
    id: z.string().uuid(),
    method: z.literal("health"),
  }).strict(),
  z.object({
    ...contractEnvelopeSchema,
    id: z.string().uuid(),
    method: z.literal("render"),
    document: RendererIpcDocumentSchema,
    options: renderOptionsSchema,
    assets: z.record(z.union([safeImageDataUrlSchema, z.null()])),
  }).strict(),
  z.object({
    ...contractEnvelopeSchema,
    id: z.string().uuid(),
    method: z.literal("normalize-raster"),
    data: base64Schema,
    options: rasterNormalizationOptionsSchema,
  }).strict(),
]);

const errorSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2_000),
  statusCode: z.number().int().min(400).max(599),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
}).strict();

const healthSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["in-process", "worker"]),
  renderer: z.enum(["playwright", "software"]),
  softwareFallback: z.boolean(),
  warnings: z.array(z.string().max(1_000)).max(16),
  contract: z.object({
    ipcProtocolVersion: z.literal(RENDERER_IPC_PROTOCOL_VERSION),
    rendererVersion: z.literal(RENDERER_VERSION),
    rasterNormalizerVersion: z.literal(RASTER_NORMALIZER_VERSION),
    maxMessageBytes: z.number().int().positive(),
    maxBytes: z.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES),
    maxPixels: z.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS),
  }).strict(),
}).strict();

const renderResultSchema = z.object({
  png: base64Schema,
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  renderer: z.enum(["playwright", "software"]),
  warnings: z.array(z.string().max(1_000)).max(16),
}).strict();

const rasterNormalizationResultSchema = z.object({
  png: base64Schema,
  mimeType: z.literal("image/png"),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
}).strict();

const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    ...contractEnvelopeSchema,
    id: z.string(),
    ok: z.literal(true),
    result: z.union([healthSchema, renderResultSchema, rasterNormalizationResultSchema]),
  }).strict(),
  z.object({
    ...contractEnvelopeSchema,
    id: z.string(),
    ok: z.literal(false),
    error: errorSchema,
  }).strict(),
]);

type RenderRequest = z.infer<typeof requestSchema>;
type RenderResponse = z.infer<typeof responseSchema>;

export interface RendererSocketClientOptions {
  socketPath: string;
  timeoutMs: number;
  maxMessageBytes?: number;
}

export interface RendererWorkerOptions {
  socketPath: string;
  renderer: Pick<PngRenderer, "render" | "normalizeRaster" | "health" | "close">;
  timeoutMs: number;
  maxMessageBytes?: number;
  maxConnections?: number;
  normalizationLimits: RasterNormalizationLimits;
}

export interface RendererWorkerHealth extends RenderHealth {
  contract: RendererWorkerContract;
}

export interface RendererWorkerHandle {
  socketPath: string;
  close(): Promise<void>;
}

function encodeFrame(value: unknown, maxMessageBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxMessageBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `Renderer IPC message exceeds ${maxMessageBytes} bytes.`, 413);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function readFrame(socket: Socket, maxMessageBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerOffset = 0;
    let expectedBodyBytes: number | undefined;
    let bodyBytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled || expectedBodyBytes === undefined || bodyBytes !== expectedBodyBytes) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, bodyBytes).toString("utf8")) as unknown);
      } catch (error) {
        reject(new DomainError("VALIDATION_FAILED", "Renderer IPC payload is not valid JSON.", 422, { cause: error }));
      }
    };
    const onData = (incoming: Buffer) => {
      let offset = 0;
      if (expectedBodyBytes === undefined) {
        const headerBytes = Math.min(4 - headerOffset, incoming.length);
        incoming.copy(header, headerOffset, 0, headerBytes);
        headerOffset += headerBytes;
        offset += headerBytes;
        if (headerOffset === 4) {
          expectedBodyBytes = header.readUInt32BE(0);
          if (expectedBodyBytes < 1 || expectedBodyBytes > maxMessageBytes) {
            fail(new DomainError("PAYLOAD_TOO_LARGE", `Renderer IPC frame exceeds ${maxMessageBytes} bytes.`, 413));
            socket.destroy();
            return;
          }
        }
      }
      if (expectedBodyBytes !== undefined && offset < incoming.length) {
        const chunk = incoming.subarray(offset);
        bodyBytes += chunk.length;
        if (bodyBytes > expectedBodyBytes) {
          fail(new DomainError("VALIDATION_FAILED", "Renderer IPC frame contains trailing bytes.", 422));
          socket.destroy();
          return;
        }
        chunks.push(chunk);
      }
      finish();
    };
    const onEnd = () => fail(new DomainError("RENDER_FAILED", "Renderer IPC connection closed before a complete response.", 503, { retryable: true }));
    const onError = (error: Error) => fail(error);
    const onTimeout = () => {
      fail(new DomainError("RENDER_TIMEOUT", "Renderer IPC request timed out.", 504, { retryable: true }));
      socket.destroy();
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function isDomainErrorCode(value: string): value is DomainErrorCode {
  return new Set<string>([
    "AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_FAILED", "VERSION_CONFLICT",
    "PREVIEW_EXPIRED", "PREVIEW_ALREADY_COMMITTED", "PREVIEW_ENGINE_MISMATCH",
    "PREVIEW_NOT_COMMITTABLE", "TASK_EXPIRED", "TASK_STATE_CONFLICT", "PAIRING_EXPIRED",
    "CONNECTION_REVOKED", "IDEMPOTENCY_CONFLICT", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_ASSET",
    "UNSUPPORTED_DOCUMENT_FEATURE",
    "AMBIGUOUS_CONTEXT", "DATA_STORE_MISMATCH", "CORE_UNAVAILABLE", "RENDER_FAILED", "RENDER_TIMEOUT", "RATE_LIMITED",
    "TEMPORARILY_UNAVAILABLE", "INTERNAL_ERROR",
  ]).has(value);
}

function remoteError(error: z.infer<typeof errorSchema>): DomainError {
  return new DomainError(
    isDomainErrorCode(error.code) ? error.code : "RENDER_FAILED",
    error.message,
    error.statusCode,
    {
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  );
}

function assertCompatibleRendererEnvelope(value: unknown): void {
  const envelope = value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (
    envelope.protocol === RENDERER_IPC_PROTOCOL_VERSION
    && envelope.rendererVersion === RENDERER_VERSION
    && envelope.rasterNormalizerVersion === RASTER_NORMALIZER_VERSION
  ) return;
  throw new DomainError(
    "RENDER_FAILED",
    "Renderer worker contract mismatch. Restart the API and renderer worker from the same FormaSpec build and verify their configured image limits.",
    503,
    {
      details: {
        expected: CONTRACT_ENVELOPE,
        received: {
          protocol: envelope.protocol ?? null,
          rendererVersion: envelope.rendererVersion ?? null,
          rasterNormalizerVersion: envelope.rasterNormalizerVersion ?? null,
        },
      },
    },
  );
}

async function connect(socketPath: string, timeoutMs: number): Promise<Socket> {
  const socket = net.createConnection({ path: socketPath });
  socket.setTimeout(timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new DomainError("RENDER_TIMEOUT", "Renderer worker connection timed out.", 504, { retryable: true })));
    });
    return socket;
  } catch (error) {
    socket.destroy();
    if (error instanceof DomainError) throw error;
    throw new DomainError("RENDER_FAILED", "Renderer worker is unavailable.", 503, { retryable: true, cause: error });
  }
}

export class RendererSocketClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;

  constructor(options: RendererSocketClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_RENDER_IPC_MAX_BYTES;
  }

  async #request(request: RenderRequest): Promise<Extract<RenderResponse, { ok: true }>> {
    const frame = encodeFrame(request, this.#maxMessageBytes);
    const socket = await connect(this.#socketPath, this.#timeoutMs);
    try {
      const responsePromise = readFrame(socket, this.#maxMessageBytes);
      socket.write(frame);
      const rawResponse = await responsePromise;
      assertCompatibleRendererEnvelope(rawResponse);
      const parsed = responseSchema.parse(rawResponse);
      if (parsed.id !== request.id) {
        throw new DomainError("RENDER_FAILED", "Renderer worker returned a mismatched response.", 503, { retryable: true });
      }
      if (!parsed.ok) throw remoteError(parsed.error);
      return parsed;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("RENDER_FAILED", "Renderer worker returned an invalid response.", 503, { retryable: true, cause: error });
    } finally {
      socket.destroy();
    }
  }

  async health(): Promise<RendererWorkerHealth> {
    const response = await this.#request({ ...CONTRACT_ENVELOPE, id: randomUUID(), method: "health" });
    const result = healthSchema.parse(response.result);
    return { ...result, mode: "worker" };
  }

  async render(document: AnyDesignDocument, options: RenderOptions, assets: Record<string, string | null>): Promise<RenderResult> {
    const response = await this.#request({
      ...CONTRACT_ENVELOPE,
      id: randomUUID(),
      method: "render",
      document,
      options,
      assets,
    });
    const result = renderResultSchema.parse(response.result);
    const png = Buffer.from(result.png, "base64");
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new DomainError("RENDER_FAILED", "Renderer worker returned an invalid PNG.", 503, { retryable: true });
    }
    return { ...result, png };
  }

  async normalizeRaster(data: Buffer, options: RasterNormalizationOptions): Promise<NormalizedImageAsset> {
    if (data.length > options.maxBytes) {
      throw new DomainError("PAYLOAD_TOO_LARGE", `Asset exceeds the ${options.maxBytes} byte limit.`, 413);
    }
    const response = await this.#request({
      ...CONTRACT_ENVELOPE,
      id: randomUUID(),
      method: "normalize-raster",
      data: data.toString("base64"),
      options,
    });
    const result = rasterNormalizationResultSchema.parse(response.result);
    const png = Buffer.from(result.png, "base64");
    if (png.length > options.maxBytes) {
      throw new DomainError("PAYLOAD_TOO_LARGE", `Normalized asset exceeds the ${options.maxBytes} byte limit.`, 413);
    }
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new DomainError("RENDER_FAILED", "Renderer worker returned an invalid normalized PNG.", 503, { retryable: true });
    }
    return { data: png, mimeType: result.mimeType, width: result.width, height: result.height };
  }
}

function serializeError(error: unknown): z.infer<typeof errorSchema> {
  const domainError = error instanceof DomainError
    ? error
    : error instanceof z.ZodError
      ? new DomainError("VALIDATION_FAILED", "Renderer IPC request failed schema validation.", 422, {
        details: { issues: error.issues },
      })
      : new DomainError("RENDER_FAILED", "Renderer worker could not complete the request.", 503, {
        retryable: true,
        cause: error,
      });
  return {
    code: domainError.code,
    message: domainError.message,
    statusCode: domainError.statusCode,
    retryable: domainError.retryable,
    ...(domainError.details ? { details: domainError.details } : {}),
  };
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out while checking the existing renderer socket."));
    }, 500);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocket(socketPath: string): Promise<void> {
  if (rendererEndpointKind(socketPath) === "windows-named-pipe") {
    if (await socketIsActive(socketPath)) {
      throw new Error(`A renderer worker is already listening at ${socketPath}.`);
    }
    return;
  }
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.promises.lstat(socketPath);
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path ${socketPath}.`);
    if (await socketIsActive(socketPath)) throw new Error(`A renderer worker is already listening at ${socketPath}.`);
    await fs.promises.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (rendererEndpointKind(socketPath) === "unix-socket") {
    await fs.promises.chmod(socketPath, 0o600);
  }
}

export async function startRendererWorker(options: RendererWorkerOptions): Promise<RendererWorkerHandle> {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_RENDER_IPC_MAX_BYTES;
  const maxConnections = options.maxConnections ?? 40;
  const workerContract = createRendererWorkerContract({
    maxMessageBytes,
    maxBytes: options.normalizationLimits.maxBytes,
    maxPixels: options.normalizationLimits.maxPixels,
  });
  await options.renderer.health();
  await prepareSocket(options.socketPath);

  let activeConnections = 0;
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    if (activeConnections >= maxConnections) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    sockets.add(socket);
    // Keep an error listener after request framing completes so a client timeout
    // cannot crash the worker while Chromium is still finishing that job.
    socket.on("error", () => undefined);
    socket.setTimeout(options.timeoutMs + 1_000);
    socket.once("close", () => {
      activeConnections -= 1;
      sockets.delete(socket);
    });

    void (async () => {
      let requestId = "unknown";
      let response: RenderResponse;
      try {
        const request = requestSchema.parse(await readFrame(socket, maxMessageBytes));
        requestId = request.id;
        if (request.method === "health") {
          response = {
            ...CONTRACT_ENVELOPE,
            id: request.id,
            ok: true,
            result: { ...(await options.renderer.health()), mode: "worker", contract: workerContract },
          };
        } else if (request.method === "render") {
          const rendered = await options.renderer.render(
            request.document,
            request.options,
            (assetId) => request.assets[assetId] ?? null,
          );
          response = {
            ...CONTRACT_ENVELOPE,
            id: request.id,
            ok: true,
            result: {
              png: rendered.png.toString("base64"),
              width: rendered.width,
              height: rendered.height,
              renderer: rendered.renderer,
              warnings: rendered.warnings,
            },
          };
        } else {
          if (
            request.options.maxBytes !== workerContract.maxBytes
            || request.options.maxPixels !== workerContract.maxPixels
          ) {
            throw new DomainError(
              "RENDER_FAILED",
              "Renderer worker normalization limits do not match the API configuration. Configure MAX_UPLOAD_BYTES, DESIGNER_MAX_ASSET_BYTES, DESIGNER_MAX_ASSET_PIXELS, and FORMASPEC_RENDER_MAX_PIXELS identically, then restart both processes.",
              503,
              {
                details: {
                  worker: { maxBytes: workerContract.maxBytes, maxPixels: workerContract.maxPixels },
                  api: { maxBytes: request.options.maxBytes, maxPixels: request.options.maxPixels },
                },
              },
            );
          }
          const normalized = await options.renderer.normalizeRaster(
            Buffer.from(request.data, "base64"),
            request.options,
          );
          if (normalized.mimeType !== "image/png") {
            throw new DomainError("RENDER_FAILED", "Renderer worker returned a non-canonical raster format.", 503);
          }
          response = {
            ...CONTRACT_ENVELOPE,
            id: request.id,
            ok: true,
            result: {
              png: normalized.data.toString("base64"),
              mimeType: normalized.mimeType,
              width: normalized.width,
              height: normalized.height,
            },
          };
        }
      } catch (error) {
        response = { ...CONTRACT_ENVELOPE, id: requestId, ok: false, error: serializeError(error) };
      }

      try {
        socket.end(encodeFrame(response, maxMessageBytes));
      } catch (error) {
        const fallback: RenderResponse = {
          ...CONTRACT_ENVELOPE,
          id: requestId,
          ok: false,
          error: serializeError(error),
        };
        socket.end(encodeFrame(fallback, maxMessageBytes));
      }
    })();
  });
  server.maxConnections = maxConnections;
  await listen(server, options.socketPath);

  let closed = false;
  return {
    socketPath: options.socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await options.renderer.close();
      if (rendererEndpointKind(options.socketPath) === "unix-socket") {
        await fs.promises.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

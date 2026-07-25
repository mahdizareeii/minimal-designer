import {
  ProductDirectionSchema,
  ProductIdSchema,
  ProductLocaleSchema,
} from "@designer/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ProductService } from "./product-service.js";

const idempotencyKey = z.string().trim().min(8).max(240);
const productParams = z.object({ productId: ProductIdSchema }).strict();
const previewParams = z.object({ previewId: z.string().regex(/^product_move_[a-f0-9]{32}$/) }).strict();
const timestamp = z.string().datetime({ offset: true });
const metadata = z.record(z.unknown());
const booleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

const createProductSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional(),
  defaultDesignSystemReleaseId: z.string().trim().min(8).max(240).nullable().optional(),
  defaultLocale: ProductLocaleSchema.optional(),
  defaultDirection: ProductDirectionSchema.optional(),
  locales: z.array(ProductLocaleSchema).min(1).max(100).optional(),
  metadata: metadata.optional(),
  idempotencyKey,
}).strict();

const updateProductSchema = z.object({
  expectedUpdatedAt: timestamp,
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(20_000).optional(),
  defaultDesignSystemReleaseId: z.string().trim().min(8).max(240).nullable().optional(),
  defaultLocale: ProductLocaleSchema.optional(),
  defaultDirection: ProductDirectionSchema.optional(),
  locales: z.array(ProductLocaleSchema).min(1).max(100).optional(),
  metadata: metadata.optional(),
  canonicalSpecificationDesignId: z.string().trim().min(1).max(240).nullable().optional(),
  idempotencyKey,
}).strict().refine((input) => Object.keys(input).some(
  (key) => !["expectedUpdatedAt", "idempotencyKey"].includes(key),
), { message: "At least one Product field must be updated." });

const archiveProductSchema = z.object({
  expectedUpdatedAt: timestamp,
  confirmationName: z.string().min(1).max(255),
  idempotencyKey,
}).strict();

const restoreProductSchema = z.object({
  expectedUpdatedAt: timestamp,
  expectedArchivedAt: timestamp,
  idempotencyKey,
}).strict();

const movePreviewSchema = z.object({
  designId: z.string().trim().min(1).max(240),
  expectedSourceProductId: ProductIdSchema,
  expectedDesignVersion: z.number().int().positive().max(1_000_000_000),
  expiresInSeconds: z.number().int().min(60).max(3_600).optional(),
  idempotencyKey,
}).strict();

const commitMoveSchema = z.object({ idempotencyKey }).strict();

export function registerProductHttpRoutes(app: FastifyInstance, products: ProductService): void {
  app.get("/api/products", async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().max(4_096).optional(),
      includeArchived: booleanQuerySchema.optional(),
    }).strict().parse(request.query);
    return products.listProducts(request.actorId, query);
  });

  app.post("/api/products", async (request, reply) => {
    const result = products.createProduct(request.actorId, createProductSchema.parse(request.body));
    return reply.code(201).send(result);
  });

  app.get("/api/products/:productId", async (request) => {
    const { productId } = productParams.parse(request.params);
    const query = z.object({ includeArchived: booleanQuerySchema.optional() }).strict().parse(request.query);
    return products.readProduct(request.actorId, productId, query.includeArchived);
  });

  app.patch("/api/products/:productId", async (request) => {
    const { productId } = productParams.parse(request.params);
    return products.updateProduct(request.actorId, productId, updateProductSchema.parse(request.body));
  });

  app.post("/api/products/:productId/archive", async (request) => {
    const { productId } = productParams.parse(request.params);
    return products.archiveProduct(request.actorId, productId, archiveProductSchema.parse(request.body));
  });

  app.post("/api/products/:productId/restore", async (request) => {
    const { productId } = productParams.parse(request.params);
    return products.restoreProduct(request.actorId, productId, restoreProductSchema.parse(request.body));
  });

  app.post("/api/products/:productId/design-move-previews", async (request, reply) => {
    const { productId } = productParams.parse(request.params);
    const input = movePreviewSchema.parse(request.body);
    const preview = products.previewDesignMove(request.actorId, productId, input.designId, input);
    return reply.code(201).send({ preview });
  });

  app.get("/api/product-move-previews/:previewId", async (request) => {
    const { previewId } = previewParams.parse(request.params);
    return { preview: products.readDesignMovePreview(request.actorId, previewId) };
  });

  app.post("/api/product-move-previews/:previewId/commit", async (request) => {
    const { previewId } = previewParams.parse(request.params);
    return products.commitDesignMovePreview(request.actorId, previewId, commitMoveSchema.parse(request.body));
  });
}

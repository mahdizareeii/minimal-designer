import {
  DocumentIdSchema,
  ProductDirectionSchema,
  ProductIdSchema,
  ProductLocaleSchema,
  ProductStatusSchema,
} from "@designer/core";
import { z } from "zod";

import { McpJsonObjectOutputSchema } from "./bounded-json-schema.js";

const identifier = z.string().trim().min(1).max(240);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positiveVersion = z.number().int().positive().max(1_000_000_000);

export const ProductSummaryResultSchema = z.object({
  id: ProductIdSchema,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(20_000),
  status: ProductStatusSchema,
  ownerPrincipalId: identifier,
  defaultDesignSystemReleaseId: identifier.nullable(),
  defaultLocale: ProductLocaleSchema,
  defaultDirection: ProductDirectionSchema,
  locales: z.array(ProductLocaleSchema).min(1).max(100),
  canonicalSpecificationDesignId: DocumentIdSchema.nullable(),
  designCount: z.number().int().nonnegative().max(1_000_000),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
}).strict();

export const ProductDesignSummaryResultSchema = z.object({
  id: DocumentIdSchema,
  name: z.string().trim().min(1).max(255),
  version: positiveVersion,
  revisionId: identifier,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const ProductDetailResultSchema = z.object({
  product: ProductSummaryResultSchema.extend({
    metadata: McpJsonObjectOutputSchema,
  }).strict(),
  designs: z.array(ProductDesignSummaryResultSchema).max(10_000),
  canonicalSpecification: z.object({
    designId: DocumentIdSchema,
    version: positiveVersion,
    specificationHash: sha256,
  }).strict().nullable(),
  repositoryInventories: z.array(z.object({
    id: identifier,
    inventoryHash: sha256,
    status: z.string().trim().min(1).max(64),
  }).strict()).max(100),
}).strict();

export const ProductMovePreviewResultSchema = z.object({
  id: z.string().regex(/^product_move_[a-f0-9]{32}$/),
  designId: DocumentIdSchema,
  sourceProduct: z.object({
    id: ProductIdSchema,
    name: z.string().trim().min(1).max(255),
  }).strict(),
  targetProduct: z.object({
    id: ProductIdSchema,
    name: z.string().trim().min(1).max(255),
  }).strict(),
  expectedDesignVersion: positiveVersion,
  status: z.enum(["ready", "expired", "committed"]),
  createdAt: timestamp,
  expiresAt: timestamp,
  committedAt: timestamp.nullable(),
}).strict();

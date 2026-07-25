import { z } from "zod";

import { DocumentIdSchema, ProductIdSchema } from "./ids.js";

const opaqueIdentifier = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const ProductStatusSchema = z.enum(["active", "archived"]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const ProductDirectionSchema = z.enum(["ltr", "rtl", "auto"]);
export type ProductDirection = z.infer<typeof ProductDirectionSchema>;

export const ProductPlatformSchema = z.enum([
  "web",
  "phone",
  "tablet",
  "mixed",
  "unspecified",
]);
export type ProductPlatform = z.infer<typeof ProductPlatformSchema>;

export const ProductLocaleSchema = z.string().trim().min(2).max(64).regex(
  /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
  "Invalid product locale",
);

export const ProductIdentitySchema = z.object({
  id: ProductIdSchema,
  name: z.string().trim().min(1).max(255),
  status: ProductStatusSchema,
}).strict();
export type ProductIdentity = z.infer<typeof ProductIdentitySchema>;

export const AgentTaskResolvedContextSchema = z.object({
  schemaVersion: z.literal(1),
  product: ProductIdentitySchema.extend({
    updatedAt: timestamp,
  }).strict(),
  design: z.object({
    id: DocumentIdSchema,
    version: z.number().int().positive().max(1_000_000_000),
    revisionId: opaqueIdentifier,
  }).strict(),
  productSpecification: z.object({
    designId: DocumentIdSchema,
    version: z.number().int().positive().max(1_000_000_000),
    specificationHash: sha256,
  }).strict().nullable(),
  designSystem: z.object({
    source: z.enum(["project_pin", "product_default", "formaspec_foundation"]),
    designSystemId: opaqueIdentifier,
    releaseId: opaqueIdentifier,
    releaseVersion: z.number().int().positive().max(1_000_000_000),
  }).strict(),
  repositoryInventories: z.array(z.object({
    id: opaqueIdentifier,
    inventoryHash: sha256,
  }).strict()).max(100),
  locale: ProductLocaleSchema,
  direction: ProductDirectionSchema,
  platform: ProductPlatformSchema,
  capturedAt: timestamp,
}).strict();
export type AgentTaskResolvedContext = z.infer<typeof AgentTaskResolvedContextSchema>;

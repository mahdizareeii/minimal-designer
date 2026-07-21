import {
  DocumentIdSchema,
  ProductSpecificationSchema,
} from "@designer/core";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().trim().min(1).max(240);
const positiveVersion = z.number().int().positive().max(1_000_000_000);

export const ProductSpecificationDiagnosticResultSchema = z.object({
  code: z.string().trim().min(1).max(160),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1).max(4_000),
  path: z.string().max(1_000).optional(),
}).strict();

export const ProductSpecificationResultSchema: z.AnyZodObject = z.object({
  designId: DocumentIdSchema,
  version: positiveVersion,
  specification: ProductSpecificationSchema,
  specificationHash: sha256,
  message: z.string().max(4_000).nullable(),
  revisionId: z.string().trim().min(1).max(240).nullable(),
  actorId: identifier,
  createdAt: timestamp,
}).strict();

export const ProductSpecificationPreviewResultSchema: z.AnyZodObject = z.object({
  id: z.string().regex(/^specpreview_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
  designId: DocumentIdSchema,
  baseVersion: z.number().int().nonnegative().max(1_000_000_000),
  resultVersion: positiveVersion,
  specification: ProductSpecificationSchema,
  specificationHash: sha256,
  diagnostics: z.array(ProductSpecificationDiagnosticResultSchema).max(1_000),
  status: z.enum(["ready", "blocked", "expired", "committed"]),
  canCommit: z.boolean(),
  expiresAt: timestamp,
  committedVersion: positiveVersion.nullable(),
  committedAt: timestamp.nullable(),
}).strict();

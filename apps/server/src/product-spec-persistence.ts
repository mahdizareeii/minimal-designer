import { createHash } from "node:crypto";

import { ProductSpecificationSchema, type ProductSpecification } from "@designer/core";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

export const MAX_PRODUCT_SPECIFICATION_BYTES = 1024 * 1024;

export interface CanonicalProductSpecification {
  specification: ProductSpecification;
  json: string;
  hash: string;
}

export function canonicalProductSpecification(value: unknown): CanonicalProductSpecification {
  const parsed = ProductSpecificationSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "The product specification is invalid.", 422, {
      details: {
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  const jsonSafe = JSON.parse(JSON.stringify(parsed.data)) as unknown;
  const json = canonicalJson(jsonSafe);
  if (Buffer.byteLength(json, "utf8") > MAX_PRODUCT_SPECIFICATION_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "A product specification may not exceed 1 MiB.", 413);
  }
  return {
    specification: ProductSpecificationSchema.parse(JSON.parse(json) as unknown),
    json,
    hash: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

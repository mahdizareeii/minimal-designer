import type { JsonValue } from "@designer/core";
import { z } from "zod";

export interface BoundedJsonLimits {
  maximumDepth: number;
  maximumTotalValues: number;
  maximumArrayItems: number;
  maximumObjectProperties: number;
  maximumKeyCharacters: number;
  maximumStringCharacters: number;
}

const INVALID_BOUNDED_JSON = Symbol("invalid-bounded-json");

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isWithinJsonLimits(value: unknown, limits: BoundedJsonLimits): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let totalValues = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    totalValues += 1;
    if (totalValues > limits.maximumTotalValues || entry.depth > limits.maximumDepth) return false;

    const current = entry.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (current.length > limits.maximumStringCharacters) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object") return false;

    if (Array.isArray(current)) {
      if (current.length > limits.maximumArrayItems) return false;
      for (const child of current) stack.push({ value: child, depth: entry.depth + 1 });
      continue;
    }

    if (!isPlainJsonObject(current)) return false;
    const entries = Object.entries(current);
    if (entries.length > limits.maximumObjectProperties) return false;
    for (const [key, child] of entries) {
      if (key.length > limits.maximumKeyCharacters) return false;
      stack.push({ value: child, depth: entry.depth + 1 });
    }
  }

  return true;
}

interface BoundedJsonSchemas {
  value: z.ZodType<JsonValue, z.ZodTypeDef, unknown>;
  object: z.ZodType<Record<string, JsonValue>, z.ZodTypeDef, unknown>;
  array: z.ZodType<JsonValue[], z.ZodTypeDef, unknown>;
}

function createBoundedJsonSchemas(limits: BoundedJsonLimits): BoundedJsonSchemas {
  const keySchema = z.string().max(limits.maximumKeyCharacters);
  let recursiveValueSchema: z.ZodType<JsonValue>;
  recursiveValueSchema = z.lazy(() => z.union([
    z.string().max(limits.maximumStringCharacters),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(recursiveValueSchema).max(limits.maximumArrayItems),
    z.record(keySchema, recursiveValueSchema).superRefine((record, context) => {
      if (Object.keys(record).length > limits.maximumObjectProperties) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `JSON objects may contain at most ${limits.maximumObjectProperties} properties.`,
        });
      }
    }),
  ]));

  const preflight = (value: unknown) => isWithinJsonLimits(value, limits)
    ? value
    : INVALID_BOUNDED_JSON;

  const value = z.preprocess(preflight, recursiveValueSchema);
  const object = z.preprocess(
      preflight,
      z.record(keySchema, recursiveValueSchema).superRefine((record, context) => {
        if (Object.keys(record).length > limits.maximumObjectProperties) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `JSON objects may contain at most ${limits.maximumObjectProperties} properties.`,
          });
        }
      }),
    );
  const array = z.preprocess(preflight, z.array(recursiveValueSchema).max(limits.maximumArrayItems));
  return { value, object, array };
}

export const PUBLIC_INPUT_JSON_LIMITS = {
  maximumDepth: 16,
  maximumTotalValues: 50_000,
  maximumArrayItems: 10_000,
  maximumObjectProperties: 10_000,
  maximumKeyCharacters: 240,
  maximumStringCharacters: 100_000,
} as const satisfies BoundedJsonLimits;

export const MCP_OUTPUT_JSON_LIMITS = {
  maximumDepth: 32,
  maximumTotalValues: 500_000,
  maximumArrayItems: 25_000,
  maximumObjectProperties: 25_000,
  maximumKeyCharacters: 512,
  maximumStringCharacters: 1_048_576,
} as const satisfies BoundedJsonLimits;

const publicInputSchemas = createBoundedJsonSchemas(PUBLIC_INPUT_JSON_LIMITS);
const mcpOutputSchemas = createBoundedJsonSchemas(MCP_OUTPUT_JSON_LIMITS);

/** JSON-only input bags with finite depth, collection, key, string, and total-value limits. */
export const BoundedJsonValueSchema = publicInputSchemas.value;
export const BoundedJsonObjectSchema = publicInputSchemas.object;
export const BoundedJsonArraySchema = publicInputSchemas.array;

/** Bounded JSON fallbacks for legacy MCP result fields that do not yet have a domain DTO schema. */
export const McpJsonValueOutputSchema = mcpOutputSchemas.value;
export const McpJsonObjectOutputSchema = mcpOutputSchemas.object;
export const McpJsonArrayOutputSchema = mcpOutputSchemas.array;

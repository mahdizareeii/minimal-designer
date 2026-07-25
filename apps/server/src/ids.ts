import { createHash, randomUUID } from "node:crypto";

export type IdPrefix = "product" | "document" | "page" | "node" | "asset" | "component" | "revision" | "preview" | "txn" | "render";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return '{"$undefined":true}';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function actorIdFromToken(token: string | undefined): string {
  if (!token) return "local";
  return `usr_${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

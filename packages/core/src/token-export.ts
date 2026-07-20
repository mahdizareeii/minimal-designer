import type { DesignSystemToken } from "./design-system.js";
import { resolveDesignToken } from "./design-system.js";

export const TOKEN_EXPORT_TARGETS = [
  "css",
  "typescript",
  "android_xml",
  "compose",
  "swift",
  "flutter",
] as const;

export type TokenExportTarget = (typeof TOKEN_EXPORT_TARGETS)[number];

export interface TokenExportDiagnostic {
  tokenId: string;
  severity: "warning";
  message: string;
}

export interface TokenExportResult {
  target: TokenExportTarget;
  filename: string;
  mediaType: string;
  content: string;
  exportedTokenIds: string[];
  diagnostics: TokenExportDiagnostic[];
}

export interface TokenExportOptions {
  mode?: string;
  maximumTokens?: number;
  maximumOutputBytes?: number;
}

type ResolvedValue = ReturnType<typeof resolveDesignToken>["value"];

interface ExportRow {
  token: DesignSystemToken;
  value: ResolvedValue;
}

const DEFAULT_MAXIMUM_TOKENS = 20_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 5 * 1024 * 1024;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`Token export limit must be an integer from ${minimum} to ${maximum}.`);
  }
  return resolved;
}

function scalarIdentifier(path: string, separator: "_" | "-"): string {
  const normalized = path
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, separator)
    .replace(/[_.-]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "")
    .toLowerCase();
  return normalized || "token";
}

function codeIdentifier(path: string): string {
  const parts = path.normalize("NFKD").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
  }).join("");
  const value = joined || "token";
  return /^[A-Za-z_]/.test(value) ? value : `token${value}`;
}

function pascalIdentifier(path: string): string {
  const camel = codeIdentifier(path);
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function safeCssString(value: string): string {
  if (/^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,% /+-]+\)|-?[0-9.]+(?:px|rem|em|%|ms|s|deg)?|transparent|currentColor|inherit|initial|unset)$/i.test(value)) {
    return value;
  }
  return jsonLiteral(value);
}

function cssValue(row: ExportRow): string | null {
  const { token, value } = row;
  if (typeof value === "string") return safeCssString(value);
  if (typeof value === "number") {
    if (["spacing", "dimension", "radius", "border_width", "font_size", "letter_spacing"].includes(token.family)) return `${value}px`;
    if (token.family === "duration") return `${value}ms`;
    return String(value);
  }
  if ("x" in value) {
    return `${value.inset ? "inset " : ""}${value.x}px ${value.y}px ${value.blur}px ${value.spread ?? 0}px ${safeCssString(value.color)}`;
  }
  if ("font_family" in value || "font_size" in value) {
    const family = value.font_family ? safeCssString(value.font_family) : "inherit";
    const size = value.font_size === undefined ? "inherit" : `${value.font_size}px`;
    const lineHeight = value.line_height === undefined ? "normal" : String(value.line_height);
    const weight = value.font_weight === undefined ? "inherit" : String(value.font_weight);
    return `normal ${weight} ${size}/${lineHeight} ${family}`;
  }
  return null;
}

function platformLiteral(value: ResolvedValue, language: "typescript" | "compose" | "swift" | "flutter"): string {
  if (typeof value === "number") {
    if (language === "compose") return Number.isInteger(value) ? `${value}` : `${value}f`;
    return String(value);
  }
  if (typeof value === "string") return jsonLiteral(value);
  const serialized = jsonLiteral(value);
  return language === "typescript" ? serialized : jsonLiteral(serialized);
}

function androidResource(row: ExportRow): { element: string; value: string } {
  const { token, value } = row;
  if (token.family === "color" && typeof value === "string") return { element: "color", value: xmlEscape(value) };
  if (["spacing", "dimension", "radius", "border_width", "font_size", "letter_spacing"].includes(token.family) && typeof value === "number") {
    return { element: "dimen", value: `${value}dp` };
  }
  if (["number", "font_weight"].includes(token.family) && typeof value === "number" && Number.isInteger(value)) {
    return { element: "integer", value: String(value) };
  }
  return { element: "string", value: xmlEscape(typeof value === "string" ? value : jsonLiteral(value)) };
}

function buildRows(tokens: Record<string, DesignSystemToken>, options: TokenExportOptions): ExportRow[] {
  const maximumTokens = boundedInteger(options.maximumTokens, DEFAULT_MAXIMUM_TOKENS, 1, DEFAULT_MAXIMUM_TOKENS);
  const active = Object.values(tokens).filter((token) => !token.deprecated);
  if (active.length > maximumTokens) throw new Error(`Token export exceeds the ${maximumTokens} token limit.`);
  return active
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .map((token) => ({ token, value: resolveDesignToken(tokens, token.id, options.mode).value }));
}

function ensureBoundedOutput(content: string, options: TokenExportOptions): void {
  const maximum = boundedInteger(options.maximumOutputBytes, DEFAULT_MAXIMUM_OUTPUT_BYTES, 1_024, DEFAULT_MAXIMUM_OUTPUT_BYTES);
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > maximum) throw new Error(`Token export exceeds the ${maximum} byte output limit.`);
}

export function exportDesignTokens(
  tokens: Record<string, DesignSystemToken>,
  target: TokenExportTarget,
  options: TokenExportOptions = {},
): TokenExportResult {
  if (!TOKEN_EXPORT_TARGETS.includes(target)) throw new Error(`Unsupported token export target: ${String(target)}`);
  const rows = buildRows(tokens, options);
  const diagnostics: TokenExportDiagnostic[] = [];
  let content: string;
  let filename: string;
  let mediaType: string;

  if (target === "css") {
    const declarations = rows.flatMap((row) => {
      const value = cssValue(row);
      if (value === null) {
        diagnostics.push({ tokenId: row.token.id, severity: "warning", message: "The token value has no safe CSS representation and was omitted." });
        return [];
      }
      return [`  --${scalarIdentifier(row.token.path, "-")}: ${value};`];
    });
    content = `:root {\n${declarations.join("\n")}\n}\n`;
    filename = "formaspec-tokens.css";
    mediaType = "text/css";
  } else if (target === "typescript") {
    const properties = rows.map((row) => `  ${jsonLiteral(row.token.path)}: ${platformLiteral(row.value, "typescript")},`);
    content = `// Generated by FormaSpec. Values only; this is not application code.\nexport const formaSpecTokens = {\n${properties.join("\n")}\n} as const;\n`;
    filename = "formaspec-tokens.ts";
    mediaType = "text/typescript";
  } else if (target === "android_xml") {
    const resources = rows.map((row) => {
      const resource = androidResource(row);
      const translatable = resource.element === "string" ? ' translatable="false"' : "";
      return `  <${resource.element} name="${scalarIdentifier(row.token.path, "_")}"${translatable}>${resource.value}</${resource.element}>`;
    });
    content = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${resources.join("\n")}\n</resources>\n`;
    filename = "formaspec_tokens.xml";
    mediaType = "application/xml";
  } else if (target === "compose") {
    const properties = rows.map((row) => `  const val ${pascalIdentifier(row.token.path)} = ${platformLiteral(row.value, "compose")}`);
    content = `// Generated FormaSpec token values. Map them into your Compose theme explicitly.\nobject FormaSpecTokens {\n${properties.join("\n")}\n}\n`;
    filename = "FormaSpecTokens.kt";
    mediaType = "text/x-kotlin";
  } else if (target === "swift") {
    const properties = rows.map((row) => `  static let ${codeIdentifier(row.token.path)} = ${platformLiteral(row.value, "swift")}`);
    content = `// Generated FormaSpec token values. Map them into the application theme explicitly.\nenum FormaSpecTokens {\n${properties.join("\n")}\n}\n`;
    filename = "FormaSpecTokens.swift";
    mediaType = "text/x-swift";
  } else {
    const properties = rows.map((row) => `  static const ${codeIdentifier(row.token.path)} = ${platformLiteral(row.value, "flutter")};`);
    content = `// Generated FormaSpec token values. Map them into ThemeData explicitly.\nabstract final class FormaSpecTokens {\n${properties.join("\n")}\n}\n`;
    filename = "formaspec_tokens.dart";
    mediaType = "text/x-dart";
  }

  ensureBoundedOutput(content, options);
  const omitted = new Set(diagnostics.map((diagnostic) => diagnostic.tokenId));
  return {
    target,
    filename,
    mediaType,
    content,
    exportedTokenIds: rows.filter((row) => !omitted.has(row.token.id)).map((row) => row.token.id),
    diagnostics,
  };
}

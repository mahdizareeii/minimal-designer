import {
  AnyDesignDocumentSchema,
  DesignDocumentSchema,
  DesignOperationListSchema,
  V2CompatibilityError,
  applyOperations as applyCoreOperations,
  createId as createCoreId,
  createStarterDocument,
  lintDesignDocument,
  lintDesignDocumentV2,
  mergeV1CompatibilityDocument,
  toV1CompatibleDesignDocument,
  validateDesignDocument,
  type AnyDesignDocument,
  type DesignDocument,
  type DesignOperation,
  type IdFactory,
  type IdKind,
} from "@designer/core";

import { DomainError } from "./errors.js";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  node_id?: string;
  path?: string;
  [key: string]: unknown;
}

export interface AppliedOperations {
  document: AnyDesignDocument;
  createdIds: unknown;
  diagnostics: Diagnostic[];
}

const temporaryIdPattern = /^tmp:[A-Za-z0-9._-]{1,80}$/;
const nodeTypes = new Set(["frame", "group", "rectangle", "ellipse", "text", "image", "icon", "component", "instance"]);

function inferDefinitionKind(object: Record<string, unknown>, parentKey: string | undefined): IdKind | undefined {
  if (parentKey === "page") return "page";
  if (parentKey === "token") return "token";
  if (parentKey === "asset") return "asset";
  if (parentKey === "link") return "link";
  if (typeof object.type === "string" && nodeTypes.has(object.type) && object.layout && object.style) return "node";
  if ("background" in object && "children" in object && "archived" in object) return "page";
  if ("path" in object && "kind" in object && "value" in object) return "token";
  if ("mime_type" in object && "storage_key" in object && "size_bytes" in object) return "asset";
  if ("source_node_id" in object && "trigger" in object && "action" in object) return "link";
  return undefined;
}

function isIdentifierField(key: string | undefined): boolean {
  return key === "id" || key === "children" || key === "root_ids" || key?.endsWith("_id") === true || key?.endsWith("_ids") === true;
}

export function normalizeTemporaryReferences(
  input: unknown,
  createTemporaryId: (temporaryId: string, kind: IdKind) => string = (_temporaryId, kind) => createCoreId(kind),
): { operations: unknown; idMap: Record<string, string> } {
  const definitions = new Map<string, IdKind>();
  const collect = (value: unknown, parentKey?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, parentKey);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && temporaryIdPattern.test(object.id)) {
      const kind = inferDefinitionKind(object, parentKey);
      if (!kind) {
        throw new DomainError("VALIDATION_FAILED", `Cannot infer an entity type for temporary ID ${object.id}.`, 422);
      }
      const existing = definitions.get(object.id);
      if (existing && existing !== kind) {
        throw new DomainError("VALIDATION_FAILED", `Temporary ID ${object.id} is used for multiple entity types.`, 422);
      }
      definitions.set(object.id, kind);
    }
    for (const [key, child] of Object.entries(object)) collect(child, key);
  };
  collect(input);

  const idMap: Record<string, string> = {};
  for (const [temporaryId, kind] of definitions) idMap[temporaryId] = createTemporaryId(temporaryId, kind);

  const rewrite = (value: unknown, parentKey?: string): unknown => {
    if (typeof value === "string" && temporaryIdPattern.test(value) && isIdentifierField(parentKey)) {
      const replacement = idMap[value];
      if (!replacement) {
        throw new DomainError("VALIDATION_FAILED", `Temporary reference ${value} has no matching entity definition.`, 422);
      }
      return replacement;
    }
    if (Array.isArray(value)) return value.map((item) => rewrite(item, parentKey));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rewrite(child, key)]));
  };

  return { operations: rewrite(input), idMap };
}

function normalizeDiagnostic(value: unknown): Diagnostic {
  if (typeof value === "string") return { severity: "warning", code: "CORE_DIAGNOSTIC", message: value };
  if (!value || typeof value !== "object") {
    return { severity: "warning", code: "CORE_DIAGNOSTIC", message: String(value) };
  }
  const diagnostic = value as Record<string, unknown>;
  const rawSeverity = diagnostic.severity ?? diagnostic.level;
  const severity = rawSeverity === "error" || rawSeverity === "info" ? rawSeverity : "warning";
  return {
    ...diagnostic,
    severity,
    code: typeof diagnostic.code === "string" ? diagnostic.code : "CORE_DIAGNOSTIC",
    message: typeof diagnostic.message === "string" ? diagnostic.message : JSON.stringify(diagnostic),
  };
}

function normalizeDiagnostics(value: unknown): Diagnostic[] {
  if (Array.isArray(value)) return value.map(normalizeDiagnostic);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.diagnostics)) return object.diagnostics.map(normalizeDiagnostic);
    if (Array.isArray(object.issues)) return object.issues.map(normalizeDiagnostic);
    if (Array.isArray(object.errors)) {
      return [
        ...object.errors.map((item) => ({ ...normalizeDiagnostic(item), severity: "error" as const })),
        ...(Array.isArray(object.warnings)
          ? object.warnings.map((item) => ({ ...normalizeDiagnostic(item), severity: "warning" as const }))
          : []),
      ];
    }
  }
  return [];
}

export function createDocument(id: string, name: string, now: string, preset: "web" | "phone" | "tablet" = "web"): DesignDocument {
  try {
    const factory = createStarterDocument as unknown as (input: {
      id: string;
      name: string;
      preset: "web" | "phone" | "tablet";
      now?: string;
      created_at?: string;
      updated_at?: string;
    }) => DesignDocument;
    const document = factory({ id, name, preset, now, created_at: now, updated_at: now });
    const normalized = {
      ...document,
      id,
      name,
      revision: 1,
      created_at: document.created_at ?? now,
      updated_at: now,
    };
    return DesignDocumentSchema.parse(normalized);
  } catch (error) {
    throw new DomainError("CORE_UNAVAILABLE", "The core document factory rejected the initial document.", 500, {
      details: { reason: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }
}

function compatibilityError(error: V2CompatibilityError): DomainError {
  return new DomainError(
    "UNSUPPORTED_DOCUMENT_FEATURE",
    error.message,
    422,
    { details: { issues: error.issues } },
  );
}

export function parseDocument(value: unknown): AnyDesignDocument {
  try {
    return AnyDesignDocumentSchema.parse(value);
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Stored design document is invalid.", 422, {
      details: { reason: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }
}

export function editorDocument(document: AnyDesignDocument): DesignDocument {
  try {
    return toV1CompatibleDesignDocument(document);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof V2CompatibilityError) throw compatibilityError(error);
    throw error;
  }
}

export function parseOperations(value: unknown): DesignOperation[] {
  try {
    return DesignOperationListSchema.parse(value);
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "One or more design operations are invalid.", 422, {
      details: { reason: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }
}

export function collectDiagnostics(document: AnyDesignDocument): Diagnostic[] {
  const compatible = editorDocument(document);
  const validation = normalizeDiagnostics(validateDesignDocument(compatible));
  const lint = normalizeDiagnostics(lintDesignDocument(compatible));
  const v2Lint = document.schema_version === 2
    ? normalizeDiagnostics(lintDesignDocumentV2(document))
    : [];
  const compatibility: Diagnostic[] = document.schema_version === 2
    ? [{
      severity: "info" as const,
      code: "V2_COMPATIBILITY_PROJECTION",
      message: "The current editor and renderer use a V1 compatibility projection while the canonical snapshot remains strict V2.",
    }]
    : [];
  const seen = new Set<string>();
  return [...compatibility, ...validation, ...lint, ...v2Lint].filter((diagnostic) => {
    const key = `${diagnostic.severity}:${diagnostic.code}:${diagnostic.node_id ?? ""}:${diagnostic.path ?? ""}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyOperations(
  document: AnyDesignDocument,
  operationsValue: unknown,
  options: { expectedRevision: number; now: string; idFactory?: IdFactory },
): AppliedOperations {
  const operations = parseOperations(operationsValue);
  try {
    const compatible = editorDocument(document);
    const result = applyCoreOperations(compatible, operations, {
      expectedRevision: options.expectedRevision,
      now: options.now,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    });
    const editedDocument = DesignDocumentSchema.parse(result.document);
    const accessibilityLabelEdits = new Map<string, string | null>();
    for (const operation of operations) {
      if (operation.type === "update_node" && operation.patch.accessibility_label !== undefined) {
        accessibilityLabelEdits.set(operation.node_id, operation.patch.accessibility_label);
      }
    }
    const nextDocument = document.schema_version === 2
      ? mergeV1CompatibilityDocument(document, editedDocument, { accessibilityLabelEdits })
      : editedDocument;
    const diagnostics = [
      ...normalizeDiagnostics(result.diagnostics),
      ...collectDiagnostics(nextDocument),
    ];
    return {
      document: nextDocument,
      createdIds: result.created_ids ?? [],
      diagnostics,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof V2CompatibilityError) throw compatibilityError(error);
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    if (candidate.code === "revision_conflict" || candidate.code === "REVISION_CONFLICT") {
      const details = typeof candidate.details === "object" && candidate.details !== null
        ? candidate.details as Record<string, unknown>
        : undefined;
      throw new DomainError("VERSION_CONFLICT", "The design changed before the operations could be applied.", 409, {
        retryable: true,
        ...(details ? { details } : {}),
        cause: error,
      });
    }
    const details = typeof candidate.details === "object" && candidate.details !== null
      ? candidate.details as Record<string, unknown>
      : undefined;
    throw new DomainError("VALIDATION_FAILED", typeof candidate.message === "string" ? candidate.message : "Operations could not be applied.", 422, {
      ...(details ? { details } : {}),
      cause: error,
    });
  }
}

export type { DesignDocument, DesignOperation };

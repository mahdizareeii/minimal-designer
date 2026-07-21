import {
  ComponentDefinitionIdSchema,
  ComponentDefinitionSchema,
  DesignNodeV2Schema,
  DesignSystemIdSchema,
  DesignSystemReleaseIdSchema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  DocumentIdSchema,
  NodeIdSchema,
  TokenIdSchema,
} from "@designer/core";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(300);
const timestamp = z.string().datetime({ offset: true });
const positiveVersion = z.number().int().positive().max(1_000_000_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

function boundedRecord<Value extends z.ZodTypeAny>(
  key: z.ZodTypeAny,
  value: Value,
  maximum: number,
) {
  return z.record(key, value).superRefine((record, context) => {
    if (Object.keys(record).length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The collection may contain at most ${maximum} entries.`,
      });
    }
  });
}

export const DesignSystemDiagnosticResultSchema = z.object({
  code: z.string().trim().min(1).max(160),
  severity: z.enum(["info", "warning", "error"]),
  safety: z.enum(["safe", "review_required", "blocked"]),
  message: z.string().min(1).max(4_000),
  entityKind: z.enum(["release", "token", "component", "project"]).optional(),
  entityId: identifier.optional(),
  path: z.string().max(500).optional(),
}).strict();

export const FoundationDesignSystemResultSchema: z.AnyZodObject = z.object({
  id: DesignSystemIdSchema,
  name: z.string().trim().min(1).max(240),
  version: positiveVersion,
  fonts: z.array(z.object({
    family: z.string().trim().min(1).max(120),
    license: z.string().trim().min(1).max(120),
  }).strict()).max(100),
  iconSet: z.object({
    name: z.string().trim().min(1).max(120),
    license: z.string().trim().min(1).max(120),
  }).strict(),
  tokens: boundedRecord(TokenIdSchema, DesignSystemTokenSchema, 20_000),
  nodes: boundedRecord(NodeIdSchema, DesignNodeV2Schema, 100_000),
  components: boundedRecord(ComponentDefinitionIdSchema, ComponentDefinitionSchema, 5_000),
  patterns: z.array(z.string().trim().min(1).max(240)).max(100),
  release: DesignSystemReleaseSchema,
}).strict();

export const DesignSystemResultSchema = z.object({
  id: DesignSystemIdSchema,
  name: z.string().trim().min(1).max(240),
  description: z.string().max(10_000),
  status: z.enum(["active", "archived"]),
  createdBy: identifier,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const DesignSystemReleaseResultSchema = z.object({
  id: DesignSystemReleaseIdSchema,
  designSystemId: DesignSystemIdSchema,
  version: positiveVersion,
  name: z.string().trim().min(1).max(240),
  status: z.enum(["draft", "published", "deprecated"]),
  tokenVersions: z.array(z.object({
    tokenId: TokenIdSchema,
    version: positiveVersion,
  }).strict()).max(20_000),
  componentVersions: z.array(z.object({
    componentDefinitionId: ComponentDefinitionIdSchema,
    version: positiveVersion,
  }).strict()).max(5_000),
  diagnostics: z.array(DesignSystemDiagnosticResultSchema).max(20_000),
  createdBy: identifier,
  createdAt: timestamp,
  publishedAt: timestamp.nullable(),
}).strict();

export const ProjectDesignSystemPinResultSchema = z.object({
  designId: DocumentIdSchema,
  designSystemId: DesignSystemIdSchema,
  releaseId: DesignSystemReleaseIdSchema,
  releaseVersion: positiveVersion,
  pinnedBy: identifier,
  pinnedAt: timestamp,
}).strict();

const RevisionDesignSystemPinReferenceSchema = z.object({
  designSystemId: DesignSystemIdSchema,
  releaseId: DesignSystemReleaseIdSchema,
  releaseVersion: positiveVersion,
}).strict();

export const RevisionDesignSystemReleaseResultSchema = z.object({
  designId: DocumentIdSchema,
  revisionId: z.string().regex(/^revision_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
  revisionVersion: positiveVersion,
  snapshotHash: sha256,
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  pin: RevisionDesignSystemPinReferenceSchema.nullable(),
  release: DesignSystemReleaseResultSchema.nullable(),
}).strict().superRefine((result, context) => {
  if (result.schemaVersion === 1) {
    if (result.pin !== null || result.release !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "V1 revisions cannot expose a design-system release binding.",
      });
    }
    return;
  }
  if (result.pin === null || result.release === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "V2 revisions must expose their exact design-system release binding.",
    });
    return;
  }
  if (result.pin.designSystemId !== result.release.designSystemId
    || result.pin.releaseId !== result.release.id
    || result.pin.releaseVersion !== result.release.version) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Revision design-system pin and release metadata must match.",
    });
  }
});

export const DesignSystemUpgradePreviewResultSchema = z.object({
  id: z.string().regex(/^upgrade_[a-f0-9]{32}$/),
  designId: DocumentIdSchema,
  currentReleaseId: DesignSystemReleaseIdSchema,
  targetReleaseId: DesignSystemReleaseIdSchema,
  designVersion: positiveVersion,
  designRevisionId: z.string().regex(/^revision_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
  baseRevisionId: z.string().regex(/^revision_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/).nullable(),
  baseSnapshotHash: sha256.nullable(),
  resultSnapshotHash: sha256.nullable(),
  diagnostics: z.array(DesignSystemDiagnosticResultSchema).max(20_000),
  previewHash: sha256,
  status: z.enum(["ready", "blocked", "committed", "expired"]),
  canCommit: z.boolean(),
  createdAt: timestamp,
  expiresAt: timestamp,
  committedAt: timestamp.nullable(),
}).strict().superRefine((preview, context) => {
  const exactValues = [preview.baseRevisionId, preview.baseSnapshotHash, preview.resultSnapshotHash];
  if (exactValues.some((value) => value === null) && exactValues.some((value) => value !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseRevisionId"],
      message: "Exact upgrade preview snapshot metadata must be entirely present or entirely null.",
    });
  }
});

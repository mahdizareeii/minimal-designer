import { randomUUID } from "node:crypto";

import {
  FORMASPEC_FOUNDATION_RELEASE_ID,
  ProductDirectionSchema,
  ProductIdSchema,
  ProductLocaleSchema,
  type ProductDirection,
  type ProductStatus,
} from "@designer/core";

import {
  appendAuditEvent,
  assertScope,
  resolveAccess,
  type AccessContext,
} from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import {
  flushPersistedEventOutbox,
  type DesignerEventType,
  type EventHub,
} from "./events.js";
import { canonicalJson, createId, hashPayload } from "./ids.js";

const PRODUCT_CURSOR_PREFIX = "product_cursor_";
const IDEMPOTENCY_TTL_MS = 86_400_000;
const PRODUCT_ARCHIVE_BLOCKER_LIMIT = 20;

interface ProductRow {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  status: ProductStatus;
  owner_principal_id: string;
  canonical_specification_design_id: string | null;
  default_design_system_release_id: string | null;
  default_locale: string;
  default_direction: ProductDirection;
  locales_json: string;
  metadata_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ProductDesignRow {
  id: string;
  name: string;
  current_version: number;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface ProductCursorPayload {
  schemaVersion: 1;
  accessHash: string;
  updatedAt: string;
  id: string;
  includeArchived: boolean;
  checksum: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  description: string;
  status: ProductStatus;
  ownerPrincipalId: string;
  defaultDesignSystemReleaseId: string | null;
  defaultLocale: string;
  defaultDirection: ProductDirection;
  locales: string[];
  canonicalSpecificationDesignId: string | null;
  designCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProductDesignSummary {
  id: string;
  name: string;
  version: number;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDetail {
  product: ProductSummary & {
    metadata: Record<string, unknown>;
  };
  designs: ProductDesignSummary[];
  canonicalSpecification: {
    designId: string;
    version: number;
    specificationHash: string;
  } | null;
  repositoryInventories: Array<{
    id: string;
    inventoryHash: string;
    status: string;
  }>;
}

export interface ProductListResult {
  products: ProductSummary[];
  nextCursor: string | null;
}

export interface ProductMovePreviewResult {
  id: string;
  designId: string;
  sourceProduct: { id: string; name: string };
  targetProduct: { id: string; name: string };
  expectedDesignVersion: number;
  status: "ready" | "expired" | "committed";
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${label} JSON is invalid.`, 500, { cause: error });
  }
}

function parseLocales(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.map((locale) => ProductLocaleSchema.parse(locale));
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Persisted Product locales are invalid.", 500, { cause: error });
  }
}

function assertProductManager(access: AccessContext): void {
  if (access.role !== "organization_admin" && access.role !== "product_manager") {
    throw new DomainError(
      "FORBIDDEN",
      "Organization Administrator or Product Manager permission is required to manage Products.",
      403,
    );
  }
}

function boundedText(value: string, label: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} is outside the supported length.`, 422);
  }
  return normalized;
}

function normalizedMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const metadata = value ?? {};
  const encoded = canonicalJson(metadata);
  if (Buffer.byteLength(encoded, "utf8") > 65_536) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Product metadata may contain at most 64 KiB of JSON.", 413);
  }
  return parseJsonObject(encoded, "Product metadata");
}

function normalizedLocales(locales: readonly string[], defaultLocale: string): string[] {
  const parsed = [...new Set(locales.map((locale) => ProductLocaleSchema.parse(locale)))];
  if (parsed.length === 0 || parsed.length > 100 || !parsed.includes(defaultLocale)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Product locales must contain the default locale and include between 1 and 100 unique values.",
      422,
    );
  }
  return parsed;
}

export class ProductService {
  constructor(
    readonly database: DesignerDatabase,
    private readonly events?: EventHub,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listProducts(
    actorId: string,
    input: { limit?: number; cursor?: string; includeArchived?: boolean } = {},
  ): ProductListResult {
    const access = this.readAccess(actorId);
    const includeArchived = input.includeArchived === true && access.role !== "agent";
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const accessHash = this.accessHash(access);
    const cursor = input.cursor === undefined
      ? null
      : this.parseCursor(input.cursor, accessHash, includeArchived);
    const conditions = ["product.organization_id = ?"];
    const parameters: Array<string | number> = [access.organizationId];
    if (!includeArchived) conditions.push("product.status = 'active'");
    if (access.projectIds.length > 0) {
      conditions.push(`EXISTS (
        SELECT 1 FROM designs visible_design
        WHERE visible_design.product_id = product.id
          AND visible_design.id IN (${access.projectIds.map(() => "?").join(", ")})
          AND NOT EXISTS (
            SELECT 1 FROM system_metadata archive
            WHERE archive.key = 'design_archive:' || visible_design.id
          )
      )`);
      parameters.push(...access.projectIds);
    }
    if (cursor !== null) {
      conditions.push("(product.updated_at < ? OR (product.updated_at = ? AND product.id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    parameters.push(limit + 1);
    const rows = this.database.sqlite.prepare(
      `SELECT product.*,
              (SELECT COUNT(*) FROM designs design
               WHERE design.product_id = product.id
                 AND NOT EXISTS (
                   SELECT 1 FROM system_metadata archive
                   WHERE archive.key = 'design_archive:' || design.id
                 )) AS design_count
       FROM products product
       WHERE ${conditions.join(" AND ")}
       ORDER BY product.updated_at DESC, product.id DESC LIMIT ?`,
    ).all(...parameters) as Array<ProductRow & { design_count: number }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      products: selected.map((row) => this.summary(row, row.design_count)),
      nextCursor: hasMore && selected.length > 0
        ? this.cursor(selected.at(-1)!, accessHash, includeArchived)
        : null,
    };
  }

  readProduct(actorId: string, productId: string, includeArchived = false): ProductDetail {
    const access = this.readAccess(actorId);
    const row = this.requireProduct(access, productId, includeArchived && access.role !== "agent");
    return this.detail(access, row);
  }

  createProduct(actorId: string, input: {
    name: string;
    description?: string;
    defaultDesignSystemReleaseId?: string | null;
    defaultLocale?: string;
    defaultDirection?: ProductDirection;
    locales?: string[];
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }): ProductDetail {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot create Products.", 403);
    }
    const name = boundedText(input.name, "Product name", 255);
    const description = boundedText(input.description ?? "", "Product description", 20_000, true);
    const defaultLocale = ProductLocaleSchema.parse(input.defaultLocale ?? "en");
    const defaultDirection = ProductDirectionSchema.parse(input.defaultDirection ?? "ltr");
    const locales = normalizedLocales(input.locales ?? [defaultLocale], defaultLocale);
    const metadata = normalizedMetadata(input.metadata);
    const releaseId = input.defaultDesignSystemReleaseId ?? null;
    this.assertRelease(access, releaseId);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, "product:create", key, {
      name,
      description,
      defaultDesignSystemReleaseId: releaseId,
      defaultLocale,
      defaultDirection,
      locales,
      metadata,
    }, () => {
      const now = this.now().toISOString();
      const id = createId("product");
      this.database.sqlite.prepare(
        `INSERT INTO products
         (id, organization_id, name, description, status, owner_principal_id,
          canonical_specification_design_id, default_design_system_release_id,
          default_locale, default_direction, locales_json, metadata_json,
          created_by, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        access.organizationId,
        name,
        description,
        access.principalId,
        releaseId,
        defaultLocale,
        defaultDirection,
        canonicalJson(locales),
        canonicalJson(metadata),
        access.principalId,
        now,
        now,
      );
      appendAuditEvent(this.database.sqlite, access, "product.create", "product", id, {
        name,
        defaultDesignSystemReleaseId: releaseId,
        defaultLocale,
        defaultDirection,
      });
      return this.detail(access, this.requireProduct(access, id));
    });
  }

  updateProduct(actorId: string, productId: string, input: {
    expectedUpdatedAt: string;
    name?: string;
    description?: string;
    defaultDesignSystemReleaseId?: string | null;
    defaultLocale?: string;
    defaultDirection?: ProductDirection;
    locales?: string[];
    metadata?: Record<string, unknown>;
    canonicalSpecificationDesignId?: string | null;
    idempotencyKey: string;
  }): ProductDetail {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    const product = this.requireProduct(access, productId);
    const name = input.name === undefined ? product.name : boundedText(input.name, "Product name", 255);
    const description = input.description === undefined
      ? product.description
      : boundedText(input.description, "Product description", 20_000, true);
    const defaultLocale = ProductLocaleSchema.parse(input.defaultLocale ?? product.default_locale);
    const defaultDirection = ProductDirectionSchema.parse(input.defaultDirection ?? product.default_direction);
    const locales = normalizedLocales(input.locales ?? parseLocales(product.locales_json), defaultLocale);
    const metadata = input.metadata === undefined
      ? parseJsonObject(product.metadata_json, "Product metadata")
      : normalizedMetadata(input.metadata);
    const releaseId = input.defaultDesignSystemReleaseId === undefined
      ? product.default_design_system_release_id
      : input.defaultDesignSystemReleaseId;
    this.assertRelease(access, releaseId);
    const canonicalDesignId = input.canonicalSpecificationDesignId === undefined
      ? product.canonical_specification_design_id
      : input.canonicalSpecificationDesignId;
    if (canonicalDesignId !== null) this.requireDesignInProduct(access, product.id, canonicalDesignId);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `product:${product.id}:update`, key, input, () => {
      const current = this.requireProduct(access, product.id);
      if (current.updated_at !== input.expectedUpdatedAt) throw this.versionConflict(input.expectedUpdatedAt, current.updated_at);
      const now = this.now().toISOString();
      const updated = this.database.sqlite.prepare(
        `UPDATE products
         SET name = ?, description = ?, default_design_system_release_id = ?,
             default_locale = ?, default_direction = ?, locales_json = ?, metadata_json = ?,
             canonical_specification_design_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND updated_at = ?`,
      ).run(
        name,
        description,
        releaseId,
        defaultLocale,
        defaultDirection,
        canonicalJson(locales),
        canonicalJson(metadata),
        canonicalDesignId,
        now,
        product.id,
        access.organizationId,
        input.expectedUpdatedAt,
      );
      if (updated.changes !== 1) {
        throw this.versionConflict(input.expectedUpdatedAt, this.requireProduct(access, product.id).updated_at);
      }
      appendAuditEvent(this.database.sqlite, access, "product.update", "product", product.id, {
        defaultDesignSystemReleaseId: releaseId,
        defaultLocale,
        defaultDirection,
        canonicalSpecificationDesignId: canonicalDesignId,
      });
      return this.detail(access, this.requireProduct(access, product.id));
    });
  }

  archiveProduct(actorId: string, productId: string, input: {
    expectedUpdatedAt: string;
    confirmationName: string;
    idempotencyKey: string;
  }): ProductDetail {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    const product = this.requireProduct(access, productId, true);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `product:${product.id}:archive`, key, input, () => {
      const current = this.requireProduct(access, product.id, true);
      if (current.status === "archived") {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Product is already archived.", 409, {
          details: { expectedStatus: "active", currentStatus: "archived", archivedAt: current.archived_at },
        });
      }
      if (current.updated_at !== input.expectedUpdatedAt) throw this.versionConflict(input.expectedUpdatedAt, current.updated_at);
      if (input.confirmationName !== current.name) {
        throw new DomainError("VALIDATION_FAILED", "Type the exact Product name to confirm archival.", 422);
      }
      const activeDesignCount = (this.database.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM designs design
         WHERE design.product_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM system_metadata archive
             WHERE archive.key = 'design_archive:' || design.id
           )`,
      ).get(current.id) as { count: number }).count;
      if (activeDesignCount > 0) {
        const activeDesigns = this.database.sqlite.prepare(
          `SELECT design.id, design.name, design.current_version, design.updated_at
           FROM designs design
           WHERE design.product_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM system_metadata archive
               WHERE archive.key = 'design_archive:' || design.id
             )
           ORDER BY design.updated_at DESC, design.id DESC LIMIT ?`,
        ).all(current.id, PRODUCT_ARCHIVE_BLOCKER_LIMIT) as Array<{
          id: string;
          name: string;
          current_version: number;
          updated_at: string;
        }>;
        throw new DomainError(
          "PRODUCT_NOT_EMPTY",
          "Move or archive every active design before archiving its Product.",
          409,
          {
            details: {
              activeDesignCount,
              activeDesigns: activeDesigns.map((design) => ({
                id: design.id,
                name: design.name,
                version: design.current_version,
                updatedAt: design.updated_at,
              })),
              truncated: activeDesignCount > activeDesigns.length,
            },
          },
        );
      }
      const now = this.now().toISOString();
      const updated = this.database.sqlite.prepare(
        `UPDATE products SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND updated_at = ?`,
      ).run(now, now, current.id, access.organizationId, input.expectedUpdatedAt);
      if (updated.changes !== 1) {
        throw this.versionConflict(input.expectedUpdatedAt, this.requireProduct(access, current.id, true).updated_at);
      }
      const auditEventId = appendAuditEvent(
        this.database.sqlite,
        access,
        "product.archive",
        "product",
        current.id,
        { archivedAt: now },
      );
      this.enqueueEvent(access, "product.updated", {
        auditEventId,
        productId: current.id,
        status: "archived",
        archived: true,
        archivedAt: now,
        updatedAt: now,
      }, now);
      return this.detail(access, this.requireProduct(access, current.id, true));
    });
  }

  restoreProduct(actorId: string, productId: string, input: {
    expectedUpdatedAt: string;
    expectedArchivedAt: string;
    idempotencyKey: string;
  }): ProductDetail {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    const product = this.requireProduct(access, productId, true);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `product:${product.id}:restore`, key, input, () => {
      const current = this.requireProduct(access, product.id, true);
      if (current.status !== "archived" || current.archived_at === null) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Product is active and cannot be restored.", 409, {
          details: { expectedStatus: "archived", currentStatus: current.status },
        });
      }
      if (current.updated_at !== input.expectedUpdatedAt || current.archived_at !== input.expectedArchivedAt) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Product archive state changed before restoration.", 409, {
          retryable: true,
          details: {
            expectedUpdatedAt: input.expectedUpdatedAt,
            currentUpdatedAt: current.updated_at,
            expectedArchivedAt: input.expectedArchivedAt,
            currentArchivedAt: current.archived_at,
          },
        });
      }
      const now = this.now().toISOString();
      const updated = this.database.sqlite.prepare(
        `UPDATE products SET status = 'active', archived_at = NULL, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'archived'
           AND updated_at = ? AND archived_at = ?`,
      ).run(
        now,
        current.id,
        access.organizationId,
        input.expectedUpdatedAt,
        input.expectedArchivedAt,
      );
      if (updated.changes !== 1) {
        const latest = this.requireProduct(access, current.id, true);
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Product archive state changed before restoration.", 409, {
          retryable: true,
          details: {
            expectedUpdatedAt: input.expectedUpdatedAt,
            currentUpdatedAt: latest.updated_at,
            expectedArchivedAt: input.expectedArchivedAt,
            currentArchivedAt: latest.archived_at,
          },
        });
      }
      const auditEventId = appendAuditEvent(this.database.sqlite, access, "product.restore", "product", current.id, {
        archivedAt: input.expectedArchivedAt,
        restoredAt: now,
      });
      this.enqueueEvent(access, "product.updated", {
        auditEventId,
        productId: current.id,
        status: "active",
        archived: false,
        archivedAt: null,
        restoredFromArchive: true,
        previousArchivedAt: input.expectedArchivedAt,
        restoredAt: now,
        updatedAt: now,
      }, now);
      return this.detail(access, this.requireProduct(access, current.id));
    });
  }

  previewDesignMove(actorId: string, productId: string, designId: string, input: {
    expectedSourceProductId: string;
    expectedDesignVersion: number;
    idempotencyKey: string;
    expiresInSeconds?: number;
  }): ProductMovePreviewResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    const target = this.requireProduct(access, productId);
    ProductIdSchema.parse(input.expectedSourceProductId);
    const expiresInSeconds = input.expiresInSeconds ?? 900;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3_600) {
      throw new DomainError("VALIDATION_FAILED", "Product move preview expiry must be from 60 to 3600 seconds.", 422);
    }
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `design:${designId}:move-product-preview`, key, input, () => {
      const design = this.database.sqlite.prepare(
        `SELECT design.id, design.product_id, design.current_version, design.organization_id
         FROM designs design
         WHERE design.id = ? AND design.organization_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM system_metadata archive
             WHERE archive.key = 'design_archive:' || design.id
           )`,
      ).get(designId, access.organizationId) as {
        id: string;
        product_id: string;
        current_version: number;
        organization_id: string;
      } | undefined;
      if (!design) throw new DomainError("NOT_FOUND", "Design not found.", 404);
      if (design.product_id !== input.expectedSourceProductId || design.current_version !== input.expectedDesignVersion) {
        throw new DomainError("VERSION_CONFLICT", "The design Product or immutable head changed before the move.", 409, {
          retryable: true,
          details: {
            expectedSourceProductId: input.expectedSourceProductId,
            currentSourceProductId: design.product_id,
            expectedDesignVersion: input.expectedDesignVersion,
            currentDesignVersion: design.current_version,
          },
        });
      }
      if (design.product_id === target.id) {
        throw new DomainError("VALIDATION_FAILED", "The design already belongs to the target Product.", 422);
      }
      const source = this.requireProduct(access, design.product_id);
      const nowDate = this.now();
      const now = nowDate.toISOString();
      const previewId = `product_move_${randomUUID().replaceAll("-", "")}`;
      this.database.sqlite.prepare(
        `INSERT INTO product_move_previews
         (id, organization_id, design_id, source_product_id, target_product_id,
          expected_design_version, status, created_by, created_at, expires_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, NULL)`,
      ).run(
        previewId,
        access.organizationId,
        design.id,
        source.id,
        target.id,
        design.current_version,
        access.principalId,
        now,
        new Date(nowDate.getTime() + expiresInSeconds * 1_000).toISOString(),
      );
      appendAuditEvent(this.database.sqlite, access, "product_move.preview", "product_move_preview", previewId, {
        designId: design.id,
        sourceProductId: source.id,
        targetProductId: target.id,
        designVersion: design.current_version,
      });
      return this.productMovePreview(access, previewId);
    });
  }

  readDesignMovePreview(actorId: string, previewId: string): ProductMovePreviewResult {
    const access = this.readAccess(actorId);
    return this.productMovePreview(access, previewId);
  }

  commitDesignMovePreview(actorId: string, previewId: string, input: {
    idempotencyKey: string;
  }): { preview: ProductMovePreviewResult; product: ProductDetail } {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertProductManager(access);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `product-move-preview:${previewId}:commit`, key, input, () => {
      const preview = this.database.sqlite.prepare(
        `SELECT * FROM product_move_previews
         WHERE id = ? AND organization_id = ?`,
      ).get(previewId, access.organizationId) as {
        id: string;
        organization_id: string;
        design_id: string;
        source_product_id: string;
        target_product_id: string;
        expected_design_version: number;
        status: "ready" | "expired" | "committed";
        created_by: string;
        created_at: string;
        expires_at: string;
        committed_at: string | null;
      } | undefined;
      if (!preview) throw new DomainError("NOT_FOUND", "Product move preview not found.", 404);
      if (preview.status === "committed") {
        throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The Product move preview was already committed.", 409);
      }
      const now = this.now().toISOString();
      if (preview.status === "expired" || preview.expires_at <= now) {
        if (preview.status === "ready") {
          this.database.sqlite.prepare(
            "UPDATE product_move_previews SET status = 'expired' WHERE id = ? AND status = 'ready'",
          ).run(preview.id);
        }
        throw new DomainError("PREVIEW_EXPIRED", "The Product move preview expired; create a new preview.", 410, {
          retryable: true,
        });
      }
      const target = this.requireProduct(access, preview.target_product_id);
      const product = this.executeDesignMove(access, target, preview.design_id, {
        expectedSourceProductId: preview.source_product_id,
        expectedDesignVersion: preview.expected_design_version,
      });
      const updated = this.database.sqlite.prepare(
        `UPDATE product_move_previews
         SET status = 'committed', committed_at = ?
         WHERE id = ? AND status = 'ready'`,
      ).run(now, preview.id);
      if (updated.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "The Product move preview changed before commit.", 409, { retryable: true });
      }
      appendAuditEvent(this.database.sqlite, access, "product_move.commit", "product_move_preview", preview.id, {
        designId: preview.design_id,
        sourceProductId: preview.source_product_id,
        targetProductId: preview.target_product_id,
        designVersion: preview.expected_design_version,
      });
      return { preview: this.productMovePreview(access, preview.id), product };
    });
  }

  private executeDesignMove(
    access: AccessContext,
    target: ProductRow,
    designId: string,
    input: { expectedSourceProductId: string; expectedDesignVersion: number },
  ): ProductDetail {
    const design = this.database.sqlite.prepare(
      `SELECT design.id, design.product_id, design.current_version, design.organization_id
       FROM designs design
       WHERE design.id = ? AND design.organization_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM system_metadata archive
           WHERE archive.key = 'design_archive:' || design.id
         )`,
    ).get(designId, access.organizationId) as {
      id: string;
      product_id: string;
      current_version: number;
      organization_id: string;
    } | undefined;
    if (!design) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    if (design.product_id !== input.expectedSourceProductId || design.current_version !== input.expectedDesignVersion) {
      throw new DomainError("VERSION_CONFLICT", "The design Product or immutable head changed before the move.", 409, {
        retryable: true,
        details: {
          expectedSourceProductId: input.expectedSourceProductId,
          currentSourceProductId: design.product_id,
          expectedDesignVersion: input.expectedDesignVersion,
          currentDesignVersion: design.current_version,
        },
      });
    }
    const source = this.requireProduct(access, design.product_id);
    const now = this.now().toISOString();
    if (source.canonical_specification_design_id === design.id) {
      const replacement = this.database.sqlite.prepare(
        `SELECT id FROM designs design
         WHERE design.product_id = ? AND design.id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM system_metadata archive
             WHERE archive.key = 'design_archive:' || design.id
           )
         ORDER BY design.updated_at DESC, design.id DESC LIMIT 1`,
      ).get(source.id, design.id) as { id: string } | undefined;
      this.database.sqlite.prepare(
        "UPDATE products SET canonical_specification_design_id = ?, updated_at = ? WHERE id = ?",
      ).run(replacement?.id ?? null, now, source.id);
    } else {
      this.database.sqlite.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(now, source.id);
    }
    const updated = this.database.sqlite.prepare(
      `UPDATE designs SET product_id = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND product_id = ? AND current_version = ?`,
    ).run(target.id, now, design.id, access.organizationId, source.id, input.expectedDesignVersion);
    if (updated.changes !== 1) {
      throw new DomainError("VERSION_CONFLICT", "The design changed before its Product move committed.", 409, { retryable: true });
    }
    if (target.canonical_specification_design_id === null) {
      this.database.sqlite.prepare(
        "UPDATE products SET canonical_specification_design_id = ?, updated_at = ? WHERE id = ?",
      ).run(design.id, now, target.id);
    } else {
      this.database.sqlite.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(now, target.id);
    }
    appendAuditEvent(this.database.sqlite, access, "design.move_product", "design", design.id, {
      sourceProductId: source.id,
      targetProductId: target.id,
      designVersion: design.current_version,
    });
    return this.detail(access, this.requireProduct(access, target.id));
  }

  private productMovePreview(access: AccessContext, previewId: string): ProductMovePreviewResult {
    const row = this.database.sqlite.prepare(
      `SELECT preview.id, preview.design_id, preview.source_product_id, preview.target_product_id,
              preview.expected_design_version, preview.status, preview.created_at, preview.expires_at,
              preview.committed_at, source.name AS source_name, target.name AS target_name
       FROM product_move_previews preview
       JOIN products source ON source.id = preview.source_product_id
       JOIN products target ON target.id = preview.target_product_id
       WHERE preview.id = ? AND preview.organization_id = ?`,
    ).get(previewId, access.organizationId) as {
      id: string;
      design_id: string;
      source_product_id: string;
      target_product_id: string;
      expected_design_version: number;
      status: "ready" | "expired" | "committed";
      created_at: string;
      expires_at: string;
      committed_at: string | null;
      source_name: string;
      target_name: string;
    } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Product move preview not found.", 404);
    if (access.projectIds.length > 0 && !access.projectIds.includes(row.design_id)) {
      throw new DomainError("NOT_FOUND", "Product move preview not found.", 404);
    }
    const now = this.now().toISOString();
    if (row.status === "ready" && row.expires_at <= now) {
      this.database.sqlite.prepare(
        "UPDATE product_move_previews SET status = 'expired' WHERE id = ? AND status = 'ready'",
      ).run(row.id);
      row.status = "expired";
    }
    return {
      id: row.id,
      designId: row.design_id,
      sourceProduct: { id: row.source_product_id, name: row.source_name },
      targetProduct: { id: row.target_product_id, name: row.target_name },
      expectedDesignVersion: row.expected_design_version,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      committedAt: row.committed_at,
    };
  }

  private readAccess(actorId: string): AccessContext {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
    return access;
  }

  private requireProduct(access: AccessContext, productId: string, includeArchived = false): ProductRow {
    const parsedId = ProductIdSchema.safeParse(productId);
    if (!parsedId.success) throw new DomainError("NOT_FOUND", "Product not found.", 404);
    const conditions = ["product.id = ?", "product.organization_id = ?"];
    const parameters: string[] = [productId, access.organizationId];
    if (!includeArchived) conditions.push("product.status = 'active'");
    if (access.projectIds.length > 0) {
      conditions.push(`EXISTS (
        SELECT 1 FROM designs visible_design
        WHERE visible_design.product_id = product.id
          AND visible_design.id IN (${access.projectIds.map(() => "?").join(", ")})
          AND NOT EXISTS (
            SELECT 1 FROM system_metadata archive
            WHERE archive.key = 'design_archive:' || visible_design.id
          )
      )`);
      parameters.push(...access.projectIds);
    }
    const row = this.database.sqlite.prepare(
      `SELECT product.* FROM products product WHERE ${conditions.join(" AND ")}`,
    ).get(...parameters) as ProductRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Product not found.", 404);
    return row;
  }

  private requireDesignInProduct(access: AccessContext, productId: string, designId: string): void {
    const row = this.database.sqlite.prepare(
      `SELECT id FROM designs design
       WHERE design.id = ? AND design.product_id = ? AND design.organization_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM system_metadata archive
           WHERE archive.key = 'design_archive:' || design.id
         )`,
    ).get(designId, productId, access.organizationId);
    if (!row) throw new DomainError("NOT_FOUND", "Design not found in Product.", 404);
  }

  private detail(access: AccessContext, row: ProductRow): ProductDetail {
    const filters = [
      "design.product_id = ?",
      `NOT EXISTS (
        SELECT 1 FROM system_metadata archive
        WHERE archive.key = 'design_archive:' || design.id
      )`,
    ];
    const parameters: string[] = [row.id];
    if (access.projectIds.length > 0) {
      filters.push(`design.id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    const designs = this.database.sqlite.prepare(
      `SELECT design.id, design.name, design.current_version, design.current_revision_id,
              design.created_at, design.updated_at
       FROM designs design WHERE ${filters.join(" AND ")}
       ORDER BY design.updated_at DESC, design.id DESC`,
    ).all(...parameters) as ProductDesignRow[];
    const visibleDesignIds = new Set(designs.map((design) => design.id));
    const canonicalSpecification = row.canonical_specification_design_id === null
      || !visibleDesignIds.has(row.canonical_specification_design_id)
      ? null
      : this.database.sqlite.prepare(
        `SELECT design_id, version, specification_hash
         FROM product_specifications
         WHERE design_id = ? ORDER BY version DESC LIMIT 1`,
      ).get(row.canonical_specification_design_id) as {
        design_id: string;
        version: number;
        specification_hash: string;
      } | undefined;
    const repositoryInventories = designs.length === 0
      ? []
      : this.database.sqlite.prepare(
        `SELECT DISTINCT inventory.id, inventory.inventory_hash, inventory.status
         FROM implementation_mappings mapping
         JOIN repository_inventories inventory ON inventory.id = mapping.inventory_id
         WHERE mapping.design_id IN (${designs.map(() => "?").join(", ")})
         ORDER BY inventory.created_at DESC, inventory.id DESC LIMIT 100`,
      ).all(...designs.map((design) => design.id)) as Array<{
        id: string;
        inventory_hash: string;
        status: string;
      }>;
    return {
      product: {
        ...this.summary(row, designs.length),
        metadata: parseJsonObject(row.metadata_json, "Product metadata"),
      },
      designs: designs.map((design) => ({
        id: design.id,
        name: design.name,
        version: design.current_version,
        revisionId: design.current_revision_id,
        createdAt: design.created_at,
        updatedAt: design.updated_at,
      })),
      canonicalSpecification: canonicalSpecification === undefined || canonicalSpecification === null
        ? null
        : {
          designId: canonicalSpecification.design_id,
          version: canonicalSpecification.version,
          specificationHash: canonicalSpecification.specification_hash,
        },
      repositoryInventories: repositoryInventories.map((inventory) => ({
        id: inventory.id,
        inventoryHash: inventory.inventory_hash,
        status: inventory.status,
      })),
    };
  }

  private summary(row: ProductRow, designCount: number): ProductSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      ownerPrincipalId: row.owner_principal_id,
      defaultDesignSystemReleaseId: row.default_design_system_release_id,
      defaultLocale: ProductLocaleSchema.parse(row.default_locale),
      defaultDirection: ProductDirectionSchema.parse(row.default_direction),
      locales: parseLocales(row.locales_json),
      canonicalSpecificationDesignId: row.canonical_specification_design_id,
      designCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  private assertRelease(access: AccessContext, releaseId: string | null): void {
    if (releaseId === null || releaseId === FORMASPEC_FOUNDATION_RELEASE_ID) return;
    const release = this.database.sqlite.prepare(
      `SELECT release.id FROM design_system_releases release
       JOIN design_systems system ON system.id = release.design_system_id
       WHERE release.id = ? AND release.status = 'published'
         AND system.organization_id = ? AND system.status = 'active'`,
    ).get(releaseId, access.organizationId);
    if (!release) throw new DomainError("NOT_FOUND", "Published design-system release not found.", 404);
  }

  private accessHash(access: AccessContext): string {
    return hashPayload({
      organizationId: access.organizationId,
      principalId: access.principalId,
      role: access.role,
      scopes: [...new Set(access.scopes)].sort(),
      projectIds: [...new Set(access.projectIds)].sort(),
    });
  }

  private cursor(row: ProductRow, accessHash: string, includeArchived: boolean): string {
    const core = {
      schemaVersion: 1 as const,
      accessHash,
      updatedAt: row.updated_at,
      id: row.id,
      includeArchived,
    };
    return `${PRODUCT_CURSOR_PREFIX}${Buffer.from(canonicalJson({
      ...core,
      checksum: hashPayload(core),
    }), "utf8").toString("base64url")}`;
  }

  private parseCursor(cursor: string, accessHash: string, includeArchived: boolean): ProductCursorPayload {
    if (!cursor.startsWith(PRODUCT_CURSOR_PREFIX)) {
      throw new DomainError("VALIDATION_FAILED", "Product list cursor is malformed.", 422);
    }
    try {
      const encoded = cursor.slice(PRODUCT_CURSOR_PREFIX.length);
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.length === 0 || bytes.length > 2_048 || bytes.toString("base64url") !== encoded) throw new Error("encoding");
      const payload = JSON.parse(bytes.toString("utf8")) as ProductCursorPayload;
      const core = {
        schemaVersion: payload.schemaVersion,
        accessHash: payload.accessHash,
        updatedAt: payload.updatedAt,
        id: payload.id,
        includeArchived: payload.includeArchived,
      };
      if (payload.schemaVersion !== 1
        || payload.accessHash !== accessHash
        || payload.includeArchived !== includeArchived
        || !ProductIdSchema.safeParse(payload.id).success
        || !Number.isFinite(Date.parse(payload.updatedAt))
        || payload.checksum !== hashPayload(core)) {
        throw new Error("payload");
      }
      return payload;
    } catch (error) {
      throw new DomainError("VERSION_CONFLICT", "Product list cursor is invalid or stale; restart pagination.", 409, {
        details: { reason: "cursor_invalid" },
        cause: error,
      });
    }
  }

  private versionConflict(expectedUpdatedAt: string, currentUpdatedAt: string): DomainError {
    return new DomainError("VERSION_CONFLICT", "The Product changed before this operation committed.", 409, {
      retryable: true,
      details: { expectedUpdatedAt, currentUpdatedAt },
    });
  }

  private withIdempotency<T>(
    access: AccessContext,
    scope: string,
    key: string,
    request: unknown,
    execute: () => T,
  ): T {
    const transaction = this.database.sqlite.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      this.database.sqlite.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(nowIso);
      const requestHash = hashPayload(request);
      const existing = this.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, scope, key, nowIso) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.", 409);
        }
        return JSON.parse(existing.response_json) as T;
      }
      const result = execute();
      this.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        access.principalId,
        scope,
        key,
        requestHash,
        JSON.stringify(result),
        nowIso,
        new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      );
      return result;
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  private enqueueEvent(
    access: AccessContext,
    type: DesignerEventType,
    data: Record<string, unknown>,
    now: string,
  ): number {
    const inserted = this.database.sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(access.organizationId, access.actorId, type, JSON.stringify(data), now);
    return Number(inserted.lastInsertRowid);
  }

  private flushPendingEventsSafely(): void {
    if (!this.events) return;
    try {
      flushPersistedEventOutbox(this.database.sqlite, this.events);
    } catch {
      // Product writes stay committed; the durable outbox can resume on a later request.
    }
  }
}

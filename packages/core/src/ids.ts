import { z } from "zod";

const idSuffixPattern = "[A-Za-z0-9][A-Za-z0-9_-]{7,}";

export const DocumentIdSchema = z
  .string()
  .regex(new RegExp(`^document_${idSuffixPattern}$`), "Invalid document id")
  .brand<"DocumentId">();
export const ProductIdSchema = z
  .string()
  .regex(new RegExp(`^product_${idSuffixPattern}$`), "Invalid product id")
  .brand<"ProductId">();
export const PageIdSchema = z
  .string()
  .regex(new RegExp(`^page_${idSuffixPattern}$`), "Invalid page id")
  .brand<"PageId">();
export const NodeIdSchema = z
  .string()
  .regex(new RegExp(`^node_${idSuffixPattern}$`), "Invalid node id")
  .brand<"NodeId">();
export const TokenIdSchema = z
  .string()
  .regex(new RegExp(`^token_${idSuffixPattern}$`), "Invalid token id")
  .brand<"TokenId">();
export const AssetIdSchema = z
  .string()
  .regex(new RegExp(`^asset_${idSuffixPattern}$`), "Invalid asset id")
  .brand<"AssetId">();
export const PrototypeLinkIdSchema = z
  .string()
  .regex(new RegExp(`^link_${idSuffixPattern}$`), "Invalid prototype link id")
  .brand<"PrototypeLinkId">();
export const OperationIdSchema = z
  .string()
  .regex(new RegExp(`^operation_${idSuffixPattern}$`), "Invalid operation id")
  .brand<"OperationId">();

export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type ProductId = z.infer<typeof ProductIdSchema>;
export type PageId = z.infer<typeof PageIdSchema>;
export type NodeId = z.infer<typeof NodeIdSchema>;
export type TokenId = z.infer<typeof TokenIdSchema>;
export type AssetId = z.infer<typeof AssetIdSchema>;
export type PrototypeLinkId = z.infer<typeof PrototypeLinkIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;

export type IdKind =
  | "product"
  | "document"
  | "page"
  | "node"
  | "token"
  | "asset"
  | "link"
  | "operation";

export interface IdByKind {
  product: ProductId;
  document: DocumentId;
  page: PageId;
  node: NodeId;
  token: TokenId;
  asset: AssetId;
  link: PrototypeLinkId;
  operation: OperationId;
}

export type IdFactory = <K extends IdKind>(kind: K) => IdByKind[K];

function randomSuffix(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export const createId: IdFactory = <K extends IdKind>(kind: K): IdByKind[K] =>
  `${kind}_${randomSuffix()}` as IdByKind[K];

export function createSequentialIdFactory(namespace = "fixture"): IdFactory {
  const safeNamespace = namespace.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(8, "_");
  let sequence = 0;

  return <K extends IdKind>(kind: K): IdByKind[K] => {
    sequence += 1;
    return `${kind}_${safeNamespace}_${String(sequence).padStart(6, "0")}` as IdByKind[K];
  };
}

export const createDocumentId = (): DocumentId => createId("document");
export const createProductId = (): ProductId => createId("product");
export const createPageId = (): PageId => createId("page");
export const createNodeId = (): NodeId => createId("node");
export const createTokenId = (): TokenId => createId("token");
export const createAssetId = (): AssetId => createId("asset");
export const createPrototypeLinkId = (): PrototypeLinkId => createId("link");
export const createOperationId = (): OperationId => createId("operation");

export const asDocumentId = (value: string): DocumentId => DocumentIdSchema.parse(value);
export const asProductId = (value: string): ProductId => ProductIdSchema.parse(value);
export const asPageId = (value: string): PageId => PageIdSchema.parse(value);
export const asNodeId = (value: string): NodeId => NodeIdSchema.parse(value);
export const asTokenId = (value: string): TokenId => TokenIdSchema.parse(value);
export const asAssetId = (value: string): AssetId => AssetIdSchema.parse(value);
export const asPrototypeLinkId = (value: string): PrototypeLinkId =>
  PrototypeLinkIdSchema.parse(value);
export const asOperationId = (value: string): OperationId => OperationIdSchema.parse(value);

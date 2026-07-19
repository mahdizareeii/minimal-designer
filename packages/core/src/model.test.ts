import { describe, expect, it } from "vitest";

import {
  DesignDocumentSchema,
  DesignTokenSchema,
  SCHEMA_VERSION,
  createDesignDocument,
  createSampleDocument,
  createSequentialIdFactory,
  createStarterDocument,
  validateDesignDocument,
} from "./index.js";

describe("schema version 1 document model", () => {
  it("creates an empty, strictly valid document", () => {
    const document = createDesignDocument({
      name: "Core fixture",
      now: "2026-07-19T10:00:00.000Z",
      idFactory: createSequentialIdFactory("emptydoc"),
    });

    expect(document.schema_version).toBe(SCHEMA_VERSION);
    expect(document.pages).toEqual([]);
    expect(document.nodes).toEqual({});
    expect(validateDesignDocument(document).success).toBe(true);
  });

  it("rejects unknown fields at every strict boundary", () => {
    const document = createDesignDocument({ idFactory: createSequentialIdFactory("strictdoc") });
    expect(DesignDocumentSchema.safeParse({ ...document, unexpected: true }).success).toBe(false);

    const sample = createSampleDocument({ idFactory: createSequentialIdFactory("strictnode") });
    const node = Object.values(sample.nodes)[0];
    expect(node).toBeDefined();
    expect(
      DesignDocumentSchema.safeParse({
        ...sample,
        nodes: { ...sample.nodes, [node!.id]: { ...node, unexpected: true } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["web", 1440, 900],
    ["phone", 390, 844],
    ["tablet", 834, 1194],
  ] as const)("creates a %s starter with one screen frame", (preset, width, height) => {
    const document = createStarterDocument({ preset, idFactory: createSequentialIdFactory(preset) });
    const page = document.pages[0];
    const frame = page === undefined ? undefined : document.nodes[page.children[0]!];

    expect(page?.children).toHaveLength(1);
    expect(frame?.type).toBe("frame");
    expect(frame?.layout.width).toBe(width);
    expect(frame?.layout.height).toBe(height);
    expect(validateDesignDocument(document).success).toBe(true);
  });

  it("creates a non-trivial valid sample document", () => {
    const document = createSampleDocument({ idFactory: createSequentialIdFactory("sampledoc") });
    const validation = validateDesignDocument(document);

    expect(validation.success).toBe(true);
    expect(document.pages).toHaveLength(1);
    expect(Object.keys(document.nodes).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(document.tokens)).toHaveLength(2);
  });

  it("enforces token value types by token kind", () => {
    const ids = createSequentialIdFactory("tokenkind");
    const base = { id: ids("token"), name: "Spacing", path: "space.md", archived: false, metadata: {} };
    expect(DesignTokenSchema.safeParse({ ...base, kind: "dimension", value: 16 }).success).toBe(true);
    expect(DesignTokenSchema.safeParse({ ...base, kind: "dimension", value: "16px" }).success).toBe(false);
    expect(DesignTokenSchema.safeParse({ ...base, kind: "color", value: 16 }).success).toBe(false);
  });
});

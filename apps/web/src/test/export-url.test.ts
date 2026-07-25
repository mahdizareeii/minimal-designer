import { describe, expect, it } from "vitest";

import { exportUrl } from "../lib/api";

describe("design export URLs", () => {
  it("preserves the legacy version-only JSON URL", () => {
    expect(exportUrl("document_example", 7)).toBe("/api/designs/document_example/export?version=7");
  });

  it("encodes a selected-frame deterministic SVG export", () => {
    expect(exportUrl("document/example", {
      version: 12,
      format: "svg",
      nodeId: "node frame",
      maxSize: 4096,
    })).toBe("/api/designs/document%2Fexample/export?version=12&format=svg&nodeId=node+frame&maxSize=4096");
  });

  it("encodes a page-scoped deterministic PDF export", () => {
    expect(exportUrl("document_example", {
      version: 3,
      format: "pdf",
      pageId: "page_rtl",
      maxSize: 2048,
    })).toBe("/api/designs/document_example/export?version=3&format=pdf&pageId=page_rtl&maxSize=2048");
  });
});

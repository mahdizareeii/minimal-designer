import {
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import { PngRenderer } from "./render.js";
import { RendererIpcDocumentSchema } from "./renderer-ipc.js";

describe("V2 renderer compatibility", () => {
  it("accepts strict V2 documents at the IPC boundary and renders their compatibility projection", async () => {
    const source = createStarterDocument({
      preset: "phone",
      now: "2026-01-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("v2renderer"),
    });
    const document = migrateDesignDocumentV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    expect(RendererIpcDocumentSchema.parse(document).schema_version).toBe(2);

    const renderer = new PngRenderer({ allowSoftwareFallback: true, timeoutMs: 2_000 });
    try {
      const rendered = await renderer.render(document, { maxSize: 512 }, () => null);
      expect(rendered.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(rendered.width).toBeGreaterThan(0);
      expect(rendered.height).toBeGreaterThan(0);
    } finally {
      await renderer.close();
    }
  });
});


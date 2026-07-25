import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeRendererPngForExport,
  deterministicPdfExport,
  deterministicSvgExport,
} from "./deterministic-document-export.js";
import { encodeRgbaPng } from "./render.js";

describe("sanitized deterministic document exports", () => {
  it("decodes the pinned renderer PNG and flattens alpha deterministically", () => {
    const png = encodeRgbaPng(2, 1, Buffer.from([
      255, 0, 0, 255,
      0, 0, 255, 0,
    ]));
    const decoded = decodeRendererPngForExport(png);
    expect(decoded).toMatchObject({ width: 2, height: 1 });
    expect([...decoded.rgb]).toEqual([255, 0, 0, 255, 255, 255]);
  });

  it("wraps only verified PNG bytes in a script-free deterministic SVG", () => {
    const png = encodeRgbaPng(3, 2, Buffer.alloc(3 * 2 * 4, 180));
    const first = deterministicSvgExport(png, 3, 2);
    const second = deterministicSvgExport(png, 3, 2);
    expect(first.equals(second)).toBe(true);
    expect(first.toString("utf8")).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2" viewBox="0 0 3 2"><image width="3" height="2" href="data:image/png;base64,${png.toString("base64")}"/></svg>`,
    );
    expect(first.toString("utf8")).not.toMatch(/script|foreignObject|javascript:|onload=/iu);
  });

  it("emits byte-identical bounded PDFs with valid deterministic xref offsets", () => {
    const rgba = Buffer.alloc(4 * 3 * 4);
    for (let index = 0; index < rgba.length; index += 4) {
      rgba[index] = 24;
      rgba[index + 1] = 87;
      rgba[index + 2] = 230;
      rgba[index + 3] = 255;
    }
    const png = encodeRgbaPng(4, 3, rgba);
    const first = deterministicPdfExport(png, 4, 3);
    const second = deterministicPdfExport(png, 4, 3);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    const pdf = first.toString("binary");
    expect(pdf).toContain("/Subtype /Image /Width 4 /Height 3");
    expect(pdf).toContain("/MediaBox [0 0 3 2.25]");
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    const xrefOffset = Number(pdf.match(/startxref\n(\d+)\n%%EOF/u)?.[1]);
    expect(first.subarray(xrefOffset, xrefOffset + 4).toString("ascii")).toBe("xref");
    const rows = pdf.slice(xrefOffset).split("\n").slice(2, 8);
    for (let id = 1; id <= 5; id += 1) {
      const offset = Number(rows[id]?.slice(0, 10));
      expect(first.subarray(offset, offset + 7).toString("ascii")).toBe(`${id} 0 obj`);
    }
    expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects tampered or dimension-mismatched renderer evidence", () => {
    const png = encodeRgbaPng(1, 1, Buffer.from([10, 20, 30, 255]));
    const tampered = Buffer.from(png);
    tampered[tampered.length - 5] ^= 0xff;
    expect(() => deterministicSvgExport(tampered, 1, 1)).toThrow(/checksum|end marker/iu);
    expect(() => deterministicPdfExport(png, 2, 1)).toThrow(/dimensions do not match/iu);
  });
});

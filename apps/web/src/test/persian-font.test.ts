import { createSequentialIdFactory, createStarterDocument, createTextNode, createTokenId } from "@designer/core";
import { describe, expect, it, vi } from "vitest";

import { browserFontFamilyStack, styleForNode } from "../domain";

describe("Persian font rendering", () => {
  it("maps canonical bundled families to the browser variable fonts and prefers Vazirmatn for Persian", () => {
    const ids = createSequentialIdFactory("persianfont");
    const document = createStarterDocument({ idFactory: ids });
    const text = createTextNode({
      content: "Invoice شماره ۱۲۳",
      direction: "auto",
      style: { typography: { font_family: "Inter", font_size: 18 } },
    }, ids);
    document.nodes[text.id] = text;

    expect(styleForNode(document, text).fontFamily).toBe(
      '"Vazirmatn Variable", Vazirmatn, "Inter Variable", Inter, system-ui, sans-serif',
    );
  });

  it("uses the same Persian fallback when Inter is resolved through a design token", () => {
    const ids = createSequentialIdFactory("persiantoken");
    const document = createStarterDocument({ idFactory: ids });
    const fontTokenId = createTokenId();
    document.tokens[fontTokenId] = {
      id: fontTokenId,
      name: "Product font",
      path: "font.family.product",
      kind: "font_family",
      value: "Inter",
      archived: false,
      metadata: {},
    };
    const text = createTextNode({
      content: "Courier نسخه ۳",
      direction: "auto",
      style: { typography: { font_family: { token_id: fontTokenId }, font_size: 18 } },
    }, ids);
    document.nodes[text.id] = text;

    expect(styleForNode(document, text).fontFamily).toBe(
      '"Vazirmatn Variable", Vazirmatn, "Inter Variable", Inter, system-ui, sans-serif',
    );
  });

  it("aliases only exact bundled family tokens without corrupting custom family names", () => {
    expect(browserFontFamilyStack('Interstate, "Vazirmatn Pro", Inter, Vazirmatn')).toBe(
      'Interstate, "Vazirmatn Pro", "Inter Variable", Inter, "Vazirmatn Variable", Vazirmatn',
    );
  });

  it("maps bundled browser families independently of a Turkish host locale", () => {
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      return String(this).replaceAll("I", "ı").toLowerCase();
    });
    try {
      expect(browserFontFamilyStack("Inter, Vazirmatn")).toBe(
        '"Inter Variable", Inter, "Vazirmatn Variable", Vazirmatn',
      );
    } finally {
      localeLowerCase.mockRestore();
    }
  });
});

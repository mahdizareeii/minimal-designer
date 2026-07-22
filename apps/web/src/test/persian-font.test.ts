import { createSequentialIdFactory, createStarterDocument, createTextNode } from "@designer/core";
import { describe, expect, it } from "vitest";

import { styleForNode } from "../domain";

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
});

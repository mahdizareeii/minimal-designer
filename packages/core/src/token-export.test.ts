import { describe, expect, it } from "vitest";

import type { DesignSystemToken } from "./design-system.js";
import { exportDesignTokens } from "./token-export.js";

function token(input: Partial<DesignSystemToken> & Pick<DesignSystemToken, "id" | "path" | "family" | "value">): DesignSystemToken {
  return {
    name: input.path,
    layer: "primitive",
    deprecated: false,
    ...input,
  };
}

const tokens: Record<string, DesignSystemToken> = {
  token_colorblue600: token({ id: "token_colorblue600", path: "color.blue.600", family: "color", value: "#3366ff" }),
  token_spacing4: token({ id: "token_spacing4", path: "spacing.4", family: "spacing", value: 16 }),
  token_actionprimary: token({ id: "token_actionprimary", path: "action.primary.background", family: "color", layer: "semantic", value: { token_id: "token_colorblue600" } }),
};

describe("bounded token exporters", () => {
  it("exports deterministic safe CSS and resolves aliases", () => {
    const result = exportDesignTokens(tokens, "css");
    expect(result.filename).toBe("formaspec-tokens.css");
    expect(result.content).toContain("--action-primary-background: #3366ff;");
    expect(result.content).toContain("--spacing-4: 16px;");
    expect(result.exportedTokenIds).toHaveLength(3);
  });

  it("exports bounded platform value files without presenting an application", () => {
    expect(exportDesignTokens(tokens, "typescript").content).toContain("Values only; this is not application code");
    expect(exportDesignTokens(tokens, "android_xml").content).toContain('<dimen name="spacing_4">16dp</dimen>');
    expect(exportDesignTokens(tokens, "compose").content).toContain("object FormaSpecTokens");
    expect(exportDesignTokens(tokens, "swift").content).toContain("enum FormaSpecTokens");
    expect(exportDesignTokens(tokens, "flutter").content).toContain("abstract final class FormaSpecTokens");
  });

  it("rejects token cycles and configured count/output limits", () => {
    const cyclic: Record<string, DesignSystemToken> = {
      token_cycleone: token({ id: "token_cycleone", path: "cycle.one", family: "color", value: { token_id: "token_cycletwo" } }),
      token_cycletwo: token({ id: "token_cycletwo", path: "cycle.two", family: "color", value: { token_id: "token_cycleone" } }),
    };
    expect(() => exportDesignTokens(cyclic, "css")).toThrow(/Token cycle/);
    expect(() => exportDesignTokens(tokens, "css", { maximumTokens: 2 })).toThrow(/token limit/);
    expect(() => exportDesignTokens(tokens, "typescript", { maximumOutputBytes: 1_024 })).not.toThrow();
  });
});

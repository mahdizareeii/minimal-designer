import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORMASPEC_CODEX_ASSET_INVENTORY,
  FORMASPEC_CODEX_IDENTITY,
  MINIMAL_UI_CODEX_IDENTITY,
  inspectManagedCodexAssets,
} from "./codex-assets.js";

const temporaryDirectories: string[] = [];
const sourceAssets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli/assets");

function copiedAssets(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-codex-assets-"));
  temporaryDirectories.push(root);
  const assets = path.join(root, "assets");
  fs.cpSync(sourceAssets, assets, { recursive: true });
  return assets;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged FormaSpec Codex identity", () => {
  it("pins both managed skills, plugins, display names, versions, and mentions", () => {
    expect(inspectManagedCodexAssets(sourceAssets)).toEqual(FORMASPEC_CODEX_ASSET_INVENTORY);
    expect(FORMASPEC_CODEX_ASSET_INVENTORY.identities).toEqual([
      FORMASPEC_CODEX_IDENTITY,
      MINIMAL_UI_CODEX_IDENTITY,
    ]);
    expect(FORMASPEC_CODEX_IDENTITY.mention).toBe("[@FormaSpec](plugin://formaspec@formaspec)");
    expect(MINIMAL_UI_CODEX_IDENTITY.mention).toBe("[@Minimal UI](plugin://minimal-ui@formaspec)");
    expect(FORMASPEC_CODEX_ASSET_INVENTORY.pluginVersion).toBe("0.2.2");
    for (const skillName of ["formaspec", "minimal-ui"]) {
      const skill = fs.readFileSync(path.join(sourceAssets, "skills", skillName, "SKILL.md"), "utf8");
      expect(skill).toContain("Run ./designer doctor auto, start the runtime it identifies, then retry this request.");
      expect(skill).not.toContain("Start FormaSpec with ./designer start, then retry this request.");
    }
  });

  it("rejects missing primary or alias assets", () => {
    const missing = copiedAssets();
    fs.rmSync(path.join(missing, "skills/formaspec"), { recursive: true, force: true });
    expect(() => inspectManagedCodexAssets(missing)).toThrow(/Required managed FormaSpec Codex asset/u);

    const missingAlias = copiedAssets();
    fs.rmSync(path.join(missingAlias, "codex-marketplace/plugins/minimal-ui"), { recursive: true, force: true });
    expect(() => inspectManagedCodexAssets(missingAlias)).toThrow(/Required managed FormaSpec Codex asset/u);
  });

  it("rejects stale display names, versions, and marketplace plugin sources", () => {
    const staleDisplayName = copiedAssets();
    const pluginManifest = path.join(
      staleDisplayName,
      "codex-marketplace/plugins/formaspec/.codex-plugin/plugin.json",
    );
    const plugin = JSON.parse(fs.readFileSync(pluginManifest, "utf8")) as {
      interface: { displayName: string };
    };
    plugin.interface.displayName = "Minimal UI";
    fs.writeFileSync(pluginManifest, `${JSON.stringify(plugin, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleDisplayName)).toThrow(/display the managed agent as FormaSpec/u);

    const staleAliasDisplayName = copiedAssets();
    const aliasManifest = path.join(
      staleAliasDisplayName,
      "codex-marketplace/plugins/minimal-ui/.codex-plugin/plugin.json",
    );
    const aliasPlugin = JSON.parse(fs.readFileSync(aliasManifest, "utf8")) as {
      version: string;
      interface: { displayName: string };
    };
    aliasPlugin.interface.displayName = "FormaSpec";
    fs.writeFileSync(aliasManifest, `${JSON.stringify(aliasPlugin, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleAliasDisplayName)).toThrow(/display the managed agent as Minimal UI/u);

    const staleAliasVersion = copiedAssets();
    const staleAliasVersionManifest = path.join(
      staleAliasVersion,
      "codex-marketplace/plugins/minimal-ui/.codex-plugin/plugin.json",
    );
    const versionedAlias = JSON.parse(fs.readFileSync(staleAliasVersionManifest, "utf8")) as { version: string };
    versionedAlias.version = "0.1.0";
    fs.writeFileSync(staleAliasVersionManifest, `${JSON.stringify(versionedAlias, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleAliasVersion)).toThrow(/minimal-ui at 0\.2\.2/u);

    const divergentSkill = copiedAssets();
    fs.appendFileSync(path.join(divergentSkill, "skills/formaspec/SKILL.md"), "\nDivergent workflow.\n");
    expect(() => inspectManagedCodexAssets(divergentSkill)).toThrow(/standalone and plugin skills must be byte-identical/u);

    const staleSource = copiedAssets();
    const marketplaceManifest = path.join(staleSource, "codex-marketplace/.agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceManifest, "utf8")) as {
      plugins: Array<{ name: string; source: { path: string } }>;
    };
    marketplace.plugins.find((entry) => entry.name === "minimal-ui")!.source.path = "./plugins/formaspec";
    fs.writeFileSync(marketplaceManifest, `${JSON.stringify(marketplace, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleSource)).toThrow(/resolve the plugin from \.\/plugins\/minimal-ui/u);
  });
});

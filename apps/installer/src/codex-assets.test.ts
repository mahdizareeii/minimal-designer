import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORMASPEC_CODEX_IDENTITY,
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
  it("pins the managed skill, plugin, marketplace, display name, and mention", () => {
    expect(inspectManagedCodexAssets(sourceAssets)).toEqual(FORMASPEC_CODEX_IDENTITY);
    expect(FORMASPEC_CODEX_IDENTITY.mention).toBe("[@FormaSpec](plugin://formaspec@formaspec)");
  });

  it("rejects missing canonical assets and legacy managed directories", () => {
    const missing = copiedAssets();
    fs.rmSync(path.join(missing, "skills/formaspec"), { recursive: true, force: true });
    expect(() => inspectManagedCodexAssets(missing)).toThrow(/Required managed FormaSpec Codex asset/u);

    const legacy = copiedAssets();
    fs.mkdirSync(path.join(legacy, "codex-marketplace/plugins/minimal-ui"), { recursive: true });
    expect(() => inspectManagedCodexAssets(legacy)).toThrow(/legacy managed path/u);
  });

  it("rejects stale generated display names and marketplace plugin sources", () => {
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

    const staleSource = copiedAssets();
    const marketplaceManifest = path.join(staleSource, "codex-marketplace/.agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceManifest, "utf8")) as {
      plugins: Array<{ source: { path: string } }>;
    };
    marketplace.plugins[0]!.source.path = "./plugins/minimal-ui";
    fs.writeFileSync(marketplaceManifest, `${JSON.stringify(marketplace, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleSource)).toThrow(/resolve the plugin from \.\/plugins\/formaspec/u);
  });
});

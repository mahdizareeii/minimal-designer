import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORMASPEC_CODEX_ASSET_INVENTORY,
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
  it("pins one plugin-contained managed skill, display name, version, and mention", () => {
    expect(inspectManagedCodexAssets(sourceAssets)).toEqual(FORMASPEC_CODEX_ASSET_INVENTORY);
    expect(FORMASPEC_CODEX_ASSET_INVENTORY.identities).toEqual([FORMASPEC_CODEX_IDENTITY]);
    expect(FORMASPEC_CODEX_IDENTITY.mention).toBe("[@FormaSpec](plugin://formaspec@formaspec)");
    expect(FORMASPEC_CODEX_ASSET_INVENTORY.pluginVersion).toBe("0.4.0");
    const skill = fs.readFileSync(path.join(
      sourceAssets,
      "codex-marketplace/plugins/formaspec/skills/formaspec/SKILL.md",
    ), "utf8");
    expect(skill).toContain("`formaspecctl ensure-running --json` preflight exactly once");
    expect(skill).toContain("`./designer ensure-running --json` is the source-checkout compatibility form");
    expect(skill).not.toContain("Start FormaSpec with ./designer start, then retry this request.");
    expect(fs.existsSync(path.join(sourceAssets, "skills/formaspec/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(sourceAssets, "skills/minimal-ui/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(sourceAssets, "codex-marketplace/plugins/minimal-ui"))).toBe(false);
  });

  it("rejects a missing primary plugin or any packaged legacy duplicate identity", () => {
    const missing = copiedAssets();
    fs.rmSync(path.join(missing, "codex-marketplace/plugins/formaspec"), { recursive: true, force: true });
    expect(() => inspectManagedCodexAssets(missing)).toThrow(/Required managed FormaSpec Codex asset/u);

    const legacyAlias = copiedAssets();
    fs.mkdirSync(path.join(legacyAlias, "codex-marketplace/plugins/minimal-ui"), { recursive: true });
    fs.writeFileSync(path.join(legacyAlias, "codex-marketplace/plugins/minimal-ui/legacy.txt"), "legacy\n");
    expect(() => inspectManagedCodexAssets(legacyAlias)).toThrow(/Legacy duplicate FormaSpec Codex asset/u);

    const standaloneDuplicate = copiedAssets();
    fs.mkdirSync(path.join(standaloneDuplicate, "skills/formaspec"), { recursive: true });
    fs.writeFileSync(path.join(standaloneDuplicate, "skills/formaspec/SKILL.md"), "legacy\n");
    expect(() => inspectManagedCodexAssets(standaloneDuplicate)).toThrow(/Legacy duplicate FormaSpec Codex asset/u);
  });

  it("rejects stale display names, versions, extra identities, and marketplace plugin sources", () => {
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
    expect(() => inspectManagedCodexAssets(staleDisplayName)).toThrow(/must not advertise a retired agent identity/u);

    const staleVersion = copiedAssets();
    const staleVersionManifest = path.join(
      staleVersion,
      "codex-marketplace/plugins/formaspec/.codex-plugin/plugin.json",
    );
    const versionedPlugin = JSON.parse(fs.readFileSync(staleVersionManifest, "utf8")) as { version: string };
    versionedPlugin.version = "0.2.2";
    fs.writeFileSync(staleVersionManifest, `${JSON.stringify(versionedPlugin, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleVersion)).toThrow(/formaspec at 0\.4\.0/u);

    const extraIdentity = copiedAssets();
    const extraMarketplaceManifest = path.join(extraIdentity, "codex-marketplace/.agents/plugins/marketplace.json");
    const extraMarketplace = JSON.parse(fs.readFileSync(extraMarketplaceManifest, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    extraMarketplace.plugins.push({ name: "another-agent" });
    fs.writeFileSync(extraMarketplaceManifest, `${JSON.stringify(extraMarketplace, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(extraIdentity)).toThrow(/exactly one managed agent identity/u);

    const staleSource = copiedAssets();
    const marketplaceManifest = path.join(staleSource, "codex-marketplace/.agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceManifest, "utf8")) as {
      plugins: Array<{ name: string; source: { path: string } }>;
    };
    marketplace.plugins.find((entry) => entry.name === "formaspec")!.source.path = "./plugins/other-agent";
    fs.writeFileSync(marketplaceManifest, `${JSON.stringify(marketplace, null, 2)}\n`);
    expect(() => inspectManagedCodexAssets(staleSource)).toThrow(/resolve the plugin from \.\/plugins\/formaspec/u);

    const retiredTrigger = copiedAssets();
    const skillPath = path.join(
      retiredTrigger,
      "codex-marketplace/plugins/formaspec/skills/formaspec/SKILL.md",
    );
    fs.appendFileSync(skillPath, "\nUse Minimal UI.\n");
    expect(() => inspectManagedCodexAssets(retiredTrigger)).toThrow(/must not advertise a retired agent identity/u);
  });
});

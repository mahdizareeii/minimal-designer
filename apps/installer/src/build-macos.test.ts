import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertChromiumOnlyBrowserPayload,
  assertContainedSymlinks,
  assertNoAppleDoubleFiles,
  assertPinnedNodeLicense,
  assertPinnedNodeVersion,
  copyRelocatableNodeModules,
  copyTreePreservingSymlinks,
  filterAppleDoubleBomListing,
  headlessShellDirectoryFromBrowserManifest,
  isAppleDoubleArchivePath,
  removeMacMetadataFiles,
  selectPackagedBrowserDirectories,
  updatePackageInfoPayloadCount,
} from "./build-macos.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-installer-links-"));
  temporaryDirectories.push(root);
  return root;
}

describe("macOS payload symlink containment", () => {
  it("allows relative links that remain inside the package payload", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps", "server", "node_modules", "@designer"), { recursive: true });
    fs.symlinkSync("../../../../packages/core", path.join(root, "apps", "server", "node_modules", "@designer", "core"));
    expect(() => assertContainedSymlinks(root)).not.toThrow();
  });

  it("rejects AppleDouble sidecars before package construction", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "._package.json"), "sidecar\n");
    expect(() => assertNoAppleDoubleFiles(root)).toThrow(/AppleDouble sidecar/);
  });

  it("rejects absolute and escaping links", () => {
    const root = temporaryRoot();
    fs.symlinkSync("/tmp/unmanaged", path.join(root, "absolute"));
    expect(() => assertContainedSymlinks(root)).toThrow(/absolute symlink/);
    fs.rmSync(path.join(root, "absolute"), { force: true });
    fs.mkdirSync(path.join(root, "nested"));
    fs.symlinkSync("../../outside", path.join(root, "nested", "escape"));
    expect(() => assertContainedSymlinks(root)).toThrow(/escapes its root/);
  });

  it("preserves relative links when copying framework-style directory trees", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    const destination = path.join(root, "payload", "framework");
    fs.mkdirSync(path.join(source, "Versions", "1.0"), { recursive: true });
    fs.writeFileSync(path.join(source, "Versions", "1.0", "binary"), "binary\n");
    fs.symlinkSync("1.0", path.join(source, "Versions", "Current"));
    fs.symlinkSync("Versions/Current/binary", path.join(source, "binary"));

    copyTreePreservingSymlinks(source, destination);

    expect(fs.readlinkSync(path.join(destination, "Versions", "Current"))).toBe("1.0");
    expect(fs.readlinkSync(path.join(destination, "binary"))).toBe("Versions/Current/binary");
    expect(() => assertContainedSymlinks(path.join(root, "payload"))).not.toThrow();
  });
});

describe("relocatable application node_modules copy", () => {
  function fixture(): { appRoot: string; workspace: string } {
    const root = temporaryRoot();
    const workspace = path.join(root, "source-workspace");
    const appRoot = path.join(root, "payload", "app");
    fs.mkdirSync(path.join(workspace, "node_modules", ".pnpm", "example@1.0.0", "node_modules", "example"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspace, "node_modules", ".pnpm", "example@1.0.0", "node_modules", "example", "index.js"),
      "export const example = true;\n",
    );
    return { appRoot, workspace };
  }

  it("preserves contained relative pnpm links, including links inside scopes", () => {
    const { appRoot, workspace } = fixture();
    const appModules = path.join(workspace, "apps", "server", "node_modules");
    fs.mkdirSync(path.join(appModules, "@scope"), { recursive: true });
    const target = "../../../../node_modules/.pnpm/example@1.0.0/node_modules/example";
    fs.symlinkSync(target, path.join(appModules, "@scope", "example"));

    copyRelocatableNodeModules(workspace, appRoot, "node_modules");
    copyRelocatableNodeModules(workspace, appRoot, "apps/server/node_modules");

    const packagedLink = path.join(appRoot, "apps", "server", "node_modules", "@scope", "example");
    expect(fs.readlinkSync(packagedLink)).toBe(target);
    expect(fs.readFileSync(path.join(packagedLink, "index.js"), "utf8")).toContain("example = true");
    expect(() => assertContainedSymlinks(appRoot)).not.toThrow();
  });

  it("rewrites absolute workspace links to relative packaged-app links", () => {
    const { appRoot, workspace } = fixture();
    const appModules = path.join(workspace, "apps", "cli", "node_modules", "@types");
    fs.mkdirSync(appModules, { recursive: true });
    const sourceTarget = path.join(workspace, "node_modules", ".pnpm", "example@1.0.0", "node_modules", "example");
    fs.symlinkSync(sourceTarget, path.join(appModules, "example"));

    copyRelocatableNodeModules(workspace, appRoot, "node_modules");
    copyRelocatableNodeModules(workspace, appRoot, "apps/cli/node_modules");

    const packagedLink = path.join(appRoot, "apps", "cli", "node_modules", "@types", "example");
    const packagedTarget = fs.readlinkSync(packagedLink);
    expect(path.isAbsolute(packagedTarget)).toBe(false);
    expect(fs.realpathSync(packagedLink)).toBe(fs.realpathSync(
      path.join(appRoot, "node_modules", ".pnpm", "example@1.0.0", "node_modules", "example"),
    ));
  });

  it("omits generated package-manager and build metadata recursively", () => {
    const { appRoot, workspace } = fixture();
    const modules = path.join(workspace, "node_modules");
    for (const relative of [
      ".bin/tool",
      ".cache/state",
      ".modules.yaml",
      ".package-map.json",
      ".pnpm-workspace-state-v1.json",
      ".pnpm/example@1.0.0/node_modules/example/.vite/cache",
      ".turbo/state",
    ]) {
      const filename = path.join(modules, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "generated\n");
    }

    copyRelocatableNodeModules(workspace, appRoot, "node_modules");

    for (const relative of [
      ".bin",
      ".cache",
      ".modules.yaml",
      ".package-map.json",
      ".pnpm-workspace-state-v1.json",
      ".pnpm/example@1.0.0/node_modules/example/.vite",
      ".turbo",
    ]) expect(fs.existsSync(path.join(appRoot, "node_modules", relative))).toBe(false);
  });

  it("rejects symlinks whose targets escape the source workspace", () => {
    const { appRoot, workspace } = fixture();
    const appModules = path.join(workspace, "apps", "cli", "node_modules");
    fs.mkdirSync(appModules, { recursive: true });
    fs.symlinkSync(path.dirname(workspace), path.join(appModules, "external-absolute"));
    expect(() => copyRelocatableNodeModules(workspace, appRoot, "apps/cli/node_modules"))
      .toThrow(/escapes the workspace/);

    fs.rmSync(path.join(appModules, "external-absolute"));
    fs.symlinkSync("../../../../outside", path.join(appModules, "external-relative"));
    expect(() => copyRelocatableNodeModules(workspace, appRoot, "apps/cli/node_modules"))
      .toThrow(/escapes the workspace/);
  });

  it("rejects dependency roots outside node_modules or outside the workspace", () => {
    const { appRoot, workspace } = fixture();
    expect(() => copyRelocatableNodeModules(workspace, appRoot, "apps/server/dist"))
      .toThrow(/workspace-relative node_modules/);
    expect(() => copyRelocatableNodeModules(workspace, appRoot, "../node_modules"))
      .toThrow(/escapes its root/);
  });
});

describe("packaged Playwright browser policy", () => {
  it("selects only the exact pinned Chromium headless shell", () => {
    const root = temporaryRoot();
    for (const name of [
      ".links",
      "chromium-1228",
      "chromium_headless_shell-1228",
      "ffmpeg-1011",
      "firefox-1500",
      "webkit-2200",
    ]) fs.mkdirSync(path.join(root, name), { recursive: true });

    expect(selectPackagedBrowserDirectories(root, "chromium_headless_shell-1228"))
      .toEqual(["chromium_headless_shell-1228"]);
  });

  it("derives the pinned directory from Playwright's browser manifest", () => {
    expect(headlessShellDirectoryFromBrowserManifest({
      browsers: [
        { name: "chromium", revision: "1228" },
        { name: "chromium-headless-shell", revision: "1228" },
      ],
    })).toBe("chromium_headless_shell-1228");
    expect(() => headlessShellDirectoryFromBrowserManifest({ browsers: [] })).toThrow(/revision is unavailable/);
  });

  it("requires the exact pinned headless-shell revision", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "chromium_headless_shell-1200"));
    expect(() => selectPackagedBrowserDirectories(root, "chromium_headless_shell-1228"))
      .toThrow(/headless-shell payload is unavailable/);
  });

  it("rejects FFmpeg, other browsers, and LGPL-named artifacts", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "chromium_headless_shell-1228"));
    expect(() => assertChromiumOnlyBrowserPayload(root)).not.toThrow();

    fs.writeFileSync(path.join(root, "chromium_headless_shell-1228", "COPYING.LGPLv2.1"), "license\n");
    expect(() => assertChromiumOnlyBrowserPayload(root)).toThrow(/disallowed artifact/);
    fs.rmSync(path.join(root, "chromium_headless_shell-1228", "COPYING.LGPLv2.1"));
    fs.mkdirSync(path.join(root, "ffmpeg-1011"));
    expect(() => assertChromiumOnlyBrowserPayload(root)).toThrow(/non-Chromium browser directory/);
  });
});

describe("pinned Node runtime evidence", () => {
  it("requires the exact runtime version", () => {
    expect(() => assertPinnedNodeVersion("v24.14.0\n")).not.toThrow();
    expect(() => assertPinnedNodeVersion("v24.14.1\n")).toThrow(/requires the pinned Node.js v24.14.0/);
  });

  it("verifies the exact official LICENSE bytes and provenance", () => {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/licenses");
    const license = fs.readFileSync(path.join(directory, "node-v24.14.0-LICENSE"));
    const provenance = JSON.parse(
      fs.readFileSync(path.join(directory, "node-v24.14.0-provenance.json"), "utf8"),
    ) as unknown;
    expect(() => assertPinnedNodeLicense(license, provenance)).not.toThrow();
    const corrupted = Buffer.from(license);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    expect(() => assertPinnedNodeLicense(corrupted, provenance)).toThrow(/integrity check/);
  });
});

describe("workspace packaging entry point", () => {
  it("builds the full workspace before constructing the macOS package", () => {
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    expect(rootPackage.scripts?.["package:macos:unsigned"]).toBe(
      "pnpm -r build && node apps/installer/dist/build-macos.js",
    );
  });
});

describe("AppleDouble-free component metadata", () => {
  it("recognizes AppleDouble segments without rejecting ordinary dot files", () => {
    expect(isAppleDoubleArchivePath("./Library/._LaunchAgents")).toBe(true);
    expect(isAppleDoubleArchivePath("./node_modules/pkg/._LICENSE")).toBe(true);
    expect(isAppleDoubleArchivePath("./node_modules/.pnpm/package.json")).toBe(false);
  });

  it("filters AppleDouble BOM records while preserving original ownership and checksums", () => {
    const result = filterAppleDoubleBomListing([
      ".\t40755\t0/0",
      "./._usr\t40755\t0/0\t0\t0",
      "./usr\t40755\t0/0",
      "./usr/bin/tool\t100755\t0/0\t12\t12345",
      "./usr/bin/._tool\t100755\t0/0\t0\t0",
      "",
    ].join("\n"));
    expect(result.numberOfFiles).toBe(3);
    expect(result.listing).toBe([
      ".\t40755\t0/0",
      "./usr\t40755\t0/0",
      "./usr/bin/tool\t100755\t0/0\t12\t12345",
      "",
    ].join("\n"));
  });

  it("updates only the PackageInfo payload file count", () => {
    const input = '<pkg-info><payload numberOfFiles="41927" installKBytes="897523"/></pkg-info>';
    expect(updatePackageInfoPayloadCount(input, 20_964)).toBe(
      '<pkg-info><payload numberOfFiles="20964" installKBytes="897523"/></pkg-info>',
    );
    expect(() => updatePackageInfoPayloadCount("<pkg-info/>", 1)).toThrow(/malformed/);
  });

  it("removes Finder and AppleDouble metadata before pkgbuild", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "nested", "__MACOSX"), { recursive: true });
    fs.mkdirSync(path.join(root, ".AppleDouble"));
    fs.writeFileSync(path.join(root, "nested", ".DS_Store"), "finder\n");
    fs.writeFileSync(path.join(root, "nested", "keep.txt"), "keep\n");

    removeMacMetadataFiles(root);

    expect(fs.existsSync(path.join(root, "nested", "__MACOSX"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".AppleDouble"))).toBe(false);
    expect(fs.existsSync(path.join(root, "nested", ".DS_Store"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "nested", "keep.txt"), "utf8")).toBe("keep\n");
  });
});

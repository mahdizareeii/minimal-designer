import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryGrantStore, publicRepositoryGrant } from "./grants.js";
import { inventoryForUpload, scanRepository } from "./inventory.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-workspace-bridge-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root: string, filename: string, contents: string): void {
  const destination = path.join(root, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

describe("Workspace Bridge inventory", () => {
  it("detects supported platforms and returns path-free upload mappings", async () => {
    const root = temporaryDirectory();
    write(root, "package.json", JSON.stringify({ dependencies: { "react-native": "1.0.0" } }));
    write(root, "pubspec.yaml", "name: example\n");
    write(root, "settings.gradle.kts", "rootProject.name = \"Example\"\n");
    write(root, "Example.xcodeproj/project.pbxproj", "// project\n");
    write(root, "src/components/Button.tsx", "export function Button() { return null; }\n");
    write(root, "src/screens/HomeScreen.tsx", "export const HomeScreen = () => null;\nconst routeName = '/home';\n");
    write(root, "src/theme.css", ":root { --color-brand: #123456; }\n");
    write(root, "assets/logo.png", "not-a-real-image");

    const inventory = await scanRepository(root, { now: new Date("2026-01-01T00:00:00.000Z") });
    expect(inventory.platforms).toEqual(["android", "flutter", "ios", "react-native", "web"]);
    expect(inventory.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "component", name: "Button", relativePath: "src/components/Button.tsx" }),
      expect.objectContaining({ kind: "screen", name: "HomeScreen" }),
      expect.objectContaining({ kind: "route", name: "/home" }),
      expect.objectContaining({ kind: "token", name: "--color-brand" }),
      expect.objectContaining({ kind: "asset", name: "logo" }),
    ]));
    const upload = inventoryForUpload(inventory);
    expect(JSON.stringify(upload)).not.toContain("src/components/Button.tsx");
    expect(upload.entities.every((entity) => entity.locationId.startsWith("loc_"))).toBe(true);
  });

  it("uses generic-git only when no specific platform scanner is detected", async () => {
    const webRoot = temporaryDirectory();
    write(webRoot, ".git/HEAD", `${"a".repeat(40)}\n`);
    write(webRoot, "package.json", JSON.stringify({ dependencies: {} }));
    write(webRoot, "src/App.tsx", "export function App() { return null; }\n");
    expect((await scanRepository(webRoot)).platforms).toEqual(["web"]);

    const genericRoot = temporaryDirectory();
    write(genericRoot, ".git/HEAD", `${"b".repeat(40)}\n`);
    write(genericRoot, "README.md", "Generic repository\n");
    expect((await scanRepository(genericRoot)).platforms).toEqual(["generic-git"]);
  });

  it("binds standard Git worktree pointer metadata without exposing its local path", async () => {
    const main = temporaryDirectory();
    const worktree = temporaryDirectory();
    const commonGit = path.join(main, ".git");
    const worktreeGit = path.join(commonGit, "worktrees", "feature");
    const commit = "c".repeat(40);
    write(worktreeGit, "HEAD", "ref: refs/heads/feature\n");
    write(worktreeGit, "gitdir", `${path.join(worktree, ".git")}\n`);
    write(worktreeGit, "commondir", "../..\n");
    write(commonGit, "refs/heads/feature", `${commit}\n`);
    write(worktree, ".git", `gitdir: ${worktreeGit}\n`);
    write(worktree, "src/App.tsx", "export function App() { return null; }\n");

    const inventory = await scanRepository(worktree);
    expect(inventory.gitHead).toBe(commit);
    expect(JSON.stringify(inventoryForUpload(inventory))).not.toContain(path.resolve(main));

    const traversal = temporaryDirectory();
    write(traversal, ".git", "gitdir: ../../outside\n");
    await expect(scanRepository(traversal)).rejects.toThrow("may not traverse");

    const symlinked = temporaryDirectory();
    const symlinkTarget = temporaryDirectory();
    write(symlinkTarget, "HEAD", `${commit}\n`);
    const link = path.join(symlinked, "git-target");
    fs.symlinkSync(symlinkTarget, link, "dir");
    write(symlinked, ".git", `gitdir: ${link}\n`);
    await expect(scanRepository(symlinked)).rejects.toThrow("non-symlinked directory");

    const unrelated = temporaryDirectory();
    write(unrelated, ".git", `gitdir: ${worktreeGit}\n`);
    await expect(scanRepository(unrelated)).rejects.toThrow("does not point back");
  });

  it("detects nested mobile projects and keeps semantic mappings stable across line-only edits", async () => {
    const root = temporaryDirectory();
    write(root, "package.json", JSON.stringify({ devDependencies: { "react-native": "1.0.0" } }));
    write(root, "android/settings.gradle.kts", "rootProject.name = \"Example\"\n");
    write(root, "ios/Example.xcodeproj/project.pbxproj", "// project\n");
    write(root, "ios/Example/Assets.xcassets/Brand.imageset/Contents.json", "{}\n");
    write(root, "ios/Example/Assets.xcassets/Brand.colorset/Contents.json", "{}\n");
    write(root, "src/screens/HomeScreen.tsx", [
      "export function HomeScreen() { return null; }",
      "export const routeName = '/home';",
      "",
    ].join("\n"));

    const first = await scanRepository(root, { now: new Date("2026-01-01T00:00:00.000Z") });
    expect(first.platforms).toEqual(["android", "ios", "react-native", "web"]);
    const firstMappings = new Map(first.entities.map((entity) => [`${entity.kind}:${entity.name}`, entity]));
    expect(firstMappings.get("asset:Brand")).toBeDefined();
    expect(firstMappings.get("token:Brand")).toBeDefined();
    expect((await scanRepository(root, { excludedPatterns: ["android/**", "ios/**"] })).platforms)
      .toEqual(["react-native", "web"]);
    write(root, "src/screens/HomeScreen.tsx", [
      "",
      "",
      "export function HomeScreen() { return null; }",
      "export const routeName = '/home';",
      "",
    ].join("\n"));
    const shifted = await scanRepository(root, { now: new Date("2026-01-01T00:00:01.000Z") });
    for (const key of ["screen:HomeScreen", "route:/home"]) {
      expect(shifted.entities.find((entity) => `${entity.kind}:${entity.name}` === key)).toMatchObject({
        id: firstMappings.get(key)?.id,
        locationId: firstMappings.get(key)?.locationId,
      });
    }
    expect(shifted.repositoryFingerprint).not.toBe(first.repositoryFingerprint);
    const upload = inventoryForUpload(shifted);
    expect(JSON.stringify(upload)).not.toContain("HomeScreen.tsx");
    expect(JSON.stringify(upload)).not.toContain(path.resolve(root));
  });

  it("detects bounded nested web, React Native, Flutter, and Android markers in monorepos", async () => {
    const root = temporaryDirectory();
    write(root, "apps/web/package.json", JSON.stringify({ dependencies: { react: "1.0.0" } }));
    write(root, "apps/mobile/package.json", JSON.stringify({ dependencies: { "react-native": "1.0.0" } }));
    write(root, "packages/flutter/pubspec.yaml", "name: nested_flutter\n");
    write(root, "platform/android/settings.gradle.kts", "rootProject.name = \"Nested\"\n");
    write(root, "apps/web/src/App.tsx", "export function App() { return null; }\n");
    write(root, "packages/flutter/lib/home.dart", "class HomeScreen {}\n");

    expect((await scanRepository(root)).platforms).toEqual(["android", "flutter", "react-native", "web"]);
    expect((await scanRepository(root, { excludedPatterns: ["packages/flutter/**"] })).platforms)
      .toEqual(["android", "react-native", "web"]);
  });

  it("reports marker depth and aggregate metadata exhaustion as a truncated inventory", async () => {
    const deep = temporaryDirectory();
    write(deep, `${Array.from({ length: 10 }, (_, index) => `level${index}`).join("/")}/package.json`, "{}\n");
    const deepInventory = await scanRepository(deep);
    expect(deepInventory.truncated).toBe(true);
    expect(deepInventory.excluded).toContainEqual({ category: "limit", count: 1 });

    const aggregate = temporaryDirectory();
    write(aggregate, "apps/a/package.json", JSON.stringify({ name: "a", description: "x".repeat(80) }));
    write(aggregate, "apps/b/package.json", JSON.stringify({ name: "b", description: "y".repeat(80) }));
    const aggregateInventory = await scanRepository(aggregate, { limits: { maximumTotalBytesRead: 128 } });
    expect(aggregateInventory.truncated).toBe(true);
    expect(aggregateInventory.excluded).toContainEqual({ category: "limit", count: 1 });
  });

  it("content-hashes included metadata and assets so same-size changes invalidate the repository fingerprint", async () => {
    const root = temporaryDirectory();
    write(root, "package.json", JSON.stringify({ name: "aaaa", dependencies: {} }));
    write(root, "assets/logo.png", "asset-one");
    const first = await scanRepository(root);
    write(root, "package.json", JSON.stringify({ name: "bbbb", dependencies: {} }));
    const metadataChanged = await scanRepository(root);
    expect(metadataChanged.repositoryFingerprint).not.toBe(first.repositoryFingerprint);
    write(root, "assets/logo.png", "asset-two");
    const assetChanged = await scanRepository(root);
    expect(assetChanged.repositoryFingerprint).not.toBe(metadataChanged.repositoryFingerprint);
  });

  it("enforces and records organization exclusion patterns without weakening mandatory secret exclusion", async () => {
    const root = temporaryDirectory();
    write(root, "src/App.tsx", "export function App() { return null; }\n");
    write(root, "src/private/Hidden.tsx", "export function Hidden() { return null; }\n");
    write(root, "src/generated/Generated.ts", "export const Generated = 1;\n");
    write(root, "nested/.env.custom", "TOP_SECRET=do-not-read\n");

    const excludedPatterns = ["src/private/**", "**/generated/*.ts"];
    const inventory = await scanRepository(root, { excludedPatterns });
    const serialized = JSON.stringify(inventory);
    expect(inventory.excludedPatterns).toEqual(excludedPatterns);
    expect(serialized).not.toContain("Hidden");
    expect(serialized).not.toContain("Generated");
    expect(serialized).not.toContain("TOP_SECRET");
    expect(inventory.excluded).toEqual(expect.arrayContaining([
      { category: "policy", count: 2 },
      { category: "secret", count: 1 },
    ]));
    expect(inventoryForUpload(inventory).excludedPatterns).toEqual(excludedPatterns);

    const excludedMarkerRoot = temporaryDirectory();
    write(excludedMarkerRoot, "package.json", JSON.stringify({ dependencies: { "react-native": "1.0.0" } }));
    write(excludedMarkerRoot, "src/App.tsx", "export function App() { return null; }\n");
    expect((await scanRepository(excludedMarkerRoot, { excludedPatterns: ["package.json"] })).platforms)
      .toEqual(["generic-git"]);
  });

  it("never reads secret, generated, or symlinked content", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    write(root, "src/App.tsx", "export function App() { return null; }\n");
    write(root, ".env.production", "TOP_SECRET=do-not-read\n");
    write(root, "keys/signing.pem", "do-not-read\n");
    write(root, "node_modules/leak.ts", "export const LeakedSecret = 'do-not-read';\n");
    write(outside, "Outside.ts", "export const OutsideSecret = 'do-not-read';\n");
    fs.symlinkSync(path.join(outside, "Outside.ts"), path.join(root, "src", "Linked.ts"));

    const inventory = await scanRepository(root);
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain("TOP_SECRET");
    expect(serialized).not.toContain("LeakedSecret");
    expect(serialized).not.toContain("OutsideSecret");
    expect(inventory.excluded).toEqual(expect.arrayContaining([
      { category: "secret", count: 2 },
      { category: "generated", count: 1 },
      { category: "symlink", count: 1 },
    ]));
  });

  it("fails closed when a checked ancestor directory is swapped to an outside symlink before recursion", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    write(root, "src/Inside.ts", "export const Inside = true;\n");
    write(outside, "Outside.ts", "export const OutsideSecret = 'must-not-be-read';\n");
    const sourceDirectory = path.join(root, "src");
    const displacedDirectory = path.join(root, "src-before-swap");
    let swapped = false;
    await expect(scanRepository(root, {
      beforeDirectoryRead: (_directory, relativePath) => {
        if (swapped || relativePath !== "src") return;
        fs.renameSync(sourceDirectory, displacedDirectory);
        fs.symlinkSync(outside, sourceDirectory, "dir");
        swapped = true;
      },
    })).rejects.toThrow();
    expect(swapped).toBe(true);
  });

  it("rejects a directory swapped only while pathname-based opendir is being bound", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    write(root, "src/Inside.ts", "export const Inside = true;\n");
    write(outside, "Outside.ts", "export const OutsideSecret = 'must-not-be-enumerated';\n");
    const sourceDirectory = path.join(root, "src");
    const displacedDirectory = path.join(root, "src-inside-handle");
    let swapped = false;
    let restored = false;

    await expect(scanRepository(root, {
      afterDirectoryHandleVerified: (_directory, relativePath) => {
        if (swapped || relativePath !== "src") return;
        fs.renameSync(sourceDirectory, displacedDirectory);
        fs.symlinkSync(outside, sourceDirectory, "dir");
        swapped = true;
      },
      afterDirectoryOpened: (_directory, relativePath) => {
        if (!swapped || restored || relativePath !== "src") return;
        fs.unlinkSync(sourceDirectory);
        fs.renameSync(displacedDirectory, sourceDirectory);
        restored = true;
      },
    })).rejects.toThrow("changed while it was being inspected");
    expect({ swapped, restored }).toEqual({ swapped: true, restored: true });
  });

  it("bounds and refuses symlinked package and Git discovery metadata before scanning", async () => {
    const packageRoot = temporaryDirectory();
    const outside = temporaryDirectory();
    write(outside, "package.json", JSON.stringify({ dependencies: { "react-native": "secret-outside" } }));
    fs.symlinkSync(path.join(outside, "package.json"), path.join(packageRoot, "package.json"));
    const symlinkedPackage = await scanRepository(packageRoot);
    expect(symlinkedPackage.platforms).toEqual(["generic-git"]);
    expect(symlinkedPackage.excluded).toContainEqual({ category: "symlink", count: 1 });

    const oversizedPackageRoot = temporaryDirectory();
    write(oversizedPackageRoot, "package.json", "x".repeat(1024 * 1024 + 1));
    await expect(scanRepository(oversizedPackageRoot)).rejects.toThrow("package.json exceeds");

    const symlinkedHeadRoot = temporaryDirectory();
    write(symlinkedHeadRoot, ".git/placeholder", "git metadata\n");
    write(outside, "HEAD", `${"a".repeat(40)}\n`);
    fs.symlinkSync(path.join(outside, "HEAD"), path.join(symlinkedHeadRoot, ".git", "HEAD"));
    await expect(scanRepository(symlinkedHeadRoot)).rejects.toThrow("Git HEAD must be a non-symlinked regular file");

    const oversizedPackedRefsRoot = temporaryDirectory();
    write(oversizedPackedRefsRoot, ".git/HEAD", "ref: refs/heads/main\n");
    write(oversizedPackedRefsRoot, ".git/packed-refs", "x".repeat(4 * 1024 * 1024 + 1));
    await expect(scanRepository(oversizedPackedRefsRoot)).rejects.toThrow("Git packed refs exceeds");
  });

  it("enforces explicit expiring grants and immediate revocation", async () => {
    const root = temporaryDirectory();
    const state = temporaryDirectory();
    write(root, "src/App.tsx", "export function App() { return null; }\n");
    const excludedPatterns = ["src/private/**"];
    const inventory = await scanRepository(root, { excludedPatterns });
    const store = new RepositoryGrantStore(state);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const grant = await store.create(root, inventory.repositoryFingerprint, { ttlSeconds: 60, now, excludedPatterns });
    expect(publicRepositoryGrant(grant, now).status).toBe("active");
    const grantPath = path.join(state, `${grant.id}.json`);
    const legacyGrant = JSON.parse(fs.readFileSync(grantPath, "utf8")) as Record<string, unknown>;
    delete legacyGrant.persistedInventory;
    fs.writeFileSync(grantPath, `${JSON.stringify(legacyGrant)}\n`, { mode: 0o600 });
    expect((await store.read(grant.id)).persistedInventory).toBeNull();
    expect((await store.read(grant.id)).excludedPatterns).toEqual(excludedPatterns);
    expect(publicRepositoryGrant(grant, now).excludedPatterns).toEqual(excludedPatterns);
    await expect(store.requireActive(grant.id, new Date("2026-01-01T00:00:59.000Z"))).resolves.toMatchObject({ id: grant.id });
    await expect(store.requireActive(grant.id, new Date("2026-01-01T00:01:00.000Z"))).rejects.toThrow("expired");
    const revoked = await store.revoke(grant.id, new Date("2026-01-01T00:00:30.000Z"));
    expect(publicRepositoryGrant(revoked, now).status).toBe("revoked");
    await expect(store.requireActive(grant.id, now)).rejects.toThrow("revoked");
    expect(JSON.stringify(publicRepositoryGrant(grant))).not.toContain(path.resolve(root));
  });

  it("serializes immutable inventory binding with monotonic revocation", async () => {
    const root = temporaryDirectory();
    const state = temporaryDirectory();
    write(root, "src/App.tsx", "export function App() { return null; }\n");
    const inventory = await scanRepository(root);
    const store = new RepositoryGrantStore(state);
    const grant = await store.create(root, inventory.repositoryFingerprint);
    await Promise.allSettled([
      store.bindPersistedInventory(grant.id, {
        id: `inventory_${"1".repeat(32)}`,
        inventoryHash: "2".repeat(64),
      }),
      store.revoke(grant.id),
    ]);
    const finalGrant = await store.read(grant.id);
    expect(finalGrant.revokedAt).not.toBeNull();
    await expect(store.requireActive(grant.id)).rejects.toThrow("revoked");

    const second = await store.create(root, inventory.repositoryFingerprint);
    const competing = await Promise.allSettled([
      store.bindPersistedInventory(second.id, {
        id: `inventory_${"3".repeat(32)}`,
        inventoryHash: "4".repeat(64),
      }),
      store.bindPersistedInventory(second.id, {
        id: `inventory_${"5".repeat(32)}`,
        inventoryHash: "6".repeat(64),
      }),
    ]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([
      `inventory_${"3".repeat(32)}`,
      `inventory_${"5".repeat(32)}`,
    ]).toContain((await store.read(second.id)).persistedInventory?.id);
  });

  it("fails closed when inventory limits are reached", async () => {
    const root = temporaryDirectory();
    write(root, "a.ts", "export const First = 1;\n");
    write(root, "b.ts", "export const Second = 2;\n");
    const inventory = await scanRepository(root, { limits: { maximumFiles: 1 } });
    expect(inventory.truncated).toBe(true);
    expect(inventory.scannedFileCount).toBe(1);
    expect(inventory.excluded.find((entry) => entry.category === "limit")?.count).toBeGreaterThan(0);
  });
});

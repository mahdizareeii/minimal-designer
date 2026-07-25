import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeRgbaPng } from "./render.js";
import { ContentAddressedPreviewRenderStore } from "./preview-render-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-preview-render-store-"));
  roots.push(root);
  const png = encodeRgbaPng(4, 3, Buffer.alloc(4 * 3 * 4, 255));
  const sha256 = createHash("sha256").update(png).digest("hex");
  return { root, store: new ContentAddressedPreviewRenderStore(root), png, sha256 };
}

describe("content-addressed exact preview render storage", () => {
  it("writes and rereads only digest-matching PNG bytes", () => {
    const { store, png, sha256 } = fixture();
    store.write(png, sha256);
    expect(store.artifactPath(sha256)).toBe(path.join(store.root, `${sha256}.png`));
    expect(store.read(sha256)).toEqual(png);
    expect(() => store.write(png, "0".repeat(64))).toThrow(/SHA-256/i);
  });

  it("fails closed for corrupted or symbolic content-addressed artifacts", () => {
    const { store, png, sha256 } = fixture();
    store.write(png, sha256);
    fs.writeFileSync(store.artifactPath(sha256), Buffer.from("not a png"));
    expect(() => store.read(sha256)).toThrow(/integrity|bounded regular file/i);
  });

  it("collects only old unreferenced digest artifacts", () => {
    const first = fixture();
    const secondPng = encodeRgbaPng(2, 2, Buffer.alloc(2 * 2 * 4, 127));
    const secondSha = createHash("sha256").update(secondPng).digest("hex");
    first.store.write(first.png, first.sha256);
    first.store.write(secondPng, secondSha);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(first.store.artifactPath(first.sha256), old, old);
    fs.utimesSync(first.store.artifactPath(secondSha), old, old);
    expect(first.store.cleanupUnreferenced(new Set([first.sha256]), Date.now() - 60_000)).toBe(1);
    expect(first.store.read(first.sha256)).toEqual(first.png);
    expect(first.store.read(secondSha)).toBeNull();
  });

  it("accepts a verified concurrent Windows-style destination winner", () => {
    const { store, png, sha256 } = fixture();
    const destination = store.artifactPath(sha256);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce((source) => {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const error = new Error("destination exists") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      expect(() => store.write(png, sha256)).not.toThrow();
      expect(store.read(sha256)).toEqual(png);
      expect(fs.readdirSync(store.root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });
});

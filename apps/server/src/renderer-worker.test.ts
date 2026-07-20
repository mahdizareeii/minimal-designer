import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRendererFilesystemIsolation,
  loadRendererWorkerConfig,
  validateRendererMountInfo,
} from "./renderer-worker.js";
import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_RENDER_IPC_MAX_BYTES,
  DEFAULT_RENDER_MAX_PIXELS,
} from "./renderer-contract.js";
import {
  DEFAULT_UNIX_RENDERER_SOCKET,
  DEFAULT_WINDOWS_RENDERER_PIPE,
  rendererEndpointKind,
  validateRendererEndpoint,
} from "./renderer-endpoint.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

describe("renderer filesystem isolation", () => {
  it("uses the same bounded raster defaults as the API and rejects divergent limits", () => {
    expect(loadRendererWorkerConfig({ NODE_ENV: "test" })).toMatchObject({
      maxAssetBytes: DEFAULT_MAX_ASSET_BYTES,
      maxAssetPixels: DEFAULT_RENDER_MAX_PIXELS,
      maxPixels: DEFAULT_RENDER_MAX_PIXELS,
      ipcMaxMessageBytes: DEFAULT_RENDER_IPC_MAX_BYTES,
    });
    expect(() => loadRendererWorkerConfig({
      NODE_ENV: "test",
      DESIGNER_MAX_ASSET_PIXELS: "32000001",
      FORMASPEC_RENDER_MAX_PIXELS: "32000000",
    })).toThrow(/cannot exceed FORMASPEC_RENDER_MAX_PIXELS/);
    expect(() => loadRendererWorkerConfig({
      NODE_ENV: "test",
      MAX_UPLOAD_BYTES: String(1024 * 1024),
      FORMASPEC_RENDER_IPC_MAX_BYTES: String(1024 * 1024),
    })).toThrow(/base64 framing/);
  });

  it("selects and validates platform-native renderer IPC endpoints", () => {
    expect(loadRendererWorkerConfig({ NODE_ENV: "test" }, "linux").socketPath)
      .toBe(DEFAULT_UNIX_RENDERER_SOCKET);
    expect(loadRendererWorkerConfig({ NODE_ENV: "test" }, "win32").socketPath)
      .toBe(DEFAULT_WINDOWS_RENDERER_PIPE);
    expect(rendererEndpointKind(DEFAULT_UNIX_RENDERER_SOCKET)).toBe("unix-socket");
    expect(rendererEndpointKind(DEFAULT_WINDOWS_RENDERER_PIPE)).toBe("windows-named-pipe");
    expect(validateRendererEndpoint(String.raw`\\.\pipe\formaspec-renderer-alice`, "win32"))
      .toBe(String.raw`\\.\pipe\formaspec-renderer-alice`);
    expect(() => validateRendererEndpoint(String.raw`\\.\pipe\..\renderer`, "win32"))
      .toThrow(/invalid Windows named-pipe name/);
    expect(() => validateRendererEndpoint("/run/formaspec/renderer.sock", "win32"))
      .toThrow(/Windows named pipe/);
    expect(() => validateRendererEndpoint(String.raw`\\.\pipe\formaspec-renderer`, "linux"))
      .toThrow(/Unix-domain-socket/);
  });

  it("accepts the root filesystem, IPC socket, and temporary mounts", () => {
    expect(() => validateRendererMountInfo([
      "29 23 0:25 / / rw,relatime - overlay overlay rw",
      "30 29 0:26 / /run/formaspec rw,nosuid,nodev - tmpfs tmpfs rw",
      "31 29 0:27 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw",
    ].join("\n"))).not.toThrow();
  });

  it("rejects production data, backup, and nested mounts", () => {
    for (const mountPoint of ["/data", "/data/assets", "/backups", "/backups/archive"]) {
      expect(() => validateRendererMountInfo([
        "29 23 0:25 / / rw,relatime - overlay overlay rw",
        `30 29 0:26 / ${mountPoint} rw,nosuid,nodev - ext4 /dev/mapper/company-data rw`,
      ].join("\n"))).toThrow(/filesystem isolation failed/);
    }
  });

  it("fails closed when the Linux mount table is malformed or unavailable", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-renderer-mounts-"));
    temporaryDirectories.push(root);
    const malformed = path.join(root, "mountinfo");
    await fs.promises.writeFile(malformed, "not a mountinfo row\n");
    await expect(assertRendererFilesystemIsolation("linux", malformed))
      .rejects.toThrow(/malformed/);
    await expect(assertRendererFilesystemIsolation("linux", path.join(root, "missing")))
      .rejects.toThrow(/could not be verified/);
  });
});

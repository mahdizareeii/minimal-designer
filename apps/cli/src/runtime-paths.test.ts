import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localApiOrigin } from "./local-api.js";
import { defaultDatabasePath } from "./migrations.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("FormaSpec runtime paths", () => {
  it("preserves source-workspace state defaults", () => {
    const root = path.resolve("/tmp/formaspec-source-workspace");
    expect(resolveRuntimePaths(root, {})).toEqual({
      projectRoot: root,
      runtimeDirectory: path.join(root, ".designer"),
      runDirectory: path.join(root, ".designer", "run"),
      environmentDirectory: path.join(root, ".designer", "env"),
      dataDirectory: path.join(root, "data"),
      backupDirectory: path.join(root, ".designer", "backups"),
      logDirectory: path.join(root, ".designer", "logs"),
      supportDirectory: path.join(root, ".designer", "support-bundles"),
      usesExternalStatePaths: false,
    });
  });

  it("binds every packaged path to explicit user-owned state", () => {
    const root = path.resolve("/tmp/formaspec-packaged-app");
    const state = path.resolve("/tmp/formaspec-native-state");
    expect(resolveRuntimePaths(root, {
      FORMASPEC_RUNTIME_DIR: path.join(state, "runtime"),
      FORMASPEC_DATA_DIR: path.join(state, "data"),
      FORMASPEC_BACKUP_DIR: path.join(state, "backups"),
      FORMASPEC_LOG_DIR: path.join(state, "logs"),
      FORMASPEC_SUPPORT_DIR: path.join(state, "support-bundles"),
    })).toEqual({
      projectRoot: root,
      runtimeDirectory: path.join(state, "runtime"),
      runDirectory: path.join(state, "runtime", "run"),
      environmentDirectory: path.join(state, "runtime", "env"),
      dataDirectory: path.join(state, "data"),
      backupDirectory: path.join(state, "backups"),
      logDirectory: path.join(state, "logs"),
      supportDirectory: path.join(state, "support-bundles"),
      usesExternalStatePaths: true,
    });
  });

  it("uses packaged runtime records and native data for API and migration discovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-runtime-paths-"));
    temporaryDirectories.push(root);
    const state = path.join(root, "native-state");
    const environment = {
      FORMASPEC_RUNTIME_DIR: path.join(state, "runtime"),
      FORMASPEC_DATA_DIR: path.join(state, "data"),
    };
    fs.mkdirSync(path.join(state, "runtime", "run"), { recursive: true });
    fs.writeFileSync(path.join(state, "runtime", "run", "url"), "http://127.0.0.1:4987\n");

    expect(localApiOrigin(path.join(root, "packaged-app"), environment)).toBe("http://127.0.0.1:4987");
    expect(defaultDatabasePath(path.join(root, "packaged-app"), environment)).toBe(
      path.join(state, "data", "designer.sqlite"),
    );
    expect(fs.existsSync(path.join(root, "packaged-app", ".designer"))).toBe(false);
  });

  it.each([
    "FORMASPEC_RUNTIME_DIR",
    "FORMASPEC_DATA_DIR",
    "FORMASPEC_BACKUP_DIR",
    "FORMASPEC_LOG_DIR",
    "FORMASPEC_SUPPORT_DIR",
  ] as const)("rejects an unsafe relative %s override", (name) => {
    expect(() => resolveRuntimePaths("/tmp/formaspec", { [name]: "relative/state" })).toThrow(
      `${name} must be a non-empty absolute path.`,
    );
  });
});

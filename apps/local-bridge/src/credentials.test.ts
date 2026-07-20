import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSystemCredentialStore,
  type CredentialCommandRunner,
} from "./credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-dpapi-"));
  temporaryDirectories.push(root);
  return root;
}

describe("system credential storage", () => {
  it("stores Windows grants as DPAPI ciphertext without placing the secret in argv or files", async () => {
    const root = await temporaryRoot();
    const bin = path.join(root, "bin");
    const credentialDirectory = path.join(root, "credentials");
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(path.join(bin, "powershell.exe"), "test executable");
    const observed: Array<{ executable: string; args: readonly string[]; input: string }> = [];
    const runner: CredentialCommandRunner = async (executable, args, options = {}) => {
      const input = options.input ?? "";
      observed.push({ executable, args, input });
      const script = args.at(-1) ?? "";
      if (script.includes("::Protect")) {
        return {
          exitCode: 0,
          stdout: Buffer.from(`dpapi:${input}`, "utf8").toString("base64"),
          stderr: "",
        };
      }
      const decoded = Buffer.from(input.trim(), "base64").toString("utf8");
      return { exitCode: 0, stdout: decoded.slice("dpapi:".length), stderr: "" };
    };
    const secret = "scoped-upstream-grant-00000001";
    const store = createSystemCredentialStore("http://127.0.0.1:4310/mcp", {
      PATH: bin,
      FORMASPEC_CREDENTIALS_DIR: credentialDirectory,
    }, { platform: "win32", commandRunner: runner });

    await store.write(secret);
    await expect(store.read()).resolves.toBe(secret);
    expect(observed).toHaveLength(3);
    for (const command of observed) {
      expect(command.executable).toBe(path.join(bin, "powershell.exe"));
      expect(command.args.join(" ")).not.toContain(secret);
    }
    const files = await fs.promises.readdir(credentialDirectory);
    expect(files).toHaveLength(1);
    const diskBytes = await fs.promises.readFile(path.join(credentialDirectory, files[0]!), "utf8");
    expect(diskBytes).not.toContain(secret);
    expect(Buffer.from(diskBytes.trim(), "base64").toString("utf8")).toBe(`dpapi:${secret}`);

    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it("fails closed on Windows when PowerShell or a private user storage root is unavailable", async () => {
    const root = await temporaryRoot();
    const store = createSystemCredentialStore("http://127.0.0.1:4310/mcp", {
      PATH: path.join(root, "missing"),
    }, { platform: "win32" });
    await expect(store.write("secret")).rejects.toThrow(/PowerShell\/DPAPI/);
    await expect(store.read()).resolves.toBeNull();
  });
});

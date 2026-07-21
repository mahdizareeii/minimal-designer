import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildDebFromPayload, debianControl, linuxDebBuildUsage } from "./build-linux-deb.js";
import { buildRpmFromPayload, linuxRpmBuildUsage, rpmSpec } from "./build-linux-rpm.js";
import {
  assertExecutableFile,
  assertLinuxPackagingHost,
  normalizeLinuxPayload,
  normalizeSourceDateEpoch,
  sha256File,
} from "./linux-packaging.js";
import { runPackageCommand, type PackageCommandRunner } from "./package-command.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(prefix = "formaspec-linux-package-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function executableFixture(root: string, name: string): string {
  const target = path.join(root, name);
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return target;
}

function payloadFixture(root: string): string {
  const payload = path.join(root, "payload");
  fs.mkdirSync(path.join(payload, "opt/formaspec"), { recursive: true });
  fs.mkdirSync(path.join(payload, "etc/formaspec"), { recursive: true });
  fs.writeFileSync(path.join(payload, "opt/formaspec/VERSION"), "1.2.3\n", { mode: 0o600 });
  fs.writeFileSync(path.join(payload, "etc/formaspec/formaspec.env"), "FORMASPEC_RENDER_CONCURRENCY=2\n");
  return payload;
}

describe("Linux package staging", () => {
  it("normalizes modes and timestamps without dereferencing contained symlinks", () => {
    const root = temporaryRoot();
    const payload = payloadFixture(root);
    const executable = path.join(payload, "opt/formaspec/tool");
    fs.writeFileSync(executable, "tool\n", { mode: 0o711 });
    fs.symlinkSync("VERSION", path.join(payload, "opt/formaspec/current"));

    normalizeLinuxPayload(payload, 1_700_000_000);

    expect(fs.statSync(path.join(payload, "opt/formaspec")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(payload, "opt/formaspec/VERSION")).mode & 0o777).toBe(0o644);
    expect(fs.statSync(executable).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(payload, "opt/formaspec/current"))).toBe("VERSION");
    expect(Math.round(fs.statSync(executable).mtimeMs / 1000)).toBe(1_700_000_000);
    expect(Math.round(fs.lstatSync(path.join(payload, "opt/formaspec/current")).mtimeMs / 1000)).toBe(1_700_000_000);
  });

  it("validates source epochs, platform, and required tools fail closed", () => {
    expect(normalizeSourceDateEpoch(undefined)).toBe(0);
    expect(normalizeSourceDateEpoch("1700000000")).toBe(1_700_000_000);
    expect(() => normalizeSourceDateEpoch("1.5")).toThrow(/whole Unix timestamp/);
    expect(() => normalizeSourceDateEpoch("-1")).toThrow(/whole Unix timestamp/);
    expect(() => assertLinuxPackagingHost("darwin")).toThrow(/must be built on Linux/);
    expect(() => assertExecutableFile(path.join(temporaryRoot(), "missing"))).toThrow(/unavailable/);
  });

  it("emits deterministic Debian control metadata", () => {
    const root = temporaryRoot();
    const payload = payloadFixture(root);
    const control = debianControl(payload, "1.2.3", "x64");
    expect(control).toContain("Package: formaspec");
    expect(control).toContain("Version: 1.2.3");
    expect(control).toContain("Architecture: amd64");
    expect(control).toContain("Depends: systemd, xdg-utils, desktop-file-utils, ca-certificates, passwd");
    expect(control).toMatch(/Installed-Size: \d+/);
  });
});

describe("DEB builder command boundary", () => {
  it("uses argv-only dpkg-deb execution and writes an unsigned checksum", () => {
    const root = temporaryRoot();
    const payload = payloadFixture(root);
    const outputDirectory = path.join(root, "out");
    const executable = executableFixture(root, "dpkg-deb");
    let recordedArguments: readonly string[] = [];
    let recordedEpoch: string | undefined;
    const runner: PackageCommandRunner = {
      run(_command, arguments_, options) {
        recordedArguments = arguments_;
        recordedEpoch = options?.env?.SOURCE_DATE_EPOCH;
        const output = arguments_.at(-1)!;
        fs.writeFileSync(output, "deterministic-deb\n");
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const output = buildDebFromPayload({
      payloadRoot: payload,
      outputDirectory,
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      dpkgDebExecutable: executable,
      commandRunner: runner,
      platform: "linux",
    });

    expect(path.basename(output)).toBe("FormaSpec-1.2.3-linux-amd64-unsigned.deb");
    expect(recordedArguments).toContain("--root-owner-group");
    expect(recordedArguments).toContain("--uniform-compression");
    expect(recordedEpoch).toBe("1700000000");
    expect(fs.statSync(path.join(payload, "DEBIAN/preinst")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(payload, "DEBIAN/conffiles"), "utf8")).toBe("/etc/formaspec/formaspec.env\n");
    expect(fs.readFileSync(`${output}.sha256`, "utf8")).toBe(`${sha256File(output)}  ${path.basename(output)}\n`);
  });

  it("rejects non-Linux execution before invoking a package tool", () => {
    let calls = 0;
    expect(() => buildDebFromPayload({
      payloadRoot: payloadFixture(temporaryRoot()),
      outputDirectory: temporaryRoot(),
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 0,
      dpkgDebExecutable: "/missing/dpkg-deb",
      commandRunner: { run: () => { calls += 1; return { status: 0, stdout: "", stderr: "" }; } },
      platform: "darwin",
    })).toThrow(/must be built on Linux/);
    expect(calls).toBe(0);
  });
});

describe("RPM builder command boundary", () => {
  it("creates a deterministic spec and copies the unsigned RPM to the public artifact name", () => {
    const root = temporaryRoot();
    const payload = payloadFixture(root);
    const outputDirectory = path.join(root, "out");
    const executable = executableFixture(root, "rpmbuild");
    let specContents = "";
    let recordedArguments: readonly string[] = [];
    const runner: PackageCommandRunner = {
      run(_command, arguments_) {
        recordedArguments = arguments_;
        specContents = fs.readFileSync(arguments_[1]!, "utf8");
        const rpmDirectoryDefine = arguments_.find((argument) => argument.startsWith("_rpmdir "))!;
        const rpmDirectory = rpmDirectoryDefine.slice("_rpmdir ".length);
        const built = path.join(rpmDirectory, "x86_64", "formaspec-1.2.3-0.rc.1.x86_64.rpm");
        fs.mkdirSync(path.dirname(built), { recursive: true });
        fs.writeFileSync(built, "deterministic-rpm\n");
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const output = buildRpmFromPayload({
      payloadRoot: payload,
      outputDirectory,
      version: "1.2.3-rc.1",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      rpmbuildExecutable: executable,
      commandRunner: runner,
      platform: "linux",
    });

    expect(path.basename(output)).toBe("FormaSpec-1.2.3-rc.1-linux-x86_64-unsigned.rpm");
    expect(specContents).toContain("Version: 1.2.3");
    expect(specContents).toContain("Release: 0.rc.1");
    expect(specContents).toContain("%config(noreplace) /etc/formaspec/formaspec.env");
    expect(specContents).toContain("/var/lib/formaspec/data and /var/lib/formaspec/backups");
    expect(recordedArguments).toContain("use_source_date_epoch_as_buildtime 1");
    expect(fs.readFileSync(`${output}.sha256`, "utf8")).toBe(`${sha256File(output)}  ${path.basename(output)}\n`);
  });

  it("keeps package scripts free of interpolated build paths", () => {
    const spec = rpmSpec("0.2.0", "arm64");
    expect(spec).toContain("BuildArch: aarch64");
    expect(spec).toContain("cp -a %{formaspec_payload}/. %{buildroot}/");
    expect(spec).not.toContain(os.homedir());
    expect(spec).not.toContain("DESIGNER_TOKEN");
  });
});

describe("strict package command runner", () => {
  it("rejects relative executables and NUL arguments before dispatch", () => {
    let calls = 0;
    const runner: PackageCommandRunner = {
      run: () => { calls += 1; return { status: 0, stdout: "", stderr: "" }; },
    };
    expect(() => runPackageCommand(runner, "dpkg-deb", ["--version"])).toThrow(/absolute executable path/);
    expect(() => runPackageCommand(runner, "/usr/bin/dpkg-deb", ["bad\0argument"])).toThrow(/control characters/);
    expect(() => runPackageCommand(runner, "/usr/bin/dpkg-deb", ["bad\nargument"])).toThrow(/control characters/);
    expect(() => runPackageCommand(runner, "/usr/bin/dpkg-deb", ["--version"], { timeoutMs: 0 }))
      .toThrow(/timeout must be a whole number/);
    expect(calls).toBe(0);
  });

  it("reports a bounded nonzero command failure without using a shell", () => {
    const runner: PackageCommandRunner = {
      run: () => ({ status: 2, stdout: "", stderr: "package metadata rejected" }),
    };
    expect(() => runPackageCommand(runner, "/usr/bin/dpkg-deb", ["--build"]))
      .toThrow(/exit code 2: package metadata rejected/);
  });

  it("reports an absolute packaging-command deadline explicitly", () => {
    const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const runner: PackageCommandRunner = {
      run: () => ({ status: null, stdout: "", stderr: "", error: timeout }),
    };
    expect(() => runPackageCommand(runner, "/usr/bin/dpkg-deb", ["--build"], { timeoutMs: 50 }))
      .toThrow(/exceeded its absolute deadline/);
  });
});

describe("workspace Linux packaging entry points", () => {
  it("documents native-only DEB and RPM builders without running a package tool", () => {
    expect(linuxDebBuildUsage()).toContain("Usage: build-linux-deb");
    expect(linuxDebBuildUsage()).toContain("runs only on Linux");
    expect(linuxRpmBuildUsage()).toContain("Usage: build-linux-rpm");
    expect(linuxRpmBuildUsage()).toContain("never downloads, signs, installs, or starts");
  });

  it("builds the workspace before invoking each native package builder", () => {
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    expect(rootPackage.scripts?.["package:linux:deb"]).toBe(
      "pnpm -r build && node apps/installer/dist/build-linux-deb.js",
    );
    expect(rootPackage.scripts?.["package:linux:rpm"]).toBe(
      "pnpm -r build && node apps/installer/dist/build-linux-rpm.js",
    );
  });
});

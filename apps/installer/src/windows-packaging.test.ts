import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildUnsignedWindowsMsiFromApplication } from "./build-windows-msi.js";
import {
  assertWindowsMsiVersion,
  assertWindowsPackageArchitecture,
  assertWindowsPayloadPathSet,
  assertWindowsRelativePath,
  WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH,
  WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH,
  WINDOWS_SERVICE_HOST_RELATIVE_PATH,
  windowsProductCode,
  windowsServiceConfiguration,
  windowsUpgradeCode,
} from "./windows-layout.js";
import {
  assertWindowsPackagingHost,
  buildUnsignedWindowsMsi,
  generateWindowsWixSource,
  normalizeWindowsSourceDateEpoch,
  sha256WindowsFile,
  stageWindowsPayload,
  verifyWindowsPayload,
  verifyWindowsServiceHost,
  WINDOWS_SERVICE_HOST_CONTRACT,
  WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT,
  WINDOWS_WIX_PROVENANCE_FORMAT,
  windowsMsiPrerequisiteSummary,
  windowsPeArchitecture,
  type WindowsServiceHostInput,
} from "./windows-packaging.js";
import type { PackageCommandRunner } from "./package-command.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(prefix = "formaspec-windows-package-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function peBytes(architecture: "x64" | "arm64"): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(architecture === "x64" ? 0x8664 : 0xaa64, 0x84);
  return bytes;
}

function writeFixture(root: string, relativePath: string, contents: Buffer | string): string {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function applicationPayloadFixture(root: string, architecture: "x64" | "arm64" = "x64"): string {
  const payload = path.join(root, "application");
  fs.mkdirSync(payload);
  writeFixture(payload, "runtime/node.exe", peBytes(architecture));
  writeFixture(
    payload,
    "runtime/ms-playwright/chromium_headless_shell-123/chrome-headless-shell-win64/headless_shell.exe",
    peBytes(architecture),
  );
  for (const relativePath of [
    "app/apps/server/dist/index.js",
    "app/apps/server/dist/renderer-worker.js",
    "app/apps/web/dist/index.html",
    "app/apps/cli/dist/index.js",
    "app/apps/local-bridge/dist/index.js",
    "app/apps/workspace-bridge/dist/cli.js",
    "app/packages/core/dist/index.js",
  ]) writeFixture(payload, relativePath, `fixture:${relativePath}\n`);
  writeFixture(payload, "app/package.json", "{\"private\":true}\n");
  return payload;
}

function serviceHostFixture(root: string, architecture: "x64" | "arm64" = "x64"): WindowsServiceHostInput {
  const serviceHostBytes = peBytes(architecture);
  serviceHostBytes.write("FORMASPEC-SERVICE-HOST", 192, "ascii");
  const executable = writeFixture(root, "inputs/service-host.exe", serviceHostBytes);
  const license = writeFixture(root, "inputs/SERVICE-HOST-LICENSE.txt", "MIT License\nfixture only\n");
  const executableBytes = fs.readFileSync(executable);
  const licenseBytes = fs.readFileSync(license);
  const provenance = writeFixture(root, "inputs/service-host-provenance.json", `${JSON.stringify({
    format: WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT,
    formatVersion: 1,
    component: "FormaSpec Windows Service Host",
    version: "1.2.3",
    architecture,
    contract: WINDOWS_SERVICE_HOST_CONTRACT,
    capabilities: ["api-service", "open-editor", "protocol-handler", "renderer-service"],
    executableSha256: sha256(executableBytes),
    executableSizeBytes: executableBytes.length,
    licenseSpdx: "MIT",
    licenseSha256: sha256(licenseBytes),
    licenseSizeBytes: licenseBytes.length,
    sourceUrl: "https://example.invalid/formaspec-service-host-1.2.3.tar.gz",
    sourceSha256: "a".repeat(64),
  }, null, 2)}\n`);
  return { executable, provenance, license };
}

function stageFixture(
  root: string,
  architecture: "x64" | "arm64" = "x64",
  sourceDateEpoch = 1_700_000_000,
): string {
  const payloadRoot = path.join(root, "staged");
  stageWindowsPayload({
    applicationPayloadRoot: applicationPayloadFixture(root, architecture),
    payloadRoot,
    serviceHost: serviceHostFixture(root, architecture),
    version: "1.2.3",
    architecture,
    sourceDateEpoch,
  });
  return payloadRoot;
}

function wixFixture(root: string): { executable: string; provenance: string; version: string } {
  const executable = writeFixture(root, "wix/wix.exe", "pinned wix v4 test shim\n");
  const executableBytes = fs.readFileSync(executable);
  const version = "4.0.6";
  const provenance = writeFixture(root, "wix/wix-provenance.json", `${JSON.stringify({
    format: WINDOWS_WIX_PROVENANCE_FORMAT,
    formatVersion: 1,
    component: "WiX Toolset",
    version,
    executableSha256: sha256(executableBytes),
    executableSizeBytes: executableBytes.length,
    licenseSpdx: "MS-RL",
    sourceUrl: "https://example.invalid/wix-4.0.6.zip",
    sourceSha256: "b".repeat(64),
  }, null, 2)}\n`);
  return { executable, provenance, version };
}

describe("Windows MSI validation", () => {
  it("accepts only MSI-safe release versions and supported 64-bit architectures", () => {
    expect(assertWindowsMsiVersion("0.2.0")).toBe("0.2.0");
    expect(assertWindowsMsiVersion("255.255.65535")).toBe("255.255.65535");
    expect(() => assertWindowsMsiVersion("1.2.3-rc.1")).toThrow(/three-part numeric release/);
    expect(() => assertWindowsMsiVersion("256.0.0")).toThrow(/exceed Windows Installer limits/);
    expect(assertWindowsPackageArchitecture("x64")).toBe("x64");
    expect(assertWindowsPackageArchitecture("arm64")).toBe("arm64");
    expect(() => assertWindowsPackageArchitecture("ia32")).toThrow(/Unsupported Windows installer architecture/);
  });

  it("rejects traversal, separators, reserved names, ambiguous names, and unbounded paths", () => {
    expect(assertWindowsRelativePath("app/apps/server/dist/index.js")).toBe("app/apps/server/dist/index.js");
    for (const candidate of [
      "../escape.txt",
      "app\\escape.txt",
      "/absolute.txt",
      "runtime/CON.txt",
      "runtime/trailing. ",
      "runtime/$(Injected).dll",
      `runtime/${"a".repeat(121)}.dll`,
    ]) expect(() => assertWindowsRelativePath(candidate)).toThrow(/Windows payload path/);
  });

  it("uses stable architecture-specific upgrade identity and version-specific product identity", () => {
    expect(windowsUpgradeCode("x64")).toBe(windowsUpgradeCode("x64"));
    expect(windowsUpgradeCode("x64")).not.toBe(windowsUpgradeCode("arm64"));
    expect(windowsProductCode("1.2.3", "x64")).toBe(windowsProductCode("1.2.3", "x64"));
    expect(windowsProductCode("1.2.3", "x64")).not.toBe(windowsProductCode("1.2.4", "x64"));
    expect(windowsProductCode("1.2.3", "x64")).toMatch(/^\{[A-F0-9-]{36}\}$/);
  });

  it("validates source epochs and rejects non-Windows native build execution", () => {
    expect(normalizeWindowsSourceDateEpoch(undefined)).toBe(315_532_800);
    expect(normalizeWindowsSourceDateEpoch("1700000000")).toBe(1_700_000_000);
    expect(() => normalizeWindowsSourceDateEpoch("1.5")).toThrow(/whole Unix timestamp/);
    expect(() => normalizeWindowsSourceDateEpoch("0")).toThrow(/CAB timestamps begin in 1980/);
    expect(() => assertWindowsPackagingHost("darwin")).toThrow(/must be built on Windows/);
  });
});

describe("native Windows service-host boundary", () => {
  it("verifies exact executable, PE architecture, permissive license, source provenance, and capabilities", () => {
    const root = temporaryRoot();
    const input = serviceHostFixture(root);
    const verified = verifyWindowsServiceHost(input, "x64");
    expect(verified.provenance.contract).toBe(WINDOWS_SERVICE_HOST_CONTRACT);
    expect(verified.provenance.licenseSpdx).toBe("MIT");
    expect(windowsPeArchitecture(input.executable)).toBe("x64");
  });

  it("rejects a mismatched architecture before the host can back MSI service entries", () => {
    const root = temporaryRoot();
    expect(() => verifyWindowsServiceHost(serviceHostFixture(root, "arm64"), "x64"))
      .toThrow(/does not match requested x64 architecture/);
  });

  it("rejects executable, license, capability, and license-policy provenance tampering", () => {
    const root = temporaryRoot();
    const executableTamper = serviceHostFixture(root);
    fs.appendFileSync(executableTamper.executable, "tamper");
    expect(() => verifyWindowsServiceHost(executableTamper, "x64")).toThrow(/exact provenance integrity/);

    const licenseRoot = temporaryRoot();
    const licenseTamper = serviceHostFixture(licenseRoot);
    fs.appendFileSync(licenseTamper.license, "tamper");
    expect(() => verifyWindowsServiceHost(licenseTamper, "x64")).toThrow(/license failed/);

    for (const mutate of [
      (value: Record<string, unknown>) => { value.capabilities = ["renderer-service"]; },
      (value: Record<string, unknown>) => { value.licenseSpdx = "GPL-3.0-only"; },
      (value: Record<string, unknown>) => { value.sourceUrl = "http://example.invalid/source.zip"; },
    ]) {
      const candidateRoot = temporaryRoot();
      const candidate = serviceHostFixture(candidateRoot);
      const value = JSON.parse(fs.readFileSync(candidate.provenance, "utf8")) as Record<string, unknown>;
      mutate(value);
      fs.writeFileSync(candidate.provenance, `${JSON.stringify(value)}\n`);
      expect(() => verifyWindowsServiceHost(candidate, "x64")).toThrow();
    }
  });

  it("does not treat Node.js itself as a native Windows Service executable", () => {
    const root = temporaryRoot();
    const application = applicationPayloadFixture(root);
    const node = path.join(application, "runtime/node.exe");
    const input = serviceHostFixture(root);
    input.executable = node;
    expect(() => verifyWindowsServiceHost(input, "x64")).toThrow(/exact provenance integrity/);
  });
});

describe("deterministic Windows payload and WiX v4 layout", () => {
  it("stages a manifest-pinned self-contained payload deterministically", () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const first = stageFixture(firstRoot);
    const second = stageFixture(secondRoot);
    expect(fs.readFileSync(path.join(first, WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH), "utf8"))
      .toBe(fs.readFileSync(path.join(second, WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH), "utf8"));
    expect(generateWindowsWixSource(first, "1.2.3", "x64"))
      .toBe(generateWindowsWixSource(second, "1.2.3", "x64"));
    expect(Math.round(fs.statSync(path.join(first, "runtime/node.exe")).mtimeMs / 1000)).toBe(1_700_000_000);
  });

  it("emits per-machine Program Files installation, permanent ProgramData, services, shortcut, and protocol registration", () => {
    const source = generateWindowsWixSource(stageFixture(temporaryRoot()), "1.2.3", "x64");
    expect(source).toContain('xmlns="http://wixtoolset.org/schemas/v4/wxs"');
    expect(source).toContain('Scope="perMachine"');
    expect(source).toContain('<StandardDirectory Id="ProgramFiles6432Folder">');
    expect(source).toContain('<Directory Id="INSTALLFOLDER" Name="FormaSpec" />');
    expect(source).toContain('<Directory Id="FORMASPECDATA" Name="data" />');
    expect(source).toContain('<Directory Id="FORMASPECBACKUPS" Name="backups" />');
    expect(source).toContain('<Directory Id="FORMASPECCONFIG" Name="config" />');
    expect(source.match(/Permanent="yes" NeverOverwrite="yes"/g)).toHaveLength(4);
    expect(source).toContain('Name="FormaSpecRenderer"');
    expect(source).toContain('Name="FormaSpecApi"');
    expect(source).toContain('Source="$(var.PayloadRoot)\\service\\FormaSpec.ServiceHost.exe"');
    expect(source).toContain('Arguments="--open-editor"');
    expect(source).toContain('Key="Software\\Classes\\formaspec"');
    expect(source).toContain('--protocol &quot;%1&quot;');
    expect(source).not.toContain('<RemoveFolder Id="RemoveFormaSpecData');
  });

  it("generates local-only service configuration with the existing named-pipe contract and no credentials", () => {
    const configuration = windowsServiceConfiguration("1.2.3", "arm64");
    expect(configuration).toContain('"APP_MODE": "local"');
    expect(configuration).toContain('"HOST": "127.0.0.1"');
    expect(configuration).toContain('"FORMASPEC_RENDER_SOCKET": "\\\\\\\\.\\\\pipe\\\\formaspec-renderer"');
    expect(configuration).toContain('"architecture": "arm64"');
    expect(configuration).not.toMatch(/bearer|password|secret|token/i);
  });

  it("refuses source generation after any payload or service-configuration mutation", () => {
    const root = temporaryRoot();
    const payload = stageFixture(root);
    fs.appendFileSync(path.join(payload, "app/apps/server/dist/index.js"), "tamper");
    expect(() => generateWindowsWixSource(payload, "1.2.3", "x64")).toThrow(/inventory or hashes/);

    const second = stageFixture(temporaryRoot());
    fs.appendFileSync(path.join(second, ...WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH.split("/")), "tamper");
    expect(() => verifyWindowsPayload(second, "1.2.3", "x64")).toThrow(/configuration was modified|inventory or hashes/);
  });

  it("rejects symlinks, case-insensitive collisions, and disallowed browser payloads", () => {
    const symlinkRoot = temporaryRoot();
    const symlinkApplication = applicationPayloadFixture(symlinkRoot);
    fs.symlinkSync("index.js", path.join(symlinkApplication, "app/apps/server/dist/linked.js"));
    expect(() => stageWindowsPayload({
      applicationPayloadRoot: symlinkApplication,
      payloadRoot: path.join(symlinkRoot, "out"),
      serviceHost: serviceHostFixture(symlinkRoot),
      version: "1.2.3",
      architecture: "x64",
    })).toThrow(/cannot contain symlinks/);

    expect(() => assertWindowsPayloadPathSet(["app/Collision.txt", "app/collision.txt"]))
      .toThrow(/case-insensitive path collision/);

    const reservedRoot = temporaryRoot();
    const reservedApplication = applicationPayloadFixture(reservedRoot);
    writeFixture(reservedApplication, "Service/operator-owned.txt", "do not overwrite");
    expect(() => stageWindowsPayload({
      applicationPayloadRoot: reservedApplication,
      payloadRoot: path.join(reservedRoot, "out"),
      serviceHost: serviceHostFixture(reservedRoot),
      version: "1.2.3",
      architecture: "x64",
    })).toThrow(/installer-reserved path/);

    const browserRoot = temporaryRoot();
    const browserApplication = applicationPayloadFixture(browserRoot);
    writeFixture(browserApplication, "runtime/ms-playwright/ffmpeg-123/ffmpeg.exe", peBytes("x64"));
    expect(() => stageWindowsPayload({
      applicationPayloadRoot: browserApplication,
      payloadRoot: path.join(browserRoot, "out"),
      serviceHost: serviceHostFixture(browserRoot),
      version: "1.2.3",
      architecture: "x64",
    })).toThrow(/disallowed browser runtime/);
  });

  it("rejects a prepared payload without the required architecture-matched native runtimes", () => {
    const root = temporaryRoot();
    const application = applicationPayloadFixture(root, "arm64");
    expect(() => stageWindowsPayload({
      applicationPayloadRoot: application,
      payloadRoot: path.join(root, "out"),
      serviceHost: serviceHostFixture(root, "x64"),
      version: "1.2.3",
      architecture: "x64",
    })).toThrow(/Node.js runtime does not match|service host does not match/);
  });
});

describe("Windows-only WiX command boundary", () => {
  it("blocks before invoking any tool when execution is not native Windows", () => {
    let calls = 0;
    expect(() => buildUnsignedWindowsMsi({
      payloadRoot: "/missing/payload",
      outputDirectory: "/missing/output",
      version: "1.2.3",
      architecture: "x64",
      wixExecutable: "/missing/wix.exe",
      wixProvenance: "/missing/wix.json",
      commandRunner: { run: () => { calls += 1; return { status: 0, stdout: "", stderr: "" }; } },
      platform: "darwin",
    })).toThrow(/must be built on Windows/);
    expect(calls).toBe(0);
  });

  it("executes a pinned WiX v4 tool with argv only and publishes an unsigned checksum", () => {
    const root = temporaryRoot();
    const payloadRoot = stageFixture(root);
    const wix = wixFixture(root);
    const outputDirectory = path.join(root, "artifacts");
    const calls: Array<{ command: string; arguments_: readonly string[]; epoch?: string }> = [];
    let source = "";
    const runner: PackageCommandRunner = {
      run(command, arguments_, options) {
        const epoch = options?.env?.SOURCE_DATE_EPOCH;
        calls.push({ command, arguments_, ...(epoch === undefined ? {} : { epoch }) });
        if (arguments_[0] === "--version") return { status: 0, stdout: `${wix.version}\n`, stderr: "" };
        source = fs.readFileSync(arguments_[1]!, "utf8");
        const outputIndex = arguments_.indexOf("-out");
        const output = arguments_[outputIndex + 1]!;
        fs.writeFileSync(output, Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.from("deterministic-msi-fixture"),
        ]));
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const output = buildUnsignedWindowsMsi({
      payloadRoot,
      outputDirectory,
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      wixExecutable: wix.executable,
      wixProvenance: wix.provenance,
      commandRunner: runner,
      platform: "win32",
    });

    expect(path.basename(output)).toBe("FormaSpec-1.2.3-windows-x64-unsigned.msi");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.arguments_).toEqual(["--version"]);
    expect(calls[1]?.arguments_).toContain("build");
    expect(calls[1]?.arguments_).toContain("-pdbtype");
    expect(calls[1]?.arguments_).toContain(`PayloadRoot=${payloadRoot}`);
    expect(calls[1]?.epoch).toBe("1700000000");
    expect(source).toContain('<Package Name="FormaSpec"');
    expect(fs.readFileSync(`${output}.sha256`, "utf8"))
      .toBe(`${sha256WindowsFile(output)}  ${path.basename(output)}\n`);
  });

  it("fails closed on WiX provenance/version mismatch and removes an invalid MSI output", () => {
    const root = temporaryRoot();
    const payloadRoot = stageFixture(root);
    const wix = wixFixture(root);
    const wrongVersionRunner: PackageCommandRunner = {
      run: () => ({ status: 0, stdout: "4.0.5\n", stderr: "" }),
    };
    expect(() => buildUnsignedWindowsMsi({
      payloadRoot,
      outputDirectory: path.join(root, "wrong-version"),
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      wixExecutable: wix.executable,
      wixProvenance: wix.provenance,
      commandRunner: wrongVersionRunner,
      platform: "win32",
    })).toThrow(/must report exactly version/);

    const outputDirectory = path.join(root, "bad-msi");
    const invalidArtifactRunner: PackageCommandRunner = {
      run(_command, arguments_) {
        if (arguments_[0] === "--version") return { status: 0, stdout: `${wix.version}\n`, stderr: "" };
        const output = arguments_[arguments_.indexOf("-out") + 1]!;
        fs.writeFileSync(output, "not an MSI");
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const expectedOutput = path.join(outputDirectory, "FormaSpec-1.2.3-windows-x64-unsigned.msi");
    expect(() => buildUnsignedWindowsMsi({
      payloadRoot,
      outputDirectory,
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      wixExecutable: wix.executable,
      wixProvenance: wix.provenance,
      commandRunner: invalidArtifactRunner,
      platform: "win32",
    })).toThrow(/compound-file header/);
    expect(fs.existsSync(expectedOutput)).toBe(false);
    expect(fs.existsSync(`${expectedOutput}.sha256`)).toBe(false);
  });

  it("stages, builds, and removes temporary payload state through the standalone Windows entry point", () => {
    const root = temporaryRoot();
    const applicationPayloadRoot = applicationPayloadFixture(root);
    const serviceHost = serviceHostFixture(root);
    const wix = wixFixture(root);
    let transientPayload = "";
    const runner: PackageCommandRunner = {
      run(_command, arguments_) {
        if (arguments_[0] === "--version") return { status: 0, stdout: `${wix.version}\n`, stderr: "" };
        transientPayload = arguments_[arguments_.indexOf("-bindpath") + 1]!;
        const output = arguments_[arguments_.indexOf("-out") + 1]!;
        fs.writeFileSync(output, Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.from("integrated-msi-fixture"),
        ]));
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const output = buildUnsignedWindowsMsiFromApplication({
      applicationPayloadRoot,
      serviceHost,
      outputDirectory: path.join(root, "integrated-output"),
      version: "1.2.3",
      architecture: "x64",
      sourceDateEpoch: 1_700_000_000,
      wixExecutable: wix.executable,
      wixProvenance: wix.provenance,
      commandRunner: runner,
      platform: "win32",
    });
    expect(fs.existsSync(output)).toBe(true);
    expect(transientPayload).toContain("formaspec-windows-msi-");
    expect(fs.existsSync(transientPayload)).toBe(false);
  });

  it("states the remaining native-host, WiX, signing, and Windows lifecycle prerequisites explicitly", () => {
    const summary = windowsMsiPrerequisiteSummary();
    expect(summary).toContain("native Windows");
    expect(summary).toContain(WINDOWS_SERVICE_HOST_CONTRACT);
    expect(summary).toContain("permissive-license provenance");
    expect(summary).toContain("WiX Toolset v4");
    expect(summary).toContain("unsigned");
    expect(summary).toContain("signing lifecycle evidence");
  });
});

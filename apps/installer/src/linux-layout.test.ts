import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LINUX_STATE_ROOT,
  LINUX_RENDERER_STATE_ROOT,
  assertLinuxPackageVersion,
  linuxApiServiceUnit,
  linuxApiWrapper,
  linuxCompatibilityLauncher,
  linuxDebPostInstallScript,
  linuxDebPostRemoveScript,
  linuxDebPreInstallScript,
  linuxDebPreRemoveScript,
  linuxDesktopEntry,
  linuxFormaspecctlWrapper,
  linuxPackageArchitecture,
  linuxRendererServiceUnit,
  linuxRendererWrapper,
  linuxRpmPostInstallScript,
  linuxRpmPostRemoveScript,
  linuxRpmPreInstallScript,
  linuxRpmPreRemoveScript,
  linuxUrlHandler,
  rpmVersion,
} from "./linux-layout.js";

function writeExecutable(filename: string, contents: string): void {
  fs.writeFileSync(filename, contents, { mode: 0o700 });
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filename)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for protocol capture: ${filename}`);
}

describe("native Linux installer layout", () => {
  it("maps only the initially supported package architectures", () => {
    expect(linuxPackageArchitecture("x64", "deb")).toBe("amd64");
    expect(linuxPackageArchitecture("arm64", "deb")).toBe("arm64");
    expect(linuxPackageArchitecture("x64", "rpm")).toBe("x86_64");
    expect(linuxPackageArchitecture("arm64", "rpm")).toBe("aarch64");
    expect(() => linuxPackageArchitecture("riscv64", "deb")).toThrow(/Unsupported/);
  });

  it("uses deterministic RPM ordering for stable and prerelease semantic versions", () => {
    expect(rpmVersion("1.2.3")).toEqual({ version: "1.2.3", release: "1" });
    expect(rpmVersion("1.2.3+build.7")).toEqual({ version: "1.2.3", release: "1.build.7" });
    expect(rpmVersion("1.2.3-rc.1+build-7")).toEqual({
      version: "1.2.3",
      release: "0.rc.1.build_7",
    });
    expect(assertLinuxPackageVersion("0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(() => assertLinuxPackageVersion("1.2.3; touch /tmp/x")).toThrow();
  });

  it("runs both services as a non-root account with loopback and renderer egress boundaries", () => {
    const apiUnit = linuxApiServiceUnit();
    const rendererUnit = linuxRendererServiceUnit();
    expect(apiUnit).toContain("User=formaspec");
    expect(apiUnit).toContain("IPAddressAllow=localhost");
    expect(apiUnit).toContain("Requires=formaspec-renderer.service");
    expect(rendererUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(rendererUnit).toContain("IPAddressDeny=any");
    expect(rendererUnit).not.toContain("IPAddressAllow=");
    expect(`${apiUnit}${rendererUnit}`).toContain("ProtectSystem=strict");
    expect(`${apiUnit}${rendererUnit}`).toContain("NoNewPrivileges=true");
    expect(apiUnit).toContain("ReadWritePaths=/var/lib/formaspec /run/formaspec");
    expect(rendererUnit).toContain(`ReadWritePaths=${LINUX_RENDERER_STATE_ROOT} /run/formaspec`);
    expect(rendererUnit).toContain(`InaccessiblePaths=-${LINUX_STATE_ROOT}`);
    expect(rendererUnit).not.toContain(`ReadWritePaths=${LINUX_STATE_ROOT}`);
    expect(rendererUnit).not.toContain("StateDirectory=formaspec");
  });

  it("pins the packaged runtime and never puts credentials in service configuration", () => {
    const api = linuxApiWrapper();
    const renderer = linuxRendererWrapper();
    expect(api).toContain("APP_MODE=local");
    expect(api).toContain("HOST=127.0.0.1");
    expect(api).toContain("PUBLIC_BASE_URL=http://127.0.0.1:4310");
    expect(api).toContain(`STATE_ROOT='${LINUX_STATE_ROOT}'`);
    expect(api).toContain('mkdir -p "${STATE_ROOT}/data" "${STATE_ROOT}/backups" "${RUNTIME_ROOT}"');
    expect(api).toContain('export HOME="${STATE_ROOT}"');
    expect(api).toContain('DATA_DIR="${STATE_ROOT}/data"');
    expect(api).toContain('BACKUP_DIR="${STATE_ROOT}/backups"');
    expect(renderer).toContain("renderer-worker.js");
    expect(renderer).toContain(`RENDERER_HOME='${LINUX_RENDERER_STATE_ROOT}'`);
    expect(renderer).toContain('mkdir -p "${RENDERER_HOME}" "${RUNTIME_ROOT}"');
    expect(renderer).toContain('export HOME="${RENDERER_HOME}"');
    expect(renderer).not.toContain(LINUX_STATE_ROOT);
    expect(renderer).not.toMatch(/STATE_ROOT|\/data|\/backups/);
    expect(renderer).toContain("FORMASPEC_ALLOW_SYSTEM_CHROME=false");
    expect(`${api}${renderer}`).toContain("services must run as the unprivileged formaspec account");
    expect(`${api}${renderer}`).not.toMatch(/DESIGNER_TOKEN|Bearer |password|OPENAI_API_KEY/i);
  });

  it("uses per-user bridge state while delegating system lifecycle through systemd", () => {
    const cli = linuxFormaspecctlWrapper();
    const launcher = linuxCompatibilityLauncher("0.2.0");
    expect(cli).toContain("XDG_STATE_HOME");
    expect(cli).toContain("FORMASPEC_RUNTIME_DIR");
    expect(cli).toContain('FORMASPEC_DATA_DIR="${FORMASPEC_DATA_DIR:-${SYSTEM_STATE_ROOT}/data}"');
    expect(cli).toContain('FORMASPEC_BACKUP_DIR="${FORMASPEC_BACKUP_DIR:-${SYSTEM_STATE_ROOT}/backups}"');
    expect(cli).toContain("FORMASPEC_LOG_DIR");
    expect(cli).toContain("FORMASPEC_SUPPORT_DIR");
    expect(cli).toContain("apps/cli/dist/index.js");
    expect(launcher).toContain("/usr/bin/systemctl");
    expect(launcher).toContain("/health/ready");
    expect(launcher).toContain("echo 'FormaSpec 0.2.0'");
    expect(launcher).toContain("id -u");
    expect(launcher).toContain("DISPLAY");
  });

  it("registers only secret-free allowlisted protocol actions", () => {
    const handler = linuxUrlHandler();
    expect(linuxDesktopEntry()).toContain("MimeType=x-scheme-handler/formaspec;");
    expect(handler).toContain("formaspec://connect-agent");
    expect(handler).toContain("Unsupported or malformed FormaSpec URL");
    expect(handler).toContain("http://127.0.0.1:4310/administration");
    expect(handler).toContain("--pairing-nonce");
    expect(handler).toContain("--connection-id");
    expect(handler).toContain('[ "${#URL}" -le 512 ]');
    expect(handler).toContain('[ "${#1}" -eq 50 ]');
    expect(handler).toContain('[ "${#1}" -eq 43 ]');
    expect(handler).not.toMatch(/eval|Bearer|token=/);
  });

  it("executes only canonical pairing URLs and forwards exact CLI arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-linux-protocol-"));
    try {
      const cli = path.join(root, "formaspecctl");
      const opener = path.join(root, "xdg-open");
      const script = path.join(root, "formaspec-open");
      const capture = path.join(root, "cli-arguments.txt");
      const openCapture = path.join(root, "open-arguments.txt");
      writeExecutable(cli, '#!/bin/sh\nprintf "%s\\n" "$@" >"${FORMASPEC_PROTOCOL_CAPTURE}"\n');
      writeExecutable(opener, '#!/bin/sh\nprintf "%s\\n" "$@" >"${FORMASPEC_OPEN_CAPTURE}"\n');
      writeExecutable(script, linuxUrlHandler()
        .replace("FORMASPECCTL='/usr/bin/formaspecctl'", `FORMASPECCTL='${cli}'`)
        .replace("XDG_OPEN='/usr/bin/xdg-open'", `XDG_OPEN='${opener}'`));
      const nonce = `fspair_${"n".repeat(43)}`;
      const connectionId = `connection_${"a".repeat(32)}`;
      const environment = {
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: path.join(root, "state"),
        FORMASPEC_PROTOCOL_CAPTURE: capture,
        FORMASPEC_OPEN_CAPTURE: openCapture,
      };
      const accepted = spawnSync("/bin/sh", [
        script,
        `formaspec://connect-agent?connection=${connectionId}&nonce=${nonce}`,
      ], { env: environment, encoding: "utf8" });
      expect(accepted.status, accepted.stderr).toBe(0);
      await waitForFile(capture);
      expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toEqual([
        "agent", "connect", "codex",
        "--pairing-nonce", nonce,
        "--connection-id", connectionId,
        "--yes",
      ]);
      expect(fs.readFileSync(openCapture, "utf8").trim()).toBe("http://127.0.0.1:4310/administration");

      fs.rmSync(capture, { force: true });
      fs.rmSync(openCapture, { force: true });
      const nonceOnly = spawnSync("/bin/sh", [script, `formaspec://connect-agent?nonce=${nonce}`], {
        env: environment,
        encoding: "utf8",
      });
      expect(nonceOnly.status, nonceOnly.stderr).toBe(0);
      await waitForFile(capture);
      expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toEqual([
        "agent", "connect", "codex", "--pairing-nonce", nonce, "--yes",
      ]);

      fs.rmSync(capture, { force: true });
      fs.rmSync(openCapture, { force: true });
      const queryless = spawnSync("/bin/sh", [script, "formaspec://connect-agent"], {
        env: environment,
        encoding: "utf8",
      });
      expect(queryless.status, queryless.stderr).toBe(0);
      expect(fs.existsSync(capture)).toBe(false);
      expect(fs.readFileSync(openCapture, "utf8").trim()).toBe("http://127.0.0.1:4310/administration");

      for (const candidate of [
        `formaspec://connect-agent?nonce=${nonce}&connection=${connectionId}`,
        `formaspec://connect-agent?connection=${connectionId}&nonce=${nonce}&extra=1`,
        `formaspec://connect-agent?connection=${connectionId}&nonce=${nonce}&nonce=${nonce}`,
        `formaspec://connect-agent?connection=connection_${"A".repeat(32)}&nonce=${nonce}`,
        "formaspec://connect-agent?nonce=fspair_short",
        `formaspec://connect-agent?nonce=${nonce}%3Bopen`,
        `formaspec://connect-agent?nonce=${nonce}\ncontrol`,
        `formaspec://connect-agent?nonce=${"n".repeat(600)}`,
      ]) {
        const rejected = spawnSync("/bin/sh", [script, candidate], { env: environment, encoding: "utf8" });
        expect(rejected.status, candidate).toBe(2);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses unmanaged paths, requires systemd, and preserves state on removal", () => {
    const preinstall = linuxDebPreInstallScript();
    const postinstall = linuxDebPostInstallScript();
    const debRemoval = linuxDebPostRemoveScript();
    const rpmRemoval = linuxRpmPostRemoveScript();
    expect(preinstall).toContain("Refusing to replace an unmanaged /opt/formaspec directory");
    expect(preinstall).toContain("Existing formaspec account is incompatible");
    expect(postinstall).toContain("requires a running systemd system instance");
    expect(postinstall).not.toMatch(/xdg-open|open http/);
    expect(debRemoval).toContain(`${LINUX_STATE_ROOT}/data`);
    expect(debRemoval).toContain(`${LINUX_STATE_ROOT}/backups`);
    expect(rpmRemoval).toContain(`${LINUX_STATE_ROOT}/data`);
    expect(`${debRemoval}${rpmRemoval}`).not.toMatch(/rm\s+-rf|userdel|groupdel/);
  });

  it("emits shell-syntax-valid wrappers and lifecycle scripts", () => {
    for (const script of [
      linuxApiWrapper(),
      linuxRendererWrapper(),
      linuxFormaspecctlWrapper(),
      linuxCompatibilityLauncher("0.2.0"),
      linuxUrlHandler(),
      linuxDebPreInstallScript(),
      linuxDebPostInstallScript(),
      linuxDebPreRemoveScript(),
      linuxDebPostRemoveScript(),
      linuxRpmPreInstallScript(),
      linuxRpmPostInstallScript(),
      linuxRpmPreRemoveScript(),
      linuxRpmPostRemoveScript(),
    ]) {
      const result = spawnSync("/bin/sh", ["-n"], { encoding: "utf8", input: script, shell: false });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});

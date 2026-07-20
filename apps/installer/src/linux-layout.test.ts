import { spawnSync } from "node:child_process";

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
    expect(handler).not.toMatch(/eval|Bearer|--yes|token=/);
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

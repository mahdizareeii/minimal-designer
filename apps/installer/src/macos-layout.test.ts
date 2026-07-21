import { describe, expect, it } from "vitest";

import {
  MACOS_API_LABEL,
  MACOS_INSTALL_ROOT,
  MACOS_RENDERER_LABEL,
  apiWrapper,
  applicationInfoPlist,
  assertPackageVersion,
  compatibilityLauncher,
  formaspecctlWrapper,
  launchAgentPlist,
  postinstallScript,
  preinstallScript,
  protocolHandler,
  rendererWrapper,
} from "./macos-layout.js";

describe("unsigned macOS installer layout", () => {
  it("uses loopback services, a networkless renderer contract, and user-owned data paths", () => {
    const api = apiWrapper();
    const renderer = rendererWrapper();
    expect(api).toContain("HOST=127.0.0.1");
    expect(api).toContain("PUBLIC_BASE_URL=http://127.0.0.1:4310");
    expect(api).toContain("FORMASPEC_RENDER_SOCKET");
    expect(renderer).toContain("renderer-worker.js");
    expect(renderer).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(renderer).toContain("FORMASPEC_ALLOW_SYSTEM_CHROME=false");
    expect(`${api}${renderer}`).not.toMatch(/DESIGNER_TOKEN|Bearer |\/Users\//);
  });

  it("installs stable LaunchAgents, a packaged CLI, and the secret-free formaspec URL scheme", () => {
    const apiPlist = launchAgentPlist(MACOS_API_LABEL, `${MACOS_INSTALL_ROOT}/bin/formaspec-api`);
    const rendererPlist = launchAgentPlist(MACOS_RENDERER_LABEL, `${MACOS_INSTALL_ROOT}/bin/formaspec-renderer`);
    expect(apiPlist).toContain("<key>RunAtLoad</key><true/>");
    expect(rendererPlist).toContain("<key>KeepAlive</key><true/>");
    const cli = formaspecctlWrapper();
    for (const variable of [
      "FORMASPEC_RUNTIME_DIR",
      "FORMASPEC_DATA_DIR",
      "FORMASPEC_BACKUP_DIR",
      "FORMASPEC_LOG_DIR",
      "FORMASPEC_SUPPORT_DIR",
    ]) expect(cli).toContain(variable);
    expect(cli).toContain("Library/Application Support/FormaSpec");
    const launcher = compatibilityLauncher("1.2.3");
    expect(launcher).toContain("/health/ready");
    expect(launcher).toContain("echo 'FormaSpec 1.2.3'");
    expect(applicationInfoPlist("0.2.0")).toContain("<string>formaspec</string>");
    expect(protocolHandler()).toContain("agent connect codex --yes");
    expect(preinstallScript()).toContain("Refusing to replace an unmanaged");
    expect(postinstallScript()).toContain("launchctl bootstrap");
  });

  it("rejects unsafe package versions and LaunchAgent paths", () => {
    expect(assertPackageVersion("1.2.3")).toBe("1.2.3");
    expect(() => assertPackageVersion("1.2.3; touch /tmp/x")).toThrow();
    expect(() => launchAgentPlist("com.attacker.service", "/tmp/service")).toThrow();
  });
});

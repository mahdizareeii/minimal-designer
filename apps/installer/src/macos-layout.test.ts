import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    expect(launcher).toContain('doctor|status|start|stop|restart) exec "${INSTALL_ROOT}/bin/formaspecctl"');
    expect(launcher).toContain('FORMASPEC_LEGACY_DELEGATE:-0');
    expect(launcher).toContain("echo 'FormaSpec 1.2.3'");
    expect(applicationInfoPlist("0.2.0")).toContain("<string>formaspec</string>");
    const handler = protocolHandler();
    expect(handler).toContain("agent connect codex --yes");
    expect(handler).toContain("--pairing-nonce");
    expect(handler).toContain("--connection-id");
    expect(handler).toContain('[ "${#URL}" -le 512 ]');
    expect(handler).toContain('[ "${#1}" -eq 50 ]');
    expect(handler).toContain('[ "${#1}" -eq 43 ]');
    expect(preinstallScript()).toContain("Refusing to replace an unmanaged");
    expect(postinstallScript()).toContain("launchctl bootstrap");
  });

  it("rejects unsafe package versions and LaunchAgent paths", () => {
    expect(assertPackageVersion("1.2.3")).toBe("1.2.3");
    expect(() => assertPackageVersion("1.2.3; touch /tmp/x")).toThrow();
    expect(() => launchAgentPlist("com.attacker.service", "/tmp/service")).toThrow();
  });

  it("executes only canonical pairing URLs and forwards exact CLI arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-macos-protocol-"));
    try {
      const cli = path.join(root, "formaspecctl");
      const opener = path.join(root, "open");
      const script = path.join(root, "formaspec-open");
      const capture = path.join(root, "cli-arguments.txt");
      const openCapture = path.join(root, "open-arguments.txt");
      writeExecutable(cli, '#!/bin/sh\nprintf "%s\\n" "$@" >"${FORMASPEC_PROTOCOL_CAPTURE}"\n');
      writeExecutable(opener, '#!/bin/sh\nprintf "%s\\n" "$@" >"${FORMASPEC_OPEN_CAPTURE}"\n');
      writeExecutable(script, protocolHandler()
        .replace("FORMASPECCTL='/usr/local/bin/formaspecctl'", `FORMASPECCTL='${cli}'`)
        .replace("OPEN='/usr/bin/open'", `OPEN='${opener}'`));
      const nonce = `fspair_${"n".repeat(43)}`;
      const connectionId = `connection_${"a".repeat(32)}`;
      const environment = {
        ...process.env,
        HOME: root,
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
      expect(fs.readFileSync(openCapture, "utf8").trim()).toBe("http://127.0.0.1:4310");

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
      const queryless = spawnSync("/bin/sh", [script, "formaspec://connect-agent"], {
        env: environment,
        encoding: "utf8",
      });
      expect(queryless.status, queryless.stderr).toBe(0);
      await waitForFile(capture);
      expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toEqual([
        "agent", "connect", "codex", "--yes",
      ]);

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
});

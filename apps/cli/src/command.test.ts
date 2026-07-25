import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackupVerification } from "./backup.js";
import { FORMASPEC_ESSENTIAL_MCP_TOOLS, type BridgeController } from "./bridge-lifecycle.js";
import { FORMASPEC_MCP_CONTRACT_VERSION } from "./codex.js";
import { runCli, type CliIo, type EnsureRunningResult } from "./command.js";
import {
  persistDockerRuntimeBinding,
  type DockerComposeBindingLabels,
  type DockerRuntimeBinding,
} from "./docker-runtime-binding.js";
import { CLI_SUPPORTED_DATABASE_VERSION } from "./migrations.js";
import type { CommandOptions } from "./process.js";

const temporaryDirectories: string[] = [];
const TEST_DATA_STORE_ID = `store_${"a".repeat(32)}`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeBridge(): BridgeController & {
  starts: number;
  stops: number;
  authorizations: number;
  running: boolean;
  upstreamOrigin: string;
  upstreamReady: boolean;
  dataStoreId: string;
  serverVersion: string;
  verificationError?: Error;
  pairingTickets: Array<{ nonce: string; connectionId?: string } | undefined>;
} {
  return {
    starts: 0,
    stops: 0,
    authorizations: 0,
    running: false,
    upstreamOrigin: "http://127.0.0.1:4310",
    upstreamReady: true,
    dataStoreId: TEST_DATA_STORE_ID,
    serverVersion: FORMASPEC_MCP_CONTRACT_VERSION,
    pairingTickets: [],
    async ensureStarted() {
      this.starts += 1;
      this.running = true;
      return {
        running: true,
        url: "http://127.0.0.1:4312",
        owned: true,
        upstreamOrigin: this.upstreamOrigin,
        upstreamReady: this.upstreamReady,
        dataStoreId: this.dataStoreId,
      };
    },
    async authorizeAgent(pairing) {
      this.authorizations += 1;
      this.pairingTickets.push(pairing);
      return { connectionId: "connection_test", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
    async verifyAgent() {
      if (this.verificationError) throw this.verificationError;
      return {
        verified: true as const,
        checks: ["initialize", "tools/list"],
        serverName: "formaspec" as const,
        serverVersion: this.serverVersion,
        essentialTools: [...FORMASPEC_ESSENTIAL_MCP_TOOLS],
        upstreamOrigin: this.upstreamOrigin,
        dataStoreId: this.dataStoreId,
      };
    },
    async stop() { this.stops += 1; this.running = false; return true; },
    async status() {
      return {
        running: this.running,
        url: "http://127.0.0.1:4312",
        owned: this.running,
        upstreamOrigin: this.running ? this.upstreamOrigin : null,
        upstreamReady: this.running && this.upstreamReady,
        dataStoreId: this.running ? this.dataStoreId : null,
      };
    },
  };
}

function recordProxyServerRuntime(root: string, publicUrl = "https://design.company.example"): void {
  const runtimeDirectory = path.join(root, ".designer");
  const runDirectory = path.join(runtimeDirectory, "run");
  const environmentDirectory = path.join(runtimeDirectory, "env");
  const environmentFile = path.join(environmentDirectory, "server.env");
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.mkdirSync(environmentDirectory, { recursive: true });
  fs.writeFileSync(environmentFile, [
    "DESIGNER_SERVER_ACCESS=proxy",
    "APP_MODE=server",
    `PUBLIC_BASE_URL=${publicUrl}`,
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(path.join(runDirectory, "mode"), "server\n");
  fs.writeFileSync(path.join(runDirectory, "api-port"), "7443\n");
  fs.writeFileSync(path.join(runDirectory, "url"), `${publicUrl}\n`);
  fs.writeFileSync(path.join(runDirectory, "env-file"), `${environmentFile}\n`);
}

function backupVerification(migrationVersion = 10): BackupVerification {
  return {
    valid: true,
    manifest: {
      format: "formaspec-backup",
      formatVersion: 1,
      createdAt: "2026-07-19T00:00:00.000Z",
      applicationBuildVersion: "0.2.0",
      databaseSchemaVersion: migrationVersion,
      documentSchemaVersion: 2,
      commandEngineVersion: "1",
      rendererVersion: "1",
      fontBundleVersion: "1",
      files: [],
    },
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    migrationVersion,
    entryCount: 3,
    expandedBytes: 1024,
    bundleSizeBytes: 512,
    bundleSha256: "a".repeat(64),
  };
}

function writeMigrationDatabase(filename: string, version = 10): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (let current = 1; current <= version; current += 1) {
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(current, `migration_${current}`, "2026-01-01T00:00:00.000Z");
  }
  sqlite.close();
}

function collectingIo(): CliIo & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (message) => output.push(message), stderr: (message) => errors.push(message), isInteractive: false };
}

function ensureRunningJson(io: ReturnType<typeof collectingIo>): EnsureRunningResult {
  expect(io.errors).toEqual([]);
  expect(io.output).toHaveLength(1);
  return JSON.parse(io.output[0]!) as EnsureRunningResult;
}

function makeProject(root: string): string {
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const launcher = path.join(root, "designer");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return root;
}

function recordRuntime(
  root: string,
  mode: "local" | "dev" | "docker" | "server",
  apiPort: number,
  webPort: number,
  url: string,
): void {
  const runDirectory = path.join(root, ".designer", "run");
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(runDirectory, "mode"), `${mode}\n`);
  fs.writeFileSync(path.join(runDirectory, "api-port"), `${apiPort}\n`);
  fs.writeFileSync(path.join(runDirectory, "web-port"), `${webPort}\n`);
  fs.writeFileSync(path.join(runDirectory, "url"), `${url}\n`);
}

function persistKnownDockerBinding(root: string, port: number): void {
  const imageId = `sha256:${"c".repeat(64)}`;
  const labels = <Service extends "designer" | "renderer">(
    service: Service,
    configHash: string,
  ): DockerComposeBindingLabels & { service: Service } => ({
    project: "minimalappdesigner",
    service,
    oneoff: "False",
    containerNumber: "1",
    configHash,
    imageId,
    workingDirectory: root,
    configFile: path.join(root, "docker-compose.yml"),
    composeVersion: "2.35.0",
  });
  persistDockerRuntimeBinding(root, {
    format: "formaspec-docker-runtime-binding",
    version: 2,
    capturedAt: "2026-07-22T00:00:00.000Z",
    context: "desktop-linux",
    daemonId: "daemon-fixture-0123456789",
    composeProject: "minimalappdesigner",
    imageId,
    containers: { designer: "a".repeat(64), renderer: "b".repeat(64) },
    labels: {
      designer: labels("designer", "d".repeat(64)),
      renderer: labels("renderer", "e".repeat(64)),
    },
    volumes: {
      data: "minimalappdesigner_designer-data",
      backups: "minimalappdesigner_designer-backups",
      rendererSocket: "minimalappdesigner_renderer-socket",
    },
    renderer: { networkMode: "none" },
    publicBinding: {
      host: "127.0.0.1",
      port,
      containerPort: 4310,
      origin: `http://127.0.0.1:${port}`,
    },
    runtime: {
      mode: "docker",
      serverAccess: "none",
      healthHostHeader: `127.0.0.1:${port}`,
      environmentIdentitySha256: "f".repeat(64),
    },
  });
}

function writeFormaSpecManagedMarker(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ".formaspec-managed.json"), JSON.stringify({
    manager: "formaspecctl",
    schemaVersion: 1,
    installedAt: "2026-07-01T00:00:00.000Z",
  }));
}

function installFakeCodex(bin: string, log: string, state: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
if [ "$1" = "--version" ]; then printf 'codex-cli 1.0\\n'; exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  printf '%s' "$5" > "$FAKE_CODEX_STATE"
  mkdir -p "$(dirname "$FAKE_CODEX_CONFIG")"
  if [ -f "$FAKE_CODEX_CONFIG" ]; then printf '\n[mcp_servers.formaspec]\nurl = "%s"\n' "$5" >> "$FAKE_CODEX_CONFIG"
  else printf '[mcp_servers.formaspec]\nurl = "%s"\n' "$5" > "$FAKE_CODEX_CONFIG"; fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  [ -f "$FAKE_CODEX_STATE" ] || exit 1
  url=$(sed -n '1p' "$FAKE_CODEX_STATE")
  if [ "$4" = "--json" ]; then
    transport_type="$FAKE_CODEX_MCP_TRANSPORT_TYPE"
    [ -n "$transport_type" ] || transport_type="streamable_http"
    if [ -n "$FAKE_CODEX_MCP_BEARER_ENV" ]; then
      printf '{"name":"formaspec","transport":{"type":"%s","url":"%s","bearer_token_env_var":"%s","http_headers":null,"env_http_headers":null}}\\n' "$transport_type" "$url" "$FAKE_CODEX_MCP_BEARER_ENV"
    else
      printf '{"name":"formaspec","transport":{"type":"%s","url":"%s","bearer_token_env_var":null,"http_headers":null,"env_http_headers":null}}\\n' "$transport_type" "$url"
    fi
  else
    printf 'formaspec %s\\n' "$url"
  fi
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "list" ]; then
  printf '{"marketplaces":[]}\n'
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  if [ "$FAKE_CODEX_FAIL_PLUGIN_LIST" = "1" ]; then exit 8; fi
  if [ -f "$FAKE_CODEX_PLUGIN_STATE" ]; then cat "$FAKE_CODEX_PLUGIN_STATE"
  else printf '{"installed":[]}\n'; fi
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "add" ]; then
  if [ -f "$FAKE_CODEX_PLUGIN_STATE" ] && grep -q 'minimal-ui@formaspec' "$FAKE_CODEX_PLUGIN_STATE"; then
    printf '{"installed":[{"pluginId":"formaspec@formaspec","version":"0.4.0","installed":true,"enabled":true},{"pluginId":"minimal-ui@formaspec","version":"0.2.2","installed":true,"enabled":true}]}\n' > "$FAKE_CODEX_PLUGIN_STATE"
  else
    printf '{"installed":[{"pluginId":"formaspec@formaspec","version":"0.4.0","installed":true,"enabled":true}]}\n' > "$FAKE_CODEX_PLUGIN_STATE"
  fi
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "remove" ]; then
  [ "$FAKE_CODEX_FAIL_PLUGIN_REMOVE" = "1" ] && exit 9
  printf '{"installed":[{"pluginId":"formaspec@formaspec","version":"0.4.0","installed":true,"enabled":true}]}\n' > "$FAKE_CODEX_PLUGIN_STATE"
  exit 0
fi
exit 2
`, { mode: 0o755 });
  fs.writeFileSync(log, "");
  fs.rmSync(state, { force: true });
}

function fakeEnvironment(root: string, bin: string, log: string, state: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_STATE: state,
    FAKE_CODEX_PLUGIN_STATE: `${state}.plugins`,
    FAKE_CODEX_CONFIG: path.join(root, ".codex", "config.toml"),
  };
}

describe("formaspecctl", () => {
  it("prints one state-aware start action instead of the full command reference with no arguments", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();

    expect(await runCli([], { projectRoot: root, environment: {}, io })).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.output).toEqual([
      "Next action: Run 'formaspecctl install docker' to create and start your first FormaSpec workspace.",
      "Website: http://127.0.0.1:4310 (available after startup)",
    ]);
    expect(io.output.join("\n")).not.toContain("Usage:");
  });

  it("points no-argument users to the ready recorded workspace", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    recordRuntime(root, "docker", 4310, 4310, "http://127.0.0.1:4310");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      dataStoreId: TEST_DATA_STORE_ID,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await runCli([], { projectRoot: root, environment: {}, io })).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.output).toEqual([
      "Next action: Open the ready FormaSpec workspace and choose a Product and Design.",
      "Website: http://127.0.0.1:4310",
    ]);
  });

  it("reads migration status from the recorded local database only in local or dev mode", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    recordRuntime(root, "local", 4310, 4311, "http://127.0.0.1:4311");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"), CLI_SUPPORTED_DATABASE_VERSION);

    expect(await runCli(["migrate", "status", "--json"], { projectRoot: root, environment: {}, io })).toBe(0);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      source: "database",
      mode: "local",
      latestAppliedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      state: "current",
    });
  });

  it("queries the live recorded Docker runtime and never opens an inactive local SQLite file", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    const bridge = fakeBridge();
    bridge.running = true;
    recordRuntime(root, "docker", 4310, 4310, "http://127.0.0.1:4310");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"), 1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      dataStoreId: TEST_DATA_STORE_ID,
      migrations: CLI_SUPPORTED_DATABASE_VERSION,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await runCli(["migrate", "status", "--json"], {
      projectRoot: root,
      bridge,
      environment: {},
      io,
    })).toBe(0);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output[0]!)).toEqual({
      source: "runtime",
      mode: "docker",
      origin: "http://127.0.0.1:4310",
      dataStoreId: TEST_DATA_STORE_ID,
      databasePath: null,
      latestAppliedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      supportedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      state: "current",
      migrations: [],
    });
  });

  it("blocks Docker migration inspection when the recorded runtime is stopped even if local SQLite exists", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    const bridge = fakeBridge();
    bridge.running = true;
    recordRuntime(root, "docker", 4310, 4310, "http://127.0.0.1:4310");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"), CLI_SUPPORTED_DATABASE_VERSION);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    expect(await runCli(["migrate", "status"], {
      projectRoot: root,
      bridge,
      environment: {},
      io,
    })).toBe(1);
    expect(io.output).toEqual([]);
    expect(io.errors.join("\n")).toContain("recorded docker runtime is stopped or unreachable");
    expect(io.errors.join("\n")).toContain("inactive local SQLite file was not inspected");
  });

  it("blocks Docker migration inspection when no owned bridge pins the expected store", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    const bridge = fakeBridge();
    recordRuntime(root, "docker", 4310, 4310, "http://127.0.0.1:4310");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"), CLI_SUPPORTED_DATABASE_VERSION);
    const fetch = vi.spyOn(globalThis, "fetch");

    expect(await runCli(["migrate", "status"], {
      projectRoot: root,
      bridge,
      environment: {},
      io,
    })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(io.output).toEqual([]);
    expect(io.errors.join("\n")).toContain("no currently owned FormaSpec bridge pins");
    expect(io.errors.join("\n")).toContain("formaspecctl ensure-running --json");
    expect(io.errors.join("\n")).toContain("inactive local SQLite file was not inspected");
  });

  it("blocks Docker migration inspection when live and bridge-pinned stores differ", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    const bridge = fakeBridge();
    bridge.running = true;
    recordRuntime(root, "docker", 4310, 4310, "http://127.0.0.1:4310");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"), CLI_SUPPORTED_DATABASE_VERSION);
    const unexpectedDataStoreId = `store_${"b".repeat(32)}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      dataStoreId: unexpectedDataStoreId,
      migrations: CLI_SUPPORTED_DATABASE_VERSION,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await runCli(["migrate", "status"], {
      projectRoot: root,
      bridge,
      environment: {},
      io,
    })).toBe(1);
    expect(io.output).toEqual([]);
    expect(io.errors.join("\n")).toContain(`reports data store ${unexpectedDataStoreId}`);
    expect(io.errors.join("\n")).toContain(`bridge is pinned to ${TEST_DATA_STORE_ID}`);
    expect(io.errors.join("\n")).toContain("inactive local SQLite file was not inspected");
  });

  it("queries a recorded proxy-server runtime without requiring the intentionally disabled local bridge", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    const bridge = fakeBridge();
    recordProxyServerRuntime(root);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      dataStoreId: TEST_DATA_STORE_ID,
      migrations: CLI_SUPPORTED_DATABASE_VERSION,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await runCli(["migrate", "status", "--json"], {
      projectRoot: root,
      bridge,
      environment: {},
      io,
    })).toBe(0);
    expect(bridge.running).toBe(false);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      source: "runtime",
      mode: "server",
      origin: "http://127.0.0.1:7443",
      dataStoreId: TEST_DATA_STORE_ID,
      latestAppliedVersion: CLI_SUPPORTED_DATABASE_VERSION,
    });
  });

  it("requires authorization before changing Codex", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const bridge = fakeBridge();
    const io = collectingIo();
    let confirmation = "";
    const result = await runCli(["agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      confirm: async (message) => { confirmation = message; return false; },
      environment: fakeEnvironment(root, bin, log, state),
    });
    expect(result).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(fs.existsSync(path.join(root, ".codex", "skills", "formaspec"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex", "skills", "minimal-ui"))).toBe(false);
    expect(fs.readFileSync(log, "utf8").trim()).toBe("--version");
    expect(confirmation).toContain("single managed FormaSpec plugin");
    expect(confirmation).toContain("Allow FormaSpec once");
    expect(confirmation).toContain("automatic FormaSpec tool approval");
    expect(confirmation).toContain("Global Codex approval and sandbox settings will not be changed");
    expect(confirmation).toContain("remove installer-owned legacy duplicate identities");
  });

  it("configures token-free FormaSpec MCP and installs one managed plugin identity", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      'model = "test-model"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[mcp_servers.unrelated]",
      'url = "http://127.0.0.1:9999/mcp"',
      'default_tools_approval_mode = "writes"',
      "",
    ].join("\n"));
    const bridge = fakeBridge();
    const io = collectingIo();
    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    });
    expect(result).toBe(0);
    expect(bridge.starts).toBe(1);
    expect(bridge.authorizations).toBe(1);
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).toContain("mcp add formaspec --url http://127.0.0.1:4312/mcp");
    expect(calls).toContain("mcp get formaspec\n");
    expect(calls).toContain("plugin marketplace add");
    expect(calls).toContain("plugin add formaspec@formaspec --json");
    expect(calls).not.toContain("plugin add minimal-ui@formaspec --json");
    expect(calls).not.toContain("plugin remove minimal-ui@formaspec --json");
    expect(calls.toLowerCase()).not.toContain("bearer");
    expect(calls.toLowerCase()).not.toContain("token");
    const codexConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain('model = "test-model"');
    expect(codexConfig).toContain('[mcp_servers.formaspec]');
    expect(codexConfig).toContain('approval_policy = "on-request"');
    expect(codexConfig).toContain('sandbox_mode = "workspace-write"');
    expect(codexConfig).toContain('[mcp_servers.unrelated]\nurl = "http://127.0.0.1:9999/mcp"\ndefault_tools_approval_mode = "writes"');
    expect(codexConfig).toContain('[mcp_servers.formaspec]');
    expect(codexConfig).toContain('default_tools_approval_mode = "approve"');
    expect(codexConfig.toLowerCase()).not.toContain("bearer");
    expect(fs.existsSync(path.join(root, ".codex", "skills", "formaspec"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex", "skills", "minimal-ui"))).toBe(false);
    const skill = fs.readFileSync(
      path.join(root, ".codex", "formaspec-marketplace", "plugins", "formaspec", "skills", "formaspec", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("Use FormaSpec");
    expect(skill).toContain("Design this with FormaSpec");
    expect(skill).toContain("Refine this selection with FormaSpec");
    expect(skill).toContain("Redesign this with FormaSpec");
    expect(skill).toContain("For one proven accessible project");
    expect(skill).toContain("ask for confirmation");
    expect(skill).toContain("`nextCursor` is null");
    expect(skill).toContain("recommend `./designer doctor auto`");
    expect(skill).toContain("`formaspecctl ensure-running --json`");
    expect(skill).toContain("retry MCP initialize once");
    expect(skill).toContain("Never choose by list order");
    const marketplace = path.join(root, ".codex", "formaspec-marketplace");
    expect(JSON.parse(fs.readFileSync(path.join(marketplace, ".agents", "plugins", "marketplace.json"), "utf8"))).toMatchObject({
      name: "formaspec",
      plugins: [
        { name: "formaspec", source: { path: "./plugins/formaspec" } },
      ],
    });
    expect(JSON.parse(fs.readFileSync(path.join(marketplace, "plugins", "formaspec", ".codex-plugin", "plugin.json"), "utf8"))).toMatchObject({
      name: "formaspec",
      version: "0.4.0",
      interface: { displayName: "FormaSpec" },
    });
    expect(fs.existsSync(path.join(marketplace, "plugins", "minimal-ui"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${state}.plugins`, "utf8"))).toEqual({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    });
    expect(io.output.join("\n")).toContain("[@FormaSpec](plugin://formaspec@formaspec)");
    expect(io.output.join("\n")).toContain("Codex mention: [@FormaSpec]");
    expect(io.output.join("\n")).toContain("trusted for this local server only");
    expect(io.output.join("\n")).toContain("global Codex approval and sandbox settings were preserved");
    expect(io.output.join("\n")).toContain("Use FormaSpec in a new Codex task so it loads the updated single identity.");
    expect(io.output.join("\n")).not.toContain("[@Minimal UI]");
    const approvalConfig = [
      'basic_approval_example = """',
      "[mcp_servers.formaspec]",
      'default_tools_approval_mode = "never"',
      '"""',
      "",
      "literal_approval_example = '''",
      "[mcp_servers.formaspec]",
      'default_tools_approval_mode = "never"',
      "'''",
      "",
      codexConfig
        .replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "never"')
        .replace("[mcp_servers.formaspec]", "[mcp_servers.formaspec] # managed FormaSpec MCP"),
    ].join("\n");
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), approvalConfig);
    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(0);
    const reconnectedConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(reconnectedConfig.match(/default_tools_approval_mode = "approve"/g)).toHaveLength(1);
    expect(reconnectedConfig.match(/default_tools_approval_mode = "writes"/g)).toHaveLength(1);
    expect(reconnectedConfig).toContain("[mcp_servers.formaspec] # managed FormaSpec MCP");
    expect(reconnectedConfig).toContain('basic_approval_example = """\n[mcp_servers.formaspec]\ndefault_tools_approval_mode = "never"');
    expect(reconnectedConfig).toContain("literal_approval_example = '''\n[mcp_servers.formaspec]\ndefault_tools_approval_mode = \"never\"");

    const quotedApprovalConfig = reconnectedConfig
      .replace(
        "[mcp_servers.formaspec] # managed FormaSpec MCP",
        '[mcp_servers.formaspec] # managed FormaSpec MCP\n# "default_tools_approval_mode" = "never" — comment only',
      )
      .replace(
        'default_tools_approval_mode = "approve"',
        '"default_tools_approval_mode" = "writes" # preserve this approval comment',
      );
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), quotedApprovalConfig);
    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(0);
    const repairedQuotedConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(repairedQuotedConfig).toContain(
      '"default_tools_approval_mode" = "approve" # preserve this approval comment',
    );
    expect(repairedQuotedConfig).toContain(
      '# "default_tools_approval_mode" = "never" — comment only',
    );
    expect(repairedQuotedConfig).not.toContain('\ndefault_tools_approval_mode = "approve"\n');

    const duplicateApprovalConfig = repairedQuotedConfig.replace(
      '"default_tools_approval_mode" = "approve" # preserve this approval comment',
      [
        '"default_tools_approval_mode" = "approve" # preserve this approval comment',
        "'default_tools_approval_mode' = 'never' # semantic duplicate",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), duplicateApprovalConfig);
    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(1);
    expect(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8")).toBe(duplicateApprovalConfig);
    expect(io.errors.at(-1)).toContain("Codex FormaSpec MCP approval policy is duplicated");
  });

  it("refuses to apply local automatic approval to a remote MCP bridge", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const configPath = path.join(root, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'approval_policy = "on-request"\n');
    const bridge = fakeBridge();
    bridge.ensureStarted = async () => ({
      running: true,
      url: "https://design.company.example",
      owned: true,
      upstreamOrigin: bridge.upstreamOrigin,
      upstreamReady: true,
      dataStoreId: bridge.dataStoreId,
    });
    const io = collectingIo();

    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(1);
    expect(fs.readFileSync(configPath, "utf8")).toBe('approval_policy = "on-request"\n');
    expect(fs.readFileSync(log, "utf8").trim()).toBe("--version");
    expect(bridge.authorizations).toBe(0);
    expect(io.errors.join("\n")).toContain("Refusing to configure automatic FormaSpec tool approval");
    expect(io.errors.join("\n")).toContain("non-loopback");
  });

  it("passes a validated browser-issued pairing ticket to the bridge without printing it", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), 'model = "test-model"\n');
    const bridge = fakeBridge();
    const io = collectingIo();
    const nonce = `fspair_${"n".repeat(43)}`;
    const connectionId = `connection_${"a".repeat(32)}`;

    const result = await runCli([
      "--yes", "agent", "connect", "codex",
      "--pairing-nonce", nonce,
      "--connection-id", connectionId,
    ], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    });

    expect(result).toBe(0);
    expect(bridge.pairingTickets).toEqual([{ nonce, connectionId }]);
    expect([...io.output, ...io.errors].join("\n")).not.toContain(nonce);
  });

  it("does not consume a pairing ticket until Codex configuration and plugins verify", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const bridge = fakeBridge();
    const io = collectingIo();
    const nonce = `fspair_${"n".repeat(43)}`;
    const environment = {
      ...fakeEnvironment(root, bin, log, state),
      FAKE_CODEX_FAIL_PLUGIN_LIST: "1",
    };

    const result = await runCli([
      "--yes", "agent", "connect", "codex",
      "--pairing-nonce", nonce,
      "--connection-id", `connection_${"a".repeat(32)}`,
    ], { projectRoot: root, bridge, io, environment });

    expect(result).toBe(1);
    expect(bridge.starts).toBe(1);
    expect(bridge.authorizations).toBe(0);
    expect(bridge.pairingTickets).toEqual([]);
    expect(io.errors.join("\n")).toContain("could not inspect installed plugins");
    expect([...io.output, ...io.errors].join("\n")).not.toContain(nonce);
  });

  it("rejects malformed pairing options before starting the bridge or changing Codex", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();

    expect(await runCli([
      "--yes", "agent", "connect", "codex", "--pairing-nonce", "fspair_short",
    ], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    })).toBe(1);
    expect(await runCli([
      "--yes", "agent", "connect", "codex", "--connection-id", `connection_${"a".repeat(32)}`,
    ], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    })).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(bridge.authorizations).toBe(0);
  });

  it("does not overwrite an unmanaged FormaSpec skill", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const skill = path.join(root, ".codex", "skills", "formaspec");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "user-owned\n");
    const bridge = fakeBridge();
    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment: fakeEnvironment(root, bin, log, state),
    });
    expect(result).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8")).toBe("user-owned\n");
  });

  it("repairs a disabled or stale FormaSpec plugin and verifies one identity", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{ pluginId: "formaspec@formaspec", version: "0.2.0", installed: true, enabled: false }],
    }));

    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: collectingIo(),
      environment: fakeEnvironment(root, bin, log, state),
    });

    expect(result).toBe(0);
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).toContain("plugin add formaspec@formaspec --json");
    expect(calls).not.toContain("plugin add minimal-ui@formaspec --json");
    expect(JSON.parse(fs.readFileSync(`${state}.plugins`, "utf8"))).toEqual({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    });
  });

  it("removes exact legacy plugin tables after Codex removal without editing strings, prefixes, or unrelated TOML", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const marketplace = path.join(root, ".codex", "formaspec-marketplace");
    writeFormaSpecManagedMarker(marketplace);
    const configPath = path.join(root, ".codex", "config.toml");
    fs.writeFileSync(configPath, [
      'basic_example = """',
      '[plugins."minimal-ui@formaspec"]',
      'inside_basic = "preserve this header-like text"',
      '"""',
      "",
      "literal_example = '''",
      '[[plugins."minimal-ui@formaspec".connections]]',
      "inside_literal = 'preserve this array-header-like text'",
      "'''",
      "",
      '[plugins."minimal-ui@formaspec-extra"] # similarly prefixed plugin',
      'prefix_parent = "preserve"',
      "",
      '[[plugins."minimal-ui@formaspec-extra".connections]] # similarly prefixed array table',
      'prefix_array = "preserve"',
      "",
      '[plugins."minimal-ui@formaspec"] # managed legacy parent',
      'alias_parent = "preserve"',
      "",
      '[[plugins."minimal-ui@formaspec".connections]] # managed legacy descendant array',
      'alias_array = "preserve"',
      "",
      '[plugins."minimal-ui@formaspec".mcp_servers.formaspec] # managed legacy descendant',
      'alias_descendant = "preserve"',
      "",
      '[plugins."unrelated@company"] # unrelated table',
      'unrelated = "preserve"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.2.0", installed: true, enabled: true },
        { pluginId: "minimal-ui@formaspec", version: "0.2.0", installed: true, enabled: true },
      ],
    }));

    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: collectingIo(),
      environment: fakeEnvironment(root, bin, log, state),
    });

    expect(result).toBe(0);
    const updatedConfig = fs.readFileSync(configPath, "utf8");
    expect(updatedConfig).toContain('basic_example = """\n[plugins."minimal-ui@formaspec"]\ninside_basic');
    expect(updatedConfig).toContain("literal_example = '''\n[[plugins.\"minimal-ui@formaspec\".connections]]\ninside_literal");
    expect(updatedConfig).toContain('[plugins."minimal-ui@formaspec-extra"] # similarly prefixed plugin');
    expect(updatedConfig).toContain('[[plugins."minimal-ui@formaspec-extra".connections]] # similarly prefixed array table');
    expect(updatedConfig).toContain('prefix_parent = "preserve"');
    expect(updatedConfig).toContain('prefix_array = "preserve"');
    expect(updatedConfig).not.toContain('alias_parent = "preserve"');
    expect(updatedConfig).not.toContain('alias_array = "preserve"');
    expect(updatedConfig).not.toContain('alias_descendant = "preserve"');
    expect(updatedConfig).not.toContain('[plugins."minimal-ui@formaspec"] # managed legacy parent');
    expect(updatedConfig).not.toContain('[[plugins."minimal-ui@formaspec".connections]] # managed legacy descendant array');
    expect(updatedConfig).not.toContain('[plugins."minimal-ui@formaspec".mcp_servers.formaspec] # managed legacy descendant');
    expect(updatedConfig).toContain('[plugins."unrelated@company"] # unrelated table');
    expect(updatedConfig).toContain('unrelated = "preserve"');
    expect(updatedConfig).toContain("[mcp_servers.formaspec]");
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).not.toContain("plugin add minimal-ui@formaspec --json");
    expect(calls).toContain("plugin remove minimal-ui@formaspec --json");
    expect(JSON.parse(fs.readFileSync(`${state}.plugins`, "utf8"))).toEqual({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    });
  });

  it("removes an already-uninstalled legacy plugin table idempotently", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const configPath = path.join(root, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      'model = "test-model"',
      "",
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "approve"',
      "",
      '[plugins."minimal-ui@formaspec"]',
      'legacy_parent_marker = "remove"',
      "",
      '[plugins."minimal-ui@formaspec".settings]',
      'legacy_descendant_marker = "remove"',
      "",
      '[plugins."minimal-ui@formaspec-backup"]',
      'similarly_prefixed_marker = "preserve"',
      "",
    ].join("\n"));
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    }));
    const environment = fakeEnvironment(root, bin, log, state);
    const bridge = fakeBridge();

    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment,
    })).toBe(0);
    const firstCleanup = fs.readFileSync(configPath, "utf8");
    expect(firstCleanup).not.toContain('[plugins."minimal-ui@formaspec"]');
    expect(firstCleanup).not.toContain('[plugins."minimal-ui@formaspec".settings]');
    expect(firstCleanup).not.toContain("legacy_parent_marker");
    expect(firstCleanup).not.toContain("legacy_descendant_marker");
    expect(firstCleanup).toContain('[plugins."minimal-ui@formaspec-backup"]');
    expect(firstCleanup).toContain('similarly_prefixed_marker = "preserve"');
    expect(fs.readFileSync(log, "utf8")).not.toContain("plugin remove minimal-ui@formaspec --json");

    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment,
    })).toBe(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe(firstCleanup);
    expect(fs.readFileSync(log, "utf8")).not.toContain("plugin remove minimal-ui@formaspec --json");
  });

  it("installs and verifies FormaSpec 0.4.0 before removing installer-owned legacy identities", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const legacyFormaSpecSkill = path.join(root, ".codex", "skills", "formaspec");
    const legacyMinimalUiSkill = path.join(root, ".codex", "skills", "minimal-ui");
    writeFormaSpecManagedMarker(legacyFormaSpecSkill);
    writeFormaSpecManagedMarker(legacyMinimalUiSkill);
    fs.writeFileSync(path.join(legacyFormaSpecSkill, "SKILL.md"), "legacy managed primary skill\n");
    fs.writeFileSync(path.join(legacyMinimalUiSkill, "SKILL.md"), "legacy managed alias skill\n");
    const marketplace = path.join(root, ".codex", "formaspec-marketplace");
    writeFormaSpecManagedMarker(marketplace);
    const legacyPlugin = path.join(marketplace, "plugins", "minimal-ui");
    fs.mkdirSync(legacyPlugin, { recursive: true });
    fs.writeFileSync(path.join(legacyPlugin, "legacy.txt"), "legacy managed plugin\n");
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{ pluginId: "minimal-ui@formaspec", version: "0.2.0", installed: true, enabled: true }],
    }));

    const io = collectingIo();
    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: fakeEnvironment(root, bin, log, state),
    });

    expect(result).toBe(0);
    expect(fs.existsSync(legacyFormaSpecSkill)).toBe(false);
    expect(fs.existsSync(legacyMinimalUiSkill)).toBe(false);
    expect(fs.existsSync(path.join(marketplace, "plugins", "minimal-ui"))).toBe(false);
    expect(fs.existsSync(path.join(marketplace, "plugins", "formaspec", ".codex-plugin", "plugin.json"))).toBe(true);
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).toContain("plugin add formaspec@formaspec --json");
    expect(calls).toContain("plugin remove minimal-ui@formaspec --json");
    expect(calls.indexOf("plugin add formaspec@formaspec --json"))
      .toBeLessThan(calls.indexOf("plugin remove minimal-ui@formaspec --json"));
    expect(JSON.parse(fs.readFileSync(`${state}.plugins`, "utf8"))).toEqual({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    });
    expect(io.output.join("\n")).toContain("Removed the installer-owned legacy duplicate plugin identity.");
    expect(io.output.join("\n")).toContain("Removed installer-owned duplicate standalone skills:");
  });

  it("preserves and reports an unmanaged legacy skill collision without changing Codex", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const legacySkill = path.join(root, ".codex", "skills", "minimal-ui");
    fs.mkdirSync(legacySkill, { recursive: true });
    fs.writeFileSync(path.join(legacySkill, "SKILL.md"), "user-owned legacy skill\n");
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{ pluginId: "minimal-ui@formaspec", version: "9.9.9", installed: true, enabled: true }],
    }));

    const bridge = fakeBridge();
    const io = collectingIo();
    const result = await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    });

    expect(result).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(fs.readFileSync(path.join(legacySkill, "SKILL.md"), "utf8")).toBe("user-owned legacy skill\n");
    const calls = fs.readFileSync(log, "utf8");
    expect(calls.trim()).toBe("--version");
    expect(io.errors.join("\n")).toContain("Unmanaged legacy duplicate Codex skill collision");
    expect(io.errors.join("\n")).toContain("FormaSpec preserved it");
  });

  it("preserves managed standalone skills when legacy plugin removal fails after the primary upgrade", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const legacyFormaSpecSkill = path.join(root, ".codex", "skills", "formaspec");
    const legacyMinimalUiSkill = path.join(root, ".codex", "skills", "minimal-ui");
    writeFormaSpecManagedMarker(legacyFormaSpecSkill);
    writeFormaSpecManagedMarker(legacyMinimalUiSkill);
    const configPath = path.join(root, ".codex", "config.toml");
    fs.writeFileSync(configPath, [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "approve"',
      "",
      '[plugins."minimal-ui@formaspec"]',
      'legacy_configuration = "preserve until Codex removal succeeds"',
      "",
    ].join("\n"));
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    const originalConfig = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.2.2", installed: true, enabled: true },
        { pluginId: "minimal-ui@formaspec", version: "0.2.2", installed: true, enabled: true },
      ],
    }));
    const environment = {
      ...fakeEnvironment(root, bin, log, state),
      FAKE_CODEX_FAIL_PLUGIN_REMOVE: "1",
    };
    const bridge = fakeBridge();
    const io = collectingIo();

    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment,
    })).toBe(1);

    const calls = fs.readFileSync(log, "utf8");
    expect(calls.indexOf("plugin add formaspec@formaspec --json"))
      .toBeLessThan(calls.indexOf("plugin remove minimal-ui@formaspec --json"));
    expect(fs.existsSync(legacyFormaSpecSkill)).toBe(true);
    expect(fs.existsSync(legacyMinimalUiSkill)).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(bridge.authorizations).toBe(0);
    expect(io.errors.join("\n")).toContain("verified FormaSpec 0.4.0 but could not remove the legacy duplicate plugin");
  });

  it("prints generic MCP configuration without starting, authorizing, or modifying an unknown client", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();
    const result = await runCli(["agent", "config", "generic", "--format", "json", "--snippet-only"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    });
    expect(result).toBe(0);
    expect(bridge.starts).toBe(0);
    expect(bridge.authorizations).toBe(0);
    expect(io.output.join("\n")).toContain('"url": "http://127.0.0.1:4312/mcp"');
    expect(io.output.join("\n").toLowerCase()).not.toContain("bearer");
  });

  it("uses the public MCP endpoint and never starts the loopback bridge for proxy-server mode", async () => {
    const root = makeProject(temporaryDirectory());
    recordProxyServerRuntime(root);
    const bridge = fakeBridge();
    const configIo = collectingIo();

    expect(await runCli(["agent", "config", "generic", "--format", "json", "--snippet-only"], {
      projectRoot: root,
      bridge,
      io: configIo,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    })).toBe(0);
    expect(configIo.output.join("\n")).toContain("https://design.company.example/mcp");
    expect(bridge.starts).toBe(0);

    const connectIo = collectingIo();
    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io: connectIo,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    })).toBe(1);
    expect(connectIo.errors.join("\n")).toContain("loopback bridge is intentionally disabled");
    expect(bridge.starts).toBe(0);
  });

  it("fails normal doctor when server health, bridge health, or authenticated MCP verification is unavailable", async () => {
    const root = makeProject(temporaryDirectory());
    const environment = { HOME: root, PATH: "/usr/bin:/bin" };
    const healthyFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const stoppedBridge = fakeBridge();
    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge: stoppedBridge,
      io: collectingIo(),
      environment,
      commandRunner: runner,
    })).toBe(1);

    const unauthorizedBridge = fakeBridge();
    unauthorizedBridge.running = true;
    unauthorizedBridge.verificationError = new Error("AGENT_AUTHORIZATION_MISSING");
    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge: unauthorizedBridge,
      io: collectingIo(),
      environment,
      commandRunner: runner,
    })).toBe(1);

    const healthyBridge = fakeBridge();
    healthyBridge.running = true;
    healthyFetch.mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/render")
        ? '{"ok":false}'
        : JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge: healthyBridge,
      io: collectingIo(),
      environment,
      commandRunner: runner,
    })).toBe(1);
  });

  it("keeps ensure-running blocked until one runtime mode has been recorded", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();
    let delegated = false;

    const result = await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: path.join(root, "empty-bin") },
      commandRunner: async () => {
        delegated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toBe(1);
    expect(delegated).toBe(false);
    expect(bridge.starts).toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      status: "blocked",
      mode: null,
      blocker: { code: "RUNTIME_NOT_RECORDED" },
    });
  });

  it("reports the recorded development web origin while verifying the API and bridge identity", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "dev\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4310\n");
    fs.writeFileSync(path.join(runDirectory, "web-port"), "4311\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "http://127.0.0.1:4311\n");
    const bridge = fakeBridge();
    const io = collectingIo();
    let delegated = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => {
        delegated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toBe(0);
    expect(delegated).toBe(false);
    expect(bridge.starts).toBe(1);
    expect(JSON.parse(io.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      status: "ready",
      mode: "dev",
      started: false,
      origin: "http://127.0.0.1:4310",
      webOrigin: "http://127.0.0.1:4311",
      dataStoreId: TEST_DATA_STORE_ID,
      bridgeReady: true,
    });
  });

  it("resumes an offline recorded local runtime without selecting another data store", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "local\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4320\n");
    fs.writeFileSync(path.join(runDirectory, "web-port"), "0\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "http://127.0.0.1:4320\n");
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    const io = collectingIo();
    const launcherCalls: Array<{ executable: string; args: readonly string[] }> = [];
    let healthAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      healthAttempts += 1;
      if (healthAttempts === 1) throw new Error("offline");
      return new Response(JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async (executable, args) => {
        launcherCalls.push({ executable, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toBe(0);
    expect(launcherCalls).toEqual([{
      executable: path.join(root, "designer"),
      args: ["--yes", "start", "local", "--port", "4320", "--no-open"],
    }]);
    expect(bridge.starts).toBe(1);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      ok: true,
      status: "started",
      mode: "local",
      origin: "http://127.0.0.1:4320",
      webOrigin: "http://127.0.0.1:4320",
      dataStoreId: TEST_DATA_STORE_ID,
    });
  });

  it("does not fall back to native mode when a recorded Docker runtime lacks Docker", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.mkdirSync(emptyBin);
    fs.writeFileSync(path.join(runDirectory, "mode"), "docker\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4310\n");
    fs.writeFileSync(path.join(runDirectory, "web-port"), "0\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "http://127.0.0.1:4310\n");
    const bridge = fakeBridge();
    const io = collectingIo();
    let delegated = false;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const result = await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: emptyBin },
      commandRunner: async () => {
        delegated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toBe(1);
    expect(delegated).toBe(false);
    expect(bridge.starts).toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      ok: false,
      mode: "docker",
      blocker: {
        code: "DOCKER_CLI_REQUIRED",
        action: expect.stringMatching(/Do not start local mode/i),
      },
    });
  });

  it("keeps bridge recovery on the recorded Docker data store", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "docker\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4310\n");
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["doctor", "auto"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);
    const output = io.output.join("\n");
    expect(output).toContain("Run './designer start docker', then rerun doctor.");
    expect(output).not.toContain("Run './designer start local'");
  });

  it("passes normal doctor only after readiness, renderer, bridge, and essential MCP checks pass", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(result).toBe(0);
    expect(io.output.join("\n")).toContain("Server readiness: verified");
    expect(io.output.join("\n")).toContain("Renderer health: verified");
    expect(io.output.join("\n")).toContain("verified as formaspec");
    expect(io.output.join("\n")).toContain(`${FORMASPEC_ESSENTIAL_MCP_TOOLS.length} essential tools`);
  });

  it("fails doctor when the recorded server exposes an older MCP contract", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.serverVersion = "0.3.0";
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);
    expect(io.output.join("\n")).toContain("recorded server reports 0.3.0");
    expect(io.output.join("\n")).toContain(`expects ${FORMASPEC_MCP_CONTRACT_VERSION}`);
    expect(io.output.join("\n")).toContain("Update and restart the recorded runtime");
  });

  it("fails doctor when a formaspecctl-managed plugin is older than the server contract", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.3.0", installed: true, enabled: true },
      ],
    }));
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(1);
    expect(io.output.join("\n")).toContain(`server ${FORMASPEC_MCP_CONTRACT_VERSION}; managed plugin 0.3.0`);
    expect(io.output.join("\n")).toContain("formaspecctl --yes agent connect codex");
  });

  it("passes doctor when the server and formaspecctl-managed plugin contracts match", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        {
          pluginId: "formaspec@formaspec",
          version: FORMASPEC_MCP_CONTRACT_VERSION,
          installed: true,
          enabled: true,
        },
      ],
    }));
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(0);
    expect(io.output.join("\n")).toContain(`FormaSpec MCP/plugin contract: verified ${FORMASPEC_MCP_CONTRACT_VERSION}; local approval mode approve.`);
  });

  it("fails strict doctor when a managed Codex install regresses to per-call approval", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "writes"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{
        pluginId: "formaspec@formaspec",
        version: FORMASPEC_MCP_CONTRACT_VERSION,
        installed: true,
        enabled: true,
      }],
    }));
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["doctor", "local", "--strict"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(1);
    const output = io.output.join("\n");
    expect(output).toContain("FormaSpec MCP approval mismatch");
    expect(output).toContain("configured as writes; expected approve");
    expect(output).toContain("formaspecctl --yes agent connect codex");
    expect(output).toContain("without changing global Codex approval or sandbox policy");
  });

  it("fails strict doctor unless managed MCP configuration matches the exact active loopback bridge", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const cases: Array<{
      name: string;
      configuredUrl?: string;
      environment?: NodeJS.ProcessEnv;
    }> = [
      { name: "missing" },
      { name: "remote", configuredUrl: "https://design.company.example/mcp" },
      { name: "wrong loopback", configuredUrl: "http://127.0.0.1:4999/mcp" },
      {
        name: "unrelated transport",
        configuredUrl: "http://127.0.0.1:4312/mcp",
        environment: { FAKE_CODEX_MCP_TRANSPORT_TYPE: "stdio" },
      },
      {
        name: "credential-bearing",
        configuredUrl: "http://127.0.0.1:4312/mcp",
        environment: { FAKE_CODEX_MCP_BEARER_ENV: "FORMASPEC_MCP_TOKEN" },
      },
    ];

    for (const testCase of cases) {
      const root = makeProject(temporaryDirectory());
      const bin = path.join(root, "bin");
      const log = path.join(root, "codex.log");
      const state = path.join(root, "codex.state");
      installFakeCodex(bin, log, state);
      if (testCase.configuredUrl !== undefined) fs.writeFileSync(state, testCase.configuredUrl);
      writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
      fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
        "[mcp_servers.formaspec]",
        'url = "http://127.0.0.1:4312/mcp"',
        'default_tools_approval_mode = "approve"',
        "",
      ].join("\n"));
      fs.writeFileSync(`${state}.plugins`, JSON.stringify({
        installed: [{
          pluginId: "formaspec@formaspec",
          version: FORMASPEC_MCP_CONTRACT_VERSION,
          installed: true,
          enabled: true,
        }],
      }));
      const bridge = fakeBridge();
      bridge.running = true;
      const io = collectingIo();

      expect(await runCli(["doctor", "local", "--strict"], {
        projectRoot: root,
        bridge,
        io,
        environment: {
          ...fakeEnvironment(root, bin, log, state),
          ...testCase.environment,
        },
      }), testCase.name).toBe(1);
      const output = io.output.join("\n");
      expect(output, testCase.name).toContain("FormaSpec MCP configuration mismatch");
      expect(output, testCase.name).toContain("http://127.0.0.1:4312/mcp");
      expect(output, testCase.name).toContain("formaspecctl --yes agent connect codex");
      expect(output, testCase.name).not.toContain("local approval mode approve");
    }
  }, 15_000);

  it("rejects healthy UI and bridge processes when their upstream origin or data store differs", async () => {
    const root = makeProject(temporaryDirectory());
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(
      String(input).endsWith("/health/ready")
        ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
        : '{"ok":true}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const wrongOrigin = fakeBridge();
    wrongOrigin.running = true;
    wrongOrigin.upstreamOrigin = "http://127.0.0.1:4320";
    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge: wrongOrigin,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: runner,
    })).toBe(1);
    expect(io.output.join("\n")).toContain("Codex runtime mismatch");
    expect(io.output.join("\n")).toContain("http://127.0.0.1:4320");

    const wrongStore = fakeBridge();
    wrongStore.running = true;
    wrongStore.dataStoreId = `store_${"b".repeat(32)}`;
    const secondIo = collectingIo();
    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge: wrongStore,
      io: secondIo,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: runner,
    })).toBe(1);
    expect(secondIo.output.join("\n")).toContain("Codex runtime mismatch");
    expect(secondIo.output.join("\n")).toContain(wrongStore.dataStoreId);
  });

  it("retains a readiness-503 store identity and reports aligned maintenance without a false runtime mismatch", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "server\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "7443\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "https://design.company.example\n");
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.upstreamOrigin = "http://127.0.0.1:7443";
    bridge.upstreamReady = false;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/health/ready")) {
        return new Response(JSON.stringify({
          ok: false,
          status: "maintenance",
          dataStoreId: TEST_DATA_STORE_ID,
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    expect(await runCli(["doctor", "server"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    })).toBe(1);
    const output = io.output.join("\n");
    expect(output).toContain(`retained data-store identity ${TEST_DATA_STORE_ID}`);
    expect(output).toContain("runtime identity is aligned");
    expect(output).toContain("Keep this mode running");
    expect(output).not.toContain("runtime mismatch");
  });

  it("makes status fail visibly when the browser runtime and Codex bridge are split", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await runCli(["status"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);
    expect(io.output.join("\n")).toContain("runtime mismatch");
    expect(io.output.join("\n")).toContain("http://127.0.0.1:4310");
    expect(io.output.join("\n")).toContain("http://127.0.0.1:4320");
  });

  it("makes status report a managed Codex approval regression", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "never"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{
        pluginId: "formaspec@formaspec",
        version: FORMASPEC_MCP_CONTRACT_VERSION,
        installed: true,
        enabled: true,
      }],
    }));
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const runner = async (executable: string, args: readonly string[], options?: CommandOptions) => {
      if (executable === path.join(root, "designer")) return { exitCode: 0, stdout: "", stderr: "" };
      const { runCommand } = await import("./process.js");
      return runCommand(executable, args, options);
    };

    expect(await runCli(["status"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
      commandRunner: runner,
    })).toBe(1);
    expect(io.output.join("\n")).toContain("managed Codex approval mode is never; expected approve");
    expect(io.output.join("\n")).toContain("formaspecctl --yes agent connect codex");
  });

  it("makes status reject managed approval when the Codex MCP entry is missing", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [{
        pluginId: "formaspec@formaspec",
        version: FORMASPEC_MCP_CONTRACT_VERSION,
        installed: true,
        enabled: true,
      }],
    }));
    const bridge = fakeBridge();
    bridge.running = true;
    const io = collectingIo();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const runner = async (executable: string, args: readonly string[], options?: CommandOptions) => {
      if (executable === path.join(root, "designer")) return { exitCode: 0, stdout: "", stderr: "" };
      const { runCommand } = await import("./process.js");
      return runCommand(executable, args, options);
    };

    expect(await runCli(["status"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
      commandRunner: runner,
    })).toBe(1);
    expect(io.output.join("\n")).toContain("managed Codex MCP configuration does not match");
    expect(io.output.join("\n")).toContain("active credential-free loopback bridge");
    expect(io.output.join("\n")).not.toContain("trusted local server (approve)");
  });

  it("rejects a healthy recorded native store when a known Docker store is also active", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "local\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4320\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "http://127.0.0.1:4320\n");
    persistKnownDockerBinding(root, 4310);
    const nativeStoreId = TEST_DATA_STORE_ID;
    const dockerStoreId = `store_${"b".repeat(32)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const dataStoreId = url.startsWith("http://127.0.0.1:4310") ? dockerStoreId : nativeStoreId;
      return new Response(
        url.endsWith("/health/ready") ? JSON.stringify({ ok: true, dataStoreId }) : '{"ok":true}',
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    bridge.dataStoreId = nativeStoreId;
    const io = collectingIo();

    expect(await runCli(["doctor", "local"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);
    expect(io.output.join("\n")).toContain("Multiple active FormaSpec data stores");
    expect(io.output.join("\n")).toContain(nativeStoreId);
    expect(io.output.join("\n")).toContain(dockerStoreId);
  });

  it("checks a degraded known Docker binding even when the recorded primary runtime is server mode", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "server\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "7443\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "https://design.company.example\n");
    persistKnownDockerBinding(root, 4310);
    const serverStoreId = TEST_DATA_STORE_ID;
    const dockerStoreId = `store_${"b".repeat(32)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const isDockerReadiness = url.startsWith("http://127.0.0.1:4310") && url.endsWith("/health/ready");
      const dataStoreId = isDockerReadiness ? dockerStoreId : serverStoreId;
      return new Response(
        url.endsWith("/health/ready") ? JSON.stringify({ ok: !isDockerReadiness, dataStoreId }) : '{"ok":true}',
        { status: isDockerReadiness ? 503 : 200, headers: { "content-type": "application/json" } },
      );
    });
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.upstreamOrigin = "http://127.0.0.1:7443";
    bridge.dataStoreId = serverStoreId;
    const io = collectingIo();

    expect(await runCli(["doctor", "server"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);
    expect(io.output.join("\n")).toContain("Multiple active FormaSpec data stores");
    expect(io.output.join("\n")).toContain(serverStoreId);
    expect(io.output.join("\n")).toContain(dockerStoreId);
  });

  it("uses the recorded public Host while probing a loopback server-mode runtime", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "server\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "7443\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "https://design.company.example\n");
    const hosts: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      hosts.push(new Headers(init?.headers).get("host"));
      return new Response(
        String(input).endsWith("/health/ready")
          ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
          : '{"ok":true}',
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const bridge = fakeBridge();
    bridge.running = true;
    bridge.upstreamOrigin = "http://127.0.0.1:7443";

    expect(await runCli(["doctor", "server"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(0);
    expect(hosts).toEqual(["design.company.example", "design.company.example"]);
  });

  it("checks proxy-server health without requiring an incompatible loopback bridge", async () => {
    const root = makeProject(temporaryDirectory());
    recordProxyServerRuntime(root);
    const hosts: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      hosts.push(new Headers(init?.headers).get("host"));
      return new Response(
        String(input).endsWith("/health/ready")
          ? JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID })
          : '{"ok":true}',
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const bridge = fakeBridge();
    const io = collectingIo();

    expect(await runCli(["doctor", "server"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(0);
    expect(hosts).toEqual(["design.company.example", "design.company.example"]);
    expect(bridge.starts).toBe(0);
    expect(io.output.join("\n")).toContain("workstation loopback bridge is intentionally disabled");
  });

  it("reports an already-ready recorded local runtime without invoking the launcher", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "local", 4320, 0, "http://127.0.0.1:4320");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    const io = collectingIo();
    let launcherCalls = 0;

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => {
        launcherCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(0);

    expect(launcherCalls).toBe(0);
    expect(bridge.starts).toBe(1);
    expect(ensureRunningJson(io)).toEqual({
      schemaVersion: 1,
      ok: true,
      status: "ready",
      mode: "local",
      started: false,
      origin: "http://127.0.0.1:4320",
      webOrigin: "http://127.0.0.1:4320",
      dataStoreId: TEST_DATA_STORE_ID,
      bridgeReady: true,
    });
  });

  it("accepts an already-ready recorded Docker runtime with its effective loopback Host pinned", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "docker", 4320, 0, "http://127.0.0.1:4320");
    persistKnownDockerBinding(root, 4320);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    const io = collectingIo();
    let launcherCalls = 0;

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => {
        launcherCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(0);

    expect(launcherCalls).toBe(0);
    expect(bridge.starts).toBe(1);
    expect(ensureRunningJson(io)).toMatchObject({
      ok: true,
      status: "ready",
      mode: "docker",
      started: false,
      origin: "http://127.0.0.1:4320",
      webOrigin: "http://127.0.0.1:4320",
      dataStoreId: TEST_DATA_STORE_ID,
      bridgeReady: true,
    });
  });

  it("resumes only the recorded local runtime on its exact API port", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "local", 4320, 0, "http://127.0.0.1:4320");
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response(
        JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    const io = collectingIo();
    const calls: Array<{ executable: string; args: readonly string[]; inherit: unknown }> = [];

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async (executable, args, options) => {
        calls.push({ executable, args, inherit: options?.inherit });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(0);

    expect(calls).toEqual([{
      executable: path.join(root, "designer"),
      args: ["--yes", "start", "local", "--port", "4320", "--no-open"],
      inherit: false,
    }]);
    expect(ensureRunningJson(io)).toMatchObject({
      ok: true,
      status: "started",
      mode: "local",
      started: true,
      origin: "http://127.0.0.1:4320",
      webOrigin: "http://127.0.0.1:4320",
      dataStoreId: TEST_DATA_STORE_ID,
    });
  });

  it("returns a structured blocker instead of guessing a runtime mode", async () => {
    const root = makeProject(temporaryDirectory());
    const io = collectingIo();
    let launcherCalls = 0;

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => {
        launcherCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(1);

    expect(launcherCalls).toBe(0);
    expect(ensureRunningJson(io)).toMatchObject({
      ok: false,
      status: "blocked",
      mode: null,
      started: false,
      blocker: { code: "RUNTIME_NOT_RECORDED" },
    });
  });

  it("reports a missing Docker CLI without starting a different runtime", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "docker", 4320, 0, "http://127.0.0.1:4320");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const io = collectingIo();
    let runnerCalls = 0;

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: path.join(root, "empty-bin") },
      commandRunner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(1);

    expect(runnerCalls).toBe(0);
    expect(ensureRunningJson(io)).toMatchObject({
      ok: false,
      mode: "docker",
      blocker: { code: "DOCKER_CLI_REQUIRED" },
    });
  });

  it("reports stopped Docker Desktop without switching away from the recorded Docker store", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "docker", 4320, 0, "http://127.0.0.1:4320");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const io = collectingIo();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: bin },
      commandRunner: async (executable, args) => {
        calls.push({ executable, args });
        return { exitCode: 1, stdout: "", stderr: "daemon unavailable" };
      },
    })).toBe(1);

    expect(calls).toEqual([{
      executable: path.join(bin, "docker"),
      args: ["info", "--format", "{{.ServerVersion}}"],
    }]);
    const result = ensureRunningJson(io);
    expect(result).toMatchObject({
      ok: false,
      mode: "docker",
      blocker: { code: "DOCKER_DESKTOP_REQUIRED" },
    });
    expect(result.blocker?.action).toContain("do not start local mode");
  });

  it("rejects a recorded Docker origin that conflicts with its pinned binding before startup", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "docker", 4320, 0, "http://127.0.0.1:4320");
    persistKnownDockerBinding(root, 4310);
    const io = collectingIo();
    let fetchCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCalls += 1;
      throw new Error("must not probe");
    });
    let runnerCalls = 0;

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toBe(1);

    expect(fetchCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(ensureRunningJson(io)).toMatchObject({
      ok: false,
      mode: "docker",
      blocker: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("resumes development mode with the exact recorded API and web ports", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "dev", 4325, 4326, "http://127.0.0.1:4326");
    const launchLog = path.join(root, "dev-launch.log");
    fs.writeFileSync(path.join(root, "designer"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" > \"$FAKE_LAUNCH_LOG\"",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
    let probes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      probes += 1;
      if (probes === 1 || !fs.existsSync(launchLog)) throw new Error("offline");
      return new Response(JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4325";
    const io = collectingIo();

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin", FAKE_LAUNCH_LOG: launchLog },
      commandRunner: async () => {
        throw new Error("development recovery must use only the fixed detached launcher");
      },
    })).toBe(0);

    expect(fs.readFileSync(launchLog, "utf8").trim()).toBe(
      "--yes --no-open dev --api-port 4325 --web-port 4326 --skip-setup",
    );
    expect(ensureRunningJson(io)).toMatchObject({
      ok: true,
      status: "started",
      mode: "dev",
      origin: "http://127.0.0.1:4325",
      webOrigin: "http://127.0.0.1:4326",
      dataStoreId: TEST_DATA_STORE_ID,
    });
  });

  it("blocks a mismatched bridge data store after verifying the recorded runtime", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "local", 4320, 0, "http://127.0.0.1:4320");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, dataStoreId: TEST_DATA_STORE_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const bridge = fakeBridge();
    bridge.upstreamOrigin = "http://127.0.0.1:4320";
    bridge.dataStoreId = `store_${"b".repeat(32)}`;
    const io = collectingIo();

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);

    expect(ensureRunningJson(io)).toMatchObject({
      ok: false,
      mode: "local",
      origin: "http://127.0.0.1:4320",
      dataStoreId: TEST_DATA_STORE_ID,
      blocker: { code: "RUNTIME_IDENTITY_CONFLICT" },
    });
  });

  it("rejects a development web origin that does not match the recorded web port", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "dev", 4325, 4326, "http://127.0.0.1:4999");
    const io = collectingIo();

    expect(await runCli(["ensure-running", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(1);

    expect(ensureRunningJson(io)).toMatchObject({
      ok: false,
      mode: "dev",
      blocker: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("refreshes an already-authorized managed Codex install on startup without prompting again", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const environment = fakeEnvironment(root, bin, log, state);
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      "[mcp_servers.formaspec]",
      'url = "http://127.0.0.1:4312/mcp"',
      'default_tools_approval_mode = "writes"',
      "",
    ].join("\n"));
    writeFormaSpecManagedMarker(path.join(root, ".codex", "skills", "formaspec"));
    writeFormaSpecManagedMarker(path.join(root, ".codex", "formaspec-marketplace"));
    fs.writeFileSync(`${state}.plugins`, JSON.stringify({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.2.0", installed: true, enabled: true },
        { pluginId: "minimal-ui@formaspec", version: "0.2.0", installed: true, enabled: true },
      ],
    }));
    const bridge = fakeBridge();
    let confirmations = 0;
    const io = collectingIo();
    const runner = async (executable: string, args: readonly string[], options?: CommandOptions) => {
      if (executable === path.join(root, "designer")) return { exitCode: 0, stdout: "", stderr: "" };
      const { runCommand } = await import("./process.js");
      return runCommand(executable, args, options);
    };

    const result = await runCli(["start", "local", "--no-open"], {
      projectRoot: root,
      bridge,
      io,
      environment,
      commandRunner: runner,
      confirm: async () => { confirmations += 1; return false; },
    });

    expect(result).toBe(0);
    expect(confirmations).toBe(0);
    expect(bridge.authorizations).toBe(1);
    expect(io.output).toContain("Refreshing the already-authorized managed Codex connection and FormaSpec plugin.");
    const refreshedConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(refreshedConfig).toContain('default_tools_approval_mode = "approve"');
    expect(refreshedConfig).not.toContain('default_tools_approval_mode = "writes"');
    expect(fs.existsSync(path.join(root, ".codex", "skills", "formaspec"))).toBe(false);
    expect(fs.readFileSync(path.join(
      root,
      ".codex",
      "formaspec-marketplace",
      "plugins",
      "formaspec",
      "skills",
      "formaspec",
      "SKILL.md",
    ), "utf8"))
      .toContain("Never call `design_commit_preview`");
    expect(fs.existsSync(path.join(root, ".codex", "skills", "minimal-ui"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex", "formaspec-marketplace", "plugins", "minimal-ui"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${state}.plugins`, "utf8"))).toEqual({
      installed: [
        { pluginId: "formaspec@formaspec", version: "0.4.0", installed: true, enabled: true },
      ],
    });
  });

  it("still prompts on startup when the Codex install is unmanaged", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const environment = fakeEnvironment(root, bin, log, state);
    fs.mkdirSync(path.join(root, ".codex", "skills", "formaspec"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "skills", "formaspec", "SKILL.md"), "user-owned\n");
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(state, "http://127.0.0.1:4312/mcp");
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), '[mcp_servers.formaspec]\nurl = "http://127.0.0.1:4312/mcp"\n');
    const bridge = fakeBridge();
    let confirmations = 0;

    const result = await runCli(["start", "local", "--no-open"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment,
      commandRunner: async (executable, args, options) => {
        if (executable === path.join(root, "designer")) return { exitCode: 0, stdout: "", stderr: "" };
        const { runCommand } = await import("./process.js");
        return runCommand(executable, args, options);
      },
      confirm: async () => { confirmations += 1; return false; },
    });

    expect(result).toBe(0);
    expect(confirmations).toBe(1);
    expect(bridge.authorizations).toBe(0);
    expect(fs.readFileSync(path.join(root, ".codex", "skills", "formaspec", "SKILL.md"), "utf8")).toBe("user-owned\n");
  });

  it("delegates lifecycle commands without a shell and starts the bridge after the launcher succeeds", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const calls: Array<{ executable: string; args: readonly string[]; shellAbsent: boolean }> = [];
    let bindings = 0;
    const result = await runCli(["--yes", "start", "docker", "--no-open", "--no-build"], {
      projectRoot: root,
      bridge,
      io: collectingIo(),
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      recordDockerRuntimeBinding: async () => { bindings += 1; },
      commandRunner: async (executable, args, options) => {
        calls.push({ executable, args, shellAbsent: !("shell" in (options ?? {})) });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toBe(0);
    expect(calls).toEqual([{ executable: path.join(root, "designer"), args: ["--yes", "start", "docker", "--no-open", "--no-build"], shellAbsent: true }]);
    expect(bindings).toBe(1);
    expect(bridge.starts).toBe(1);
  });

  it("pins the exact runtime binding after server startup without emitting the configured bearer token", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();
    const secret = "server-secret-token-0123456789abcdef";
    let bindings = 0;
    const result = await runCli(["--yes", "start", "server", "--no-build"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin", DESIGNER_TOKEN: secret },
      recordDockerRuntimeBinding: async () => { bindings += 1; },
      commandRunner: async (executable, args) => {
        expect(executable).toBe(path.join(root, "designer"));
        expect(args).toEqual(["--yes", "start", "server", "--no-build"]);
        expect(args.join(" ")).not.toContain(secret);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toBe(0);
    expect(bindings).toBe(1);
    expect(bridge.starts).toBe(1);
    expect([...io.output, ...io.errors].join("\n")).not.toContain(secret);
    expect(io.output.some((line) => line.includes("Compose project"))).toBe(true);
  });

  it("does not claim a workstation bridge is ready after proxy-server startup", async () => {
    const root = makeProject(temporaryDirectory());
    recordProxyServerRuntime(root);
    const bridge = fakeBridge();
    const io = collectingIo();
    let bindings = 0;

    expect(await runCli(["--yes", "start", "server", "--no-build"], {
      projectRoot: root,
      bridge,
      io,
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
      recordDockerRuntimeBinding: async () => { bindings += 1; },
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })).toBe(0);
    expect(bindings).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(io.output.join("\n")).toContain("https://design.company.example/mcp");
    expect(io.output.join("\n")).toContain("loopback bridge is intentionally disabled");
  });

  it("uses one install authorization and automatically connects supported Codex", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const bridge = fakeBridge();
    const delegated: string[] = [];
    const environment = fakeEnvironment(root, bin, log, state);
    const runner = async (executable: string, args: readonly string[], options?: CommandOptions) => {
      if (executable === path.join(root, "designer")) {
        delegated.push(args.join(" "));
        expect(options?.env?.FORMASPEC_LEGACY_DELEGATE).toBe("1");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const { runCommand } = await import("./process.js");
      return runCommand(executable, args, options);
    };
    const confirmations: string[] = [];
    const io = collectingIo();
    const result = await runCli(["--no-open", "install", "docker"], {
      projectRoot: root,
      bridge,
      io,
      environment,
      commandRunner: runner,
      recordDockerRuntimeBinding: async () => undefined,
      confirm: async (message) => { confirmations.push(message); return true; },
    });
    expect(result).toBe(0);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain("Allow FormaSpec once");
    expect(confirmations[0]).toContain("automatically approve FormaSpec tools only for its trusted local MCP server");
    expect(confirmations[0]).toContain("Global Codex approval and sandbox settings will not be changed");
    expect(delegated).toEqual(["--yes setup docker", "--yes start docker --no-open"]);
    expect(fs.readFileSync(log, "utf8")).toContain("plugin add formaspec@formaspec --json");
    expect(io.output).toContain("FormaSpec installation and startup completed.");
  });

  it("reports a read-only contiguous migration ledger", async () => {
    const root = makeProject(temporaryDirectory());
    recordRuntime(root, "local", 4310, 4311, "http://127.0.0.1:4311");
    fs.mkdirSync(path.join(root, "data"));
    const sqlite = new Database(path.join(root, "data", "designer.sqlite"));
    sqlite.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(1, "baseline_v1", "2026-01-01T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(2, "content_addressed_persistence", "2026-01-02T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(3, "enterprise_workflow_foundation", "2026-01-03T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(4, "preview_retention", "2026-01-04T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(5, "organization_scoped_outbox", "2026-01-05T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(6, "enterprise_workflow_integrity", "2026-01-06T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(7, "enterprise_delivery_operations", "2026-01-07T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(8, "enterprise_domain_models", "2026-01-08T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(9, "audit_retention_execution", "2026-01-09T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(10, "portable_import_provenance", "2026-01-10T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(11, "render_job_persistence", "2026-01-11T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(12, "handoff_execution_decisions", "2026-01-12T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(13, "component_source_persistence", "2026-01-13T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(14, "browser_session_authentication", "2026-01-14T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(15, "preview_render_metadata", "2026-01-15T00:00:00.000Z");
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      16,
      "bootstrap_credential_trigger_canonicalization",
      "2026-01-16T00:00:00.000Z",
    );
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      17,
      "product_organization_foundation",
      "2026-01-17T00:00:00.000Z",
    );
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      18,
      "product_archive_restore_integrity",
      "2026-01-18T00:00:00.000Z",
    );
    sqlite.close();
    const io = collectingIo();
    const result = await runCli(["migrate", "status", "--json"], { projectRoot: root, bridge: fakeBridge(), io });
    expect(result).toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      latestAppliedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      supportedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      state: "current",
    });
  });

  it("creates and lists managed backups through the credential-free loopback API", async () => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "url"), "http://127.0.0.1:4310\n");
    const requests: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      const backup = {
        id: `backup_${"a".repeat(40)}`,
        filename: "formaspec-backup-2026-01-01T00-00-00-000Z.tar",
        status: "valid",
        bundleSha256: "b".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        verifiedAt: "2026-01-01T00:00:01.000Z",
      };
      return new Response(JSON.stringify(init?.method === "POST" ? { backup } : { backups: [backup] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const createdIo = collectingIo();
    expect(await runCli(["backup", "create", "--json"], { projectRoot: root, bridge: fakeBridge(), io: createdIo })).toBe(0);
    expect(JSON.parse(createdIo.output[0]!)).toMatchObject({ status: "valid" });

    const listedIo = collectingIo();
    expect(await runCli(["backup", "list"], { projectRoot: root, bridge: fakeBridge(), io: listedIo })).toBe(0);
    expect(listedIo.output[0]).toContain("backup_");
    expect(requests).toEqual([
      { url: "http://127.0.0.1:4310/api/backups", method: "POST" },
      { url: "http://127.0.0.1:4310/api/backups", method: "GET" },
    ]);
  });

  it("configures supervisor-run schedules and enforces preview-first prune authorization", async () => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "url"), "http://127.0.0.1:4310\n");
    const previewId = `backup_prune_preview_${"a".repeat(32)}`;
    const planHash = "b".repeat(64);
    const requests: Array<{ pathname: string; method: string; body: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ pathname: url.pathname, method, body: typeof init?.body === "string" ? init.body : null });
      if (url.pathname === "/api/backups/schedule" && method === "GET") {
        return Response.json({ schedule: {
          enabled: false,
          cronExpression: "0 2 * * *",
          timezone: "UTC",
          retention: { daily: 7, weekly: 4, monthly: 12 },
          updatedAt: null,
          lastScheduledBackupAt: null,
          nextDueAt: null,
          supervision: {
            status: "warning",
            dueAt: null,
            graceEndsAt: null,
            currentWindowCovered: false,
            retention: { candidateCount: 1, candidateBytes: 42, protectedCount: 0, planHash },
            alerts: [{ code: "RETENTION_PRUNE_REQUIRED", severity: "warning", message: "1 verified scheduled backup requires a reviewed retention prune." }],
          },
        } });
      }
      if (url.pathname === "/api/backups/schedule" && method === "PUT") {
        return Response.json({ schedule: {
          enabled: true,
          cronExpression: "15 3 * * *",
          timezone: "UTC",
          retention: { daily: 7, weekly: 4, monthly: 12 },
          updatedAt: "2026-07-19T00:00:00.000Z",
          lastScheduledBackupAt: null,
          nextDueAt: "2026-07-20T03:15:00.000Z",
        } });
      }
      if (url.pathname === "/api/backups/schedule/run") {
        return Response.json({ run: {
          status: "created",
          dueAt: "2026-07-19T03:15:00.000Z",
          nextDueAt: "2026-07-20T03:15:00.000Z",
          retentionClass: "monthly",
          backup: { id: `backup_${"c".repeat(40)}`, filename: "formaspec-backup-2026-07-19T03-15-00-000Z.tar" },
        } });
      }
      if (url.pathname === "/api/backups/prune/previews" && method === "POST") {
        return Response.json({ preview: {
          previewId,
          planHash,
          expiresAt: "2026-07-19T12:15:00.000Z",
          candidates: [{ id: `backup_${"d".repeat(40)}`, filename: "old.tar", sizeBytes: 42, retentionClass: "daily" }],
          retainedCount: 23,
          manualExemptCount: 2,
          protectedCount: 1,
          totalCandidateBytes: 42,
        } }, { status: 201 });
      }
      if (url.pathname === `/api/backups/prune/previews/${previewId}/commit`) {
        return Response.json({ result: {
          previewId,
          planHash,
          prunedBackupIds: [`backup_${"d".repeat(40)}`],
          prunedBytes: 42,
          cleanupPending: false,
        } });
      }
      return new Response("not found", { status: 404 });
    });

    const scheduleIo = collectingIo();
    expect(await runCli(["backup", "schedule", "enable", "--at", "03:15", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: scheduleIo,
    })).toBe(0);
    expect(JSON.parse(scheduleIo.output[0]!)).toMatchObject({ enabled: true, cronExpression: "15 3 * * *" });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ enabled: true, cronExpression: "15 3 * * *" });

    const showIo = collectingIo();
    expect(await runCli(["backup", "schedule", "show"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: showIo,
    })).toBe(0);
    expect(showIo.output.join("\n")).toContain("Backup supervision: warning");
    expect(showIo.output.join("\n")).toContain("RETENTION_PRUNE_REQUIRED");

    expect(await runCli(["backup", "schedule", "run", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: collectingIo(),
    })).toBe(0);

    const previewIo = collectingIo();
    expect(await runCli(["backup", "prune", "preview"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: previewIo,
    })).toBe(0);
    expect(previewIo.output.at(-1)).toContain(`--preview-id ${previewId} --plan-hash ${planHash} --yes`);

    const refusedIo = collectingIo();
    expect(await runCli(["backup", "prune", "execute", "--preview-id", previewId, "--plan-hash", planHash], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: refusedIo,
    })).toBe(1);
    expect(refusedIo.errors[0]).toContain("explicit --yes authorization");

    const executeIo = collectingIo();
    expect(await runCli(["backup", "prune", "execute", "--preview-id", previewId, "--plan-hash", planHash, "--yes", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: executeIo,
    })).toBe(0);
    expect(JSON.parse(executeIo.output[0]!)).toMatchObject({ prunedBackupIds: [`backup_${"d".repeat(40)}`] });
    expect(requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
      "GET /api/backups/schedule",
      "PUT /api/backups/schedule",
      "GET /api/backups/schedule",
      "POST /api/backups/schedule/run",
      "POST /api/backups/prune/previews",
      `POST /api/backups/prune/previews/${previewId}/commit`,
    ]);
  });

  it("previews audit retention and requires explicit authorization for the exact idempotent commit", async () => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "url"), "http://127.0.0.1:4310\n");
    const previewId = `audit_retention_preview_${"a".repeat(32)}`;
    const planHash = "b".repeat(64);
    const requests: Array<{ pathname: string; method: string; body: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ pathname: url.pathname, method, body: typeof init?.body === "string" ? init.body : null });
      if (url.pathname === "/api/organization/audit-retention/previews") {
        return Response.json({ preview: {
          previewId,
          configurationHash: "c".repeat(64),
          policyHash: "d".repeat(64),
          retentionDays: 365,
          cutoffAt: "2025-07-20T12:00:00.000Z",
          planHash,
          auditEvents: { count: 4, bytes: 400, firstId: 1, lastId: 4, sha256: "e".repeat(64), hasMore: true },
          outboxEvents: { count: 3, bytes: 300, firstId: 1, lastId: 3, sha256: "f".repeat(64), hasMore: false },
          generatedAt: "2026-07-20T12:00:00.000Z",
          expiresAt: "2026-07-20T12:15:00.000Z",
        } }, { status: 201 });
      }
      if (url.pathname === `/api/organization/audit-retention/previews/${previewId}/commit`) {
        return Response.json({ result: {
          runId: `audit_retention_run_${"1".repeat(32)}`,
          previewId,
          configurationHash: "c".repeat(64),
          policyHash: "d".repeat(64),
          retentionDays: 365,
          cutoffAt: "2025-07-20T12:00:00.000Z",
          planHash,
          auditEvents: { count: 4, bytes: 400, firstId: 1, lastId: 4, sha256: "e".repeat(64), hasMore: true },
          outboxEvents: { count: 3, bytes: 300, firstId: 1, lastId: 3, sha256: "f".repeat(64), hasMore: false },
          previousRunHash: null,
          runHash: "2".repeat(64),
          commitAuditEventId: 10,
          commitOutboxEventId: 11,
          completedAt: "2026-07-20T12:01:00.000Z",
        } });
      }
      if (url.pathname === "/api/organization/audit-retention/runs") {
        return Response.json({ runs: [{
          runId: `audit_retention_run_${"1".repeat(32)}`,
          previewId,
          configurationHash: "c".repeat(64),
          policyHash: "d".repeat(64),
          retentionDays: 365,
          cutoffAt: "2025-07-20T12:00:00.000Z",
          planHash,
          auditEvents: { count: 4, bytes: 400, firstId: 1, lastId: 4, sha256: "e".repeat(64), hasMore: true },
          outboxEvents: { count: 3, bytes: 300, firstId: 1, lastId: 3, sha256: "f".repeat(64), hasMore: false },
          previousRunHash: null,
          runHash: "2".repeat(64),
          commitAuditEventId: 10,
          commitOutboxEventId: 11,
          completedAt: "2026-07-20T12:01:00.000Z",
        }] });
      }
      return new Response("not found", { status: 404 });
    });

    const previewIo = collectingIo();
    expect(await runCli(["audit", "retention", "preview"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: previewIo,
    })).toBe(0);
    expect(previewIo.output).toContain("This is a bounded batch; create another preview after committing it to continue retention.");
    expect(previewIo.output.at(-1)).toContain(`--preview-id ${previewId} --plan-hash ${planHash} --yes`);

    const refusedIo = collectingIo();
    expect(await runCli(["audit", "retention", "execute", "--preview-id", previewId, "--plan-hash", planHash], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: refusedIo,
    })).toBe(1);
    expect(refusedIo.errors[0]).toContain("explicit --yes authorization");

    const executeIo = collectingIo();
    expect(await runCli(["audit", "retention", "execute", "--preview-id", previewId, "--plan-hash", planHash, "--yes", "--json"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: executeIo,
    })).toBe(0);
    expect(JSON.parse(executeIo.output[0]!)).toMatchObject({
      auditEvents: { count: 4 },
      outboxEvents: { count: 3 },
    });
    const listIo = collectingIo();
    expect(await runCli(["audit", "retention", "list"], {
      projectRoot: root,
      bridge: fakeBridge(),
      io: listIo,
    })).toBe(0);
    expect(listIo.output[0]).toContain(`audit_retention_run_${"1".repeat(32)}`);
    expect(requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
      "POST /api/organization/audit-retention/previews",
      `POST /api/organization/audit-retention/previews/${previewId}/commit`,
      "GET /api/organization/audit-retention/runs",
    ]);
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      expectedPlanHash: planHash,
      idempotencyKey: `audit-retention:${previewId}`,
    });
  });

  it("requires explicit --yes authorization before restore orchestration", async () => {
    const root = makeProject(temporaryDirectory());
    const io = collectingIo();
    let verified = false;
    let restored = false;
    const result = await runCli(["backup", "restore", path.join(root, "incoming.tar")], {
      projectRoot: root,
      bridge: fakeBridge(),
      io,
      backupVerifier: async () => { verified = true; return backupVerification(); },
      restoreVerifiedBackup: async () => { restored = true; },
    });
    expect(result).toBe(1);
    expect(verified).toBe(false);
    expect(restored).toBe(false);
    expect(io.errors[0]).toContain("explicit --yes authorization");
  });

  it("routes a managed Docker backup ID through the offline supervisor", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();
    const backupId = `backup_${"a".repeat(40)}`;
    let receivedBackupId = "";
    const result = await runCli(["backup", "restore", "--backup-id", backupId, "--yes", "--json"], {
      projectRoot: root,
      bridge,
      io,
      restoreDockerBackup: async (receivedRoot, received, _restoreIo, dependencies) => {
        expect(receivedRoot).toBe(root);
        expect(dependencies?.commandRunner).toBeDefined();
        receivedBackupId = received;
        return {
          status: "restored",
          operationId: "restore_0123456789abcdef0123456789abcdef",
          backupId,
          safetyBackupId: `backup_${"b".repeat(40)}`,
          maintenanceCleared: true,
          serviceReady: true,
          reconnectRequired: true,
          worker: null,
        };
      },
    });
    expect(result).toBe(0);
    expect(receivedBackupId).toBe(backupId);
    expect(bridge.stops).toBe(1);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ status: "restored", backupId, serviceReady: true });
  });

  it("routes an explicitly verified bundle through offline Docker disaster recovery", async () => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "mode"), "docker\n");
    const bundle = path.join(root, "operator-selected.tar");
    fs.writeFileSync(bundle, "test bundle bytes");
    const bridge = fakeBridge();
    const io = collectingIo();
    let received: { path: string; sha256: string; sizeBytes: number } | undefined;

    const result = await runCli(["backup", "restore", "offline", bundle, "--yes", "--json"], {
      projectRoot: root,
      bridge,
      io,
      backupVerifier: async (filename) => {
        expect(filename).toBe(bundle);
        return backupVerification(CLI_SUPPORTED_DATABASE_VERSION);
      },
      restoreDockerBackupOffline: async (receivedRoot, source) => {
        expect(receivedRoot).toBe(root);
        received = source;
        return {
          status: "restored",
          operationId: "restore_0123456789abcdef0123456789abcdef",
          backupId: `backup_${"c".repeat(40)}`,
          safetyBackupId: `backup_${"d".repeat(40)}`,
          maintenanceCleared: true,
          serviceReady: true,
          reconnectRequired: true,
          worker: null,
        };
      },
    });

    expect(result).toBe(0);
    expect(received).toEqual({ path: bundle, sha256: "a".repeat(64), sizeBytes: 512 });
    expect(bridge.stops).toBe(1);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ status: "restored", serviceReady: true });
  });

  it("reports Docker restore state without stopping the bridge", async () => {
    const root = makeProject(temporaryDirectory());
    const bridge = fakeBridge();
    const io = collectingIo();
    const result = await runCli(["backup", "restore", "status", "--json"], {
      projectRoot: root,
      bridge,
      io,
      dockerRestoreStatus: async () => ({
        maintenance: {
          active: true,
          markerValid: true,
          phase: "verification",
          operationId: "restore_0123456789abcdef0123456789abcdef",
          startedAt: "2026-07-19T12:00:00.000Z",
        },
        operation: {
          operationId: "restore_0123456789abcdef0123456789abcdef",
          backupId: `backup_${"a".repeat(40)}`,
          safetyBackupId: `backup_${"b".repeat(40)}`,
          phase: "reconciled",
          createdAt: "2026-07-19T12:00:00.000Z",
          updatedAt: "2026-07-19T12:01:00.000Z",
          smoke: { schemaVersion: CLI_SUPPORTED_DATABASE_VERSION, renderedDesignId: null },
          result: { auditEventId: 2, outboxEventId: 3, revoked: { grants: 1, connections: 1, nonces: 1 } },
          errorCode: null,
        },
        workerLock: { active: false, lockValid: true },
      }),
    });
    expect(result).toBe(0);
    expect(bridge.stops).toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ operation: { phase: "reconciled" } });
  });

  it("reads migration status from the native data-directory contract", async () => {
    const root = makeProject(temporaryDirectory());
    const state = path.join(root, "native-user-state");
    const database = path.join(state, "data", "designer.sqlite");
    writeMigrationDatabase(database, CLI_SUPPORTED_DATABASE_VERSION);
    const runDirectory = path.join(state, "runtime", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "local\n");
    fs.writeFileSync(path.join(runDirectory, "api-port"), "4310\n");
    fs.writeFileSync(path.join(runDirectory, "web-port"), "4311\n");
    fs.writeFileSync(path.join(runDirectory, "url"), "http://127.0.0.1:4311\n");
    const io = collectingIo();

    const result = await runCli(["migrate", "status", "--json"], {
      projectRoot: root,
      environment: {
        FORMASPEC_RUNTIME_DIR: path.join(state, "runtime"),
        FORMASPEC_DATA_DIR: path.join(state, "data"),
      },
      io,
    });

    expect(result).toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      databasePath: database,
      latestAppliedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      state: "current",
    });
    expect(fs.existsSync(path.join(root, "data"))).toBe(false);
  });

  it("requires explicit authorization before changing Docker restore recovery state", async () => {
    const root = makeProject(temporaryDirectory());
    for (const command of ["resume", "rollback", "abort", "clear-stale-lock"] as const) {
      const bridge = fakeBridge();
      const io = collectingIo();
      let called = false;
      const result = await runCli(["backup", "restore", command], {
        projectRoot: root,
        bridge,
        io,
        resumeDockerRestore: async () => {
          called = true;
          throw new Error("unexpected");
        },
        rollbackDockerRestore: async () => {
          called = true;
          throw new Error("unexpected");
        },
      });
      expect(result).toBe(1);
      expect(called).toBe(false);
      expect(bridge.stops).toBe(0);
      expect(io.errors[0]).toContain("explicit --yes authorization");
    }
  });

  it.each(["docker", "server"] as const)("refuses a recorded %s runtime without stopping or changing it", async (mode) => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "mode"), `${mode}\n`);
    const bridge = fakeBridge();
    const io = collectingIo();
    let verified = false;
    let restored = false;
    let delegated = false;
    const result = await runCli(["backup", "restore", path.join(root, "incoming.tar"), "--yes"], {
      projectRoot: root,
      bridge,
      io,
      backupVerifier: async () => { verified = true; return backupVerification(); },
      restoreVerifiedBackup: async () => { restored = true; },
      commandRunner: async () => { delegated = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    expect(result).toBe(1);
    expect(verified).toBe(false);
    expect(restored).toBe(false);
    expect(delegated).toBe(false);
    expect(bridge.stops).toBe(0);
    expect(io.errors[0]).toMatch(mode === "docker" ? /Docker runtime uses a managed volume/ : /managed backup ID through the supervised maintenance workflow/);
  });

  it("fails closed before a source-local restore can target native packaged state", async () => {
    const root = makeProject(temporaryDirectory());
    const state = path.join(root, "native-user-state");
    const runtime = path.join(state, "runtime");
    fs.mkdirSync(path.join(runtime, "run"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "run", "mode"), "local\n");
    const bridge = fakeBridge();
    const io = collectingIo();
    let verified = false;
    let restored = false;
    let delegated = false;

    const result = await runCli(["backup", "restore", path.join(root, "incoming.tar"), "--yes"], {
      projectRoot: root,
      environment: {
        FORMASPEC_RUNTIME_DIR: runtime,
        FORMASPEC_DATA_DIR: path.join(state, "data"),
        FORMASPEC_BACKUP_DIR: path.join(state, "backups"),
        FORMASPEC_LOG_DIR: path.join(state, "logs"),
        FORMASPEC_SUPPORT_DIR: path.join(state, "support-bundles"),
      },
      bridge,
      io,
      backupVerifier: async () => { verified = true; return backupVerification(); },
      restoreVerifiedBackup: async () => { restored = true; },
      commandRunner: async () => { delegated = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    });

    expect(result).toBe(1);
    expect(verified).toBe(false);
    expect(restored).toBe(false);
    expect(delegated).toBe(false);
    expect(bridge.stops).toBe(0);
    expect(io.errors[0]).toContain("Source-local restore is disabled for an environment-managed native runtime");
    expect(fs.existsSync(path.join(root, "data"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".designer"))).toBe(false);
  });

  it("verifies, stops local services, creates a safety copy, and invokes the atomic restore engine", async () => {
    const root = makeProject(temporaryDirectory());
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "mode"), "local\n");
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"));
    const bundle = path.join(root, "incoming.tar");
    fs.writeFileSync(bundle, "fixture");
    const bridge = fakeBridge();
    const io = collectingIo();
    const events: string[] = [];
    const result = await runCli(["backup", "restore", bundle, "--yes", "--json"], {
      projectRoot: root,
      bridge,
      io,
      now: () => new Date("2026-07-19T12:34:56.000Z"),
      backupVerifier: async (verifiedBundle) => {
        expect(verifiedBundle).toBe(bundle);
        events.push("verify");
        return backupVerification();
      },
      commandRunner: async (executable, args, options) => {
        expect(executable).toBe(path.join(root, "designer"));
        expect(options?.env?.FORMASPEC_LEGACY_DELEGATE).toBe("1");
        if (args[0] === "stop") {
          events.push("stop");
          fs.rmSync(path.join(runDirectory, "mode"), { force: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        expect(args[0]).toBe("backup");
        expect(args[1]).toMatch(/\.designer\/backups\/pre-restore-2026-07-19T12-34-56-000Z-/);
        events.push("pre-backup");
        fs.mkdirSync(path.join(args[1]!, "data"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      restoreVerifiedBackup: async (restoredBundle, destination, options) => {
        events.push("restore");
        expect(restoredBundle).toBe(bundle);
        expect(destination).toBe(path.join(root, "data"));
        expect(options.databaseClosed).toBe(true);
        expect(options.expectedSource).toEqual({ sha256: "a".repeat(64), sizeBytes: 512 });
        await options.healthCheck?.(destination);
      },
    });
    expect(result).toBe(0);
    expect(bridge.stops).toBe(1);
    expect(events).toEqual(["verify", "stop", "pre-backup", "restore"]);
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      restored: true,
      destination: path.join(root, "data"),
      migrationVersion: 10,
      serviceState: "stopped",
    });
  });

  it("cancels before restore when the stopped-service safety copy fails", async () => {
    const root = makeProject(temporaryDirectory());
    writeMigrationDatabase(path.join(root, "data", "designer.sqlite"));
    const bridge = fakeBridge();
    const io = collectingIo();
    let restored = false;
    const result = await runCli(["backup", "restore", path.join(root, "incoming.tar"), "--yes"], {
      projectRoot: root,
      bridge,
      io,
      backupVerifier: async () => backupVerification(),
      commandRunner: async (_executable, args) => {
        expect(args[0]).toBe("backup");
        return { exitCode: 1, stdout: "", stderr: "disk full" };
      },
      restoreVerifiedBackup: async () => { restored = true; },
    });
    expect(result).toBe(1);
    expect(bridge.stops).toBe(1);
    expect(restored).toBe(false);
    expect(io.errors[0]).toContain("pre-restore safety backup failed");
    expect(fs.existsSync(path.join(root, "data", "designer.sqlite"))).toBe(true);
  });

  it("rejects a newer verified database before stopping the local service", async () => {
    const root = makeProject(temporaryDirectory());
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "run", "mode"), "local\n");
    const bridge = fakeBridge();
    const io = collectingIo();
    let delegated = false;
    const result = await runCli(["backup", "restore", path.join(root, "incoming.tar"), "--yes"], {
      projectRoot: root,
      bridge,
      io,
      backupVerifier: async () => backupVerification(CLI_SUPPORTED_DATABASE_VERSION + 1),
      commandRunner: async () => { delegated = true; return { exitCode: 0, stdout: "", stderr: "" }; },
      restoreVerifiedBackup: async () => undefined,
    });
    expect(result).toBe(1);
    expect(delegated).toBe(false);
    expect(bridge.stops).toBe(0);
    expect(io.errors[0]).toContain("newer than this formaspecctl supports");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackupVerification } from "./backup.js";
import type { BridgeController } from "./bridge-lifecycle.js";
import { runCli, type CliIo } from "./command.js";
import { CLI_SUPPORTED_DATABASE_VERSION } from "./migrations.js";
import type { CommandOptions } from "./process.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeBridge(): BridgeController & { starts: number; stops: number; authorizations: number } {
  return {
    starts: 0,
    stops: 0,
    authorizations: 0,
    async ensureStarted() {
      this.starts += 1;
      return { running: true, url: "http://127.0.0.1:4312", owned: true };
    },
    async authorizeAgent() {
      this.authorizations += 1;
      return { connectionId: "connection_test", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
    async stop() { this.stops += 1; return true; },
    async status() { return { running: false, url: "http://127.0.0.1:4312", owned: false }; },
  };
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

function makeProject(root: string): string {
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const launcher = path.join(root, "designer");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return root;
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
    printf '{"name":"formaspec","transport":{"type":"streamable_http","url":"%s","bearer_token_env_var":null,"http_headers":null,"env_http_headers":null}}\\n' "$url"
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
  printf '{"installed":[]}\n'
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "add" ]; then exit 0; fi
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
    FAKE_CODEX_CONFIG: path.join(root, ".codex", "config.toml"),
  };
}

describe("formaspecctl", () => {
  it("requires authorization before changing Codex", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const bridge = fakeBridge();
    const io = collectingIo();
    const result = await runCli(["agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      confirm: async () => false,
      environment: fakeEnvironment(root, bin, log, state),
    });
    expect(result).toBe(1);
    expect(bridge.starts).toBe(0);
    expect(fs.existsSync(path.join(root, ".codex", "skills", "minimal-ui"))).toBe(false);
    expect(fs.readFileSync(log, "utf8").trim()).toBe("--version");
  });

  it("configures token-free FormaSpec MCP and installs the managed Minimal UI skill and plugin", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), 'model = "test-model"\n');
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
    expect(calls).toContain("plugin add minimal-ui@formaspec --json");
    expect(calls.toLowerCase()).not.toContain("bearer");
    expect(calls.toLowerCase()).not.toContain("token");
    const codexConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain('model = "test-model"');
    expect(codexConfig).toContain('[mcp_servers.formaspec]');
    expect(codexConfig).toContain('default_tools_approval_mode = "writes"');
    expect(codexConfig.toLowerCase()).not.toContain("bearer");
    const skill = fs.readFileSync(path.join(root, ".codex", "skills", "minimal-ui", "SKILL.md"), "utf8");
    expect(skill).toContain("Use FormaSpec");
    expect(skill).toContain("Use Minimal UI");
    expect(skill).toContain("Design this with FormaSpec");
    expect(skill).toContain("Refine this selection with FormaSpec");
    expect(skill).toContain("Redesign this with FormaSpec");
    const marker = JSON.parse(fs.readFileSync(path.join(root, ".codex", "skills", "minimal-ui", ".formaspec-managed.json"), "utf8"));
    expect(marker).toMatchObject({ manager: "formaspecctl", schemaVersion: 1 });
    const marketplace = path.join(root, ".codex", "formaspec-marketplace");
    expect(JSON.parse(fs.readFileSync(path.join(marketplace, ".agents", "plugins", "marketplace.json"), "utf8"))).toMatchObject({ name: "formaspec" });
    expect(JSON.parse(fs.readFileSync(path.join(marketplace, "plugins", "minimal-ui", ".codex-plugin", "plugin.json"), "utf8"))).toMatchObject({
      name: "minimal-ui",
      interface: { displayName: "Minimal UI" },
    });
    expect(io.output).toContain("Codex mention: [@Minimal UI](plugin://minimal-ui@formaspec)");
    expect(await runCli(["--yes", "agent", "connect", "codex"], {
      projectRoot: root,
      bridge,
      io,
      environment: fakeEnvironment(root, bin, log, state),
    })).toBe(0);
    const reconnectedConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(reconnectedConfig.match(/default_tools_approval_mode = "writes"/g)).toHaveLength(1);
  });

  it("does not overwrite an unmanaged Minimal UI skill", async () => {
    const root = makeProject(temporaryDirectory());
    const bin = path.join(root, "bin");
    const log = path.join(root, "codex.log");
    const state = path.join(root, "codex.state");
    installFakeCodex(bin, log, state);
    const skill = path.join(root, ".codex", "skills", "minimal-ui");
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
    let confirmations = 0;
    const io = collectingIo();
    const result = await runCli(["--no-open", "install", "docker"], {
      projectRoot: root,
      bridge,
      io,
      environment,
      commandRunner: runner,
      recordDockerRuntimeBinding: async () => undefined,
      confirm: async () => { confirmations += 1; return true; },
    });
    expect(result).toBe(0);
    expect(confirmations).toBe(1);
    expect(delegated).toEqual(["--yes setup docker", "--yes start docker --no-open"]);
    expect(fs.readFileSync(log, "utf8")).toContain("plugin add minimal-ui@formaspec --json");
    expect(io.output).toContain("FormaSpec installation and startup completed.");
  });

  it("reports a read-only contiguous migration ledger", async () => {
    const root = makeProject(temporaryDirectory());
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

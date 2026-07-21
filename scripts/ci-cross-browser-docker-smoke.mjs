#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const EXPECTED_TESTS = 12;
const DEFAULT_IMAGE = "formaspec/server:local";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? 900_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}: `
      + `${stderr.slice(0, 8_000) || stdout.slice(0, 8_000)}`,
    );
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

function safeEvidenceDirectory(value) {
  const resolved = path.resolve(value);
  assert(resolved.length <= 4_096, "Evidence directory path is too long.");
  assert(!resolved.includes(",") && !/[\r\n\0]/u.test(resolved), "Evidence directory path is unsafe for a Docker bind mount.");
  return resolved;
}

export function parseCrossBrowserResult(output) {
  const match = /(?:^|\n)\s*(\d+) passed \([^)]+\)\s*(?:\n|$)/u.exec(output);
  if (!match) throw new Error("Playwright output did not contain a passing summary.");
  const passed = Number(match[1]);
  assert(Number.isSafeInteger(passed), "Playwright passing count was invalid.");
  assert(output.includes("[firefox-dpr-1]"), "Playwright output did not include Firefox.");
  assert(output.includes("[webkit-dpr-1]"), "Playwright output did not include WebKit.");
  return { passed, firefox: true, webkit: true };
}

export function crossBrowserDockerArgs({ containerName, evidenceDirectory, image }) {
  return [
    "run",
    "--rm",
    "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    // Playwright Firefox creates its own user namespace. Docker's default
    // seccomp profile blocks that clone flag; this relaxation is isolated to
    // the disposable test runner and is not used by production services.
    "--security-opt", "seccomp=unconfined",
    "--pids-limit", "512",
    "--memory", "4g",
    "--cpus", "4",
    "--shm-size", "1g",
    "--tmpfs", "/tmp:size=1g,mode=1777",
    "--mount", `type=bind,source=${evidenceDirectory},target=/app/test-results`,
    "--workdir", "/app/apps/server",
    "--env", "HOME=/tmp/home",
    "--env", "XDG_CACHE_HOME=/tmp/cache",
    "--env", "XDG_CONFIG_HOME=/tmp/config",
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    "mkdir -p /tmp/home /tmp/cache /tmp/config && exec node node_modules/playwright/cli.js test --config playwright.cross-browser.config.ts e2e/selection-alignment.spec.ts",
  ];
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/ci-cross-browser-docker-smoke.mjs\n\n"
      + "Runs the Firefox/WebKit alignment suite inside an existing pinned FormaSpec image.\n"
      + "Set FORMASPEC_CI_EVIDENCE_DIR, FORMASPEC_CI_SOURCE_SHA, or FORMASPEC_CI_IMAGE to override defaults.\n",
    );
    return;
  }
  if (process.argv.length > 2) throw new Error("Unexpected arguments. Use --help for usage.");

  const root = process.cwd();
  const evidenceDirectory = safeEvidenceDirectory(
    process.env.FORMASPEC_CI_EVIDENCE_DIR ?? "artifacts/ci/cross-browser-docker",
  );
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o755 });
  const image = process.env.FORMASPEC_CI_IMAGE?.trim() || DEFAULT_IMAGE;
  assert(/^[A-Za-z0-9./:_-]{1,255}$/u.test(image), "Docker image reference is invalid.");
  const containerName = `formaspeccrossbrowser${randomBytes(5).toString("hex")}`;
  const summary = {
    format: "formaspec-cross-browser-docker-ci-evidence",
    schemaVersion: 1,
    releaseStatus: "NO-GO",
    verificationStatus: "FAILED",
    sourceSha: process.env.FORMASPEC_CI_SOURCE_SHA ?? "local-uncommitted-source",
    image,
    checks: {},
    blockers: [
      "This local Linux Firefox/WebKit run is not retained GitHub-hosted or cross-OS release evidence.",
      "The disposable browser test runner uses seccomp=unconfined so Firefox can create its sandbox namespace; production services do not use this setting.",
    ],
  };
  let log = "";

  try {
    const inspected = JSON.parse(docker(["image", "inspect", image]).stdout);
    assert(Array.isArray(inspected) && inspected.length === 1, "Docker image inspection returned an unexpected result.");
    const imageId = inspected[0]?.Id;
    const user = inspected[0]?.Config?.User;
    assert(/^sha256:[a-f0-9]{64}$/u.test(imageId), "Docker image is not content-addressed.");
    assert(typeof user === "string" && user !== "" && user !== "0" && user !== "root", "Cross-browser image must run as a non-root user.");

    const result = docker(crossBrowserDockerArgs({ containerName, evidenceDirectory, image }), {
      cwd: root,
      timeoutMs: 900_000,
      allowFailure: true,
    });
    log = `${result.stdout}${result.stderr}`;
    if (result.status !== 0) {
      throw new Error(`Cross-browser container exited with ${result.status}: ${log.slice(0, 12_000)}`);
    }
    const parsed = parseCrossBrowserResult(log);
    assert(parsed.passed === EXPECTED_TESTS, `Expected ${EXPECTED_TESTS} passing tests, received ${parsed.passed}.`);

    summary.checks = {
      docker: docker(["--version"]).stdout.trim(),
      imageId,
      imageUser: user,
      testsPassed: parsed.passed,
      browsers: ["firefox", "webkit"],
      networkMode: "none",
      readOnlyRootFilesystem: true,
      capabilitiesDropped: ["ALL"],
      noNewPrivileges: true,
      seccomp: "unconfined-test-runner-only",
    };
    summary.verificationStatus = "PASS";
  } catch (error) {
    summary.error = error instanceof Error ? error.message.slice(0, 12_000) : String(error).slice(0, 12_000);
    throw error;
  } finally {
    docker(["rm", "--force", containerName], { allowFailure: true, timeoutMs: 60_000 });
    const remaining = docker([
      "ps", "--all", "--quiet", "--filter", `name=^/${containerName}$`,
    ], { allowFailure: true, timeoutMs: 30_000 }).stdout.trim();
    summary.checks.cleanup = { containerRemoved: remaining === "" };
    if (remaining !== "") {
      summary.verificationStatus = "FAILED";
      summary.error ??= "Disposable cross-browser container remained after cleanup.";
    }
    writeFileSync(path.join(evidenceDirectory, "run.log"), log, { mode: 0o600 });
    writeJson(path.join(evidenceDirectory, "summary.json"), summary);
  }

  if (summary.verificationStatus !== "PASS") throw new Error(summary.error ?? "Cross-browser Docker smoke failed.");
  process.stdout.write(`Docker Firefox/WebKit smoke passed; retained evidence: ${evidenceDirectory}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

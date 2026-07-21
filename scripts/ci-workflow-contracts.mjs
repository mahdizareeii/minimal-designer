#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_FILES = Object.freeze([
  ".github/workflows/source-ci.yml",
  ".github/workflows/browser-release-gates.yml",
  ".github/workflows/docker-schema11-smoke.yml",
  ".github/workflows/linux-native-packaging.yml",
  ".github/workflows/macos-native-packaging.yml",
]);

const PINNED_ACTIONS = Object.freeze({
  "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
});

function requireText(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label} is missing ${needle}.`);
}

function jobBlocks(text) {
  const jobsIndex = text.indexOf("\njobs:\n");
  if (jobsIndex < 0) throw new Error("Workflow has no jobs mapping.");
  const jobsText = text.slice(jobsIndex + 7);
  const matches = [...jobsText.matchAll(/^  ([a-z][a-z0-9-]+):\n/gmu)];
  return matches.map((match, index) => ({
    name: match[1],
    text: jobsText.slice(match.index, matches[index + 1]?.index ?? jobsText.length),
  }));
}

export function validateWorkflowText(relativePath, text) {
  requireText(text, "permissions:\n  contents: read\n", relativePath);
  const permissionBlocks = [...text.matchAll(/^(\s*)permissions:\n((?:\1  [^\n]+\n)+)/gmu)];
  if (permissionBlocks.length !== 1 || permissionBlocks[0][1] !== "" || permissionBlocks[0][2] !== "  contents: read\n") {
    throw new Error(`${relativePath} must have exactly one top-level contents: read permission block.`);
  }
  requireText(text, "concurrency:\n", relativePath);
  requireText(text, "cancel-in-progress: true", relativePath);
  if (/^\s*pull_request_target:/mu.test(text)) throw new Error(`${relativePath} must not use pull_request_target.`);
  if (/\$\{\{\s*secrets\./u.test(text)) throw new Error(`${relativePath} must not consume repository secrets.`);
  if (/^\s*continue-on-error:\s*true\s*$/mu.test(text)) throw new Error(`${relativePath} must not suppress a failed gate.`);
  if (/\b(?:sign|notarize|cosign|gpg|signtool)\b/iu.test(text)) throw new Error(`${relativePath} must not imply signing or notarization.`);
  if (/\b(?:deploy|publish-release|production-release)\b/iu.test(text)) throw new Error(`${relativePath} must not deploy or publish a release.`);
  const uses = [...text.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)];
  for (const match of uses) {
    const reference = match[1];
    const parsed = /^([^@]+)@([a-f0-9]{40})$/u.exec(reference);
    if (!parsed) throw new Error(`${relativePath} uses a mutable or malformed action reference: ${reference}`);
    if (PINNED_ACTIONS[parsed[1]] !== parsed[2]) throw new Error(`${relativePath} uses an unreviewed action commit: ${reference}`);
  }
  if (uses.length === 0) throw new Error(`${relativePath} uses no pinned actions.`);
  for (const block of jobBlocks(text)) {
    requireText(
      block.text,
      relativePath === ".github/workflows/macos-native-packaging.yml"
        ? "runs-on: macos-14"
        : "runs-on: ubuntu-24.04",
      `${relativePath} job ${block.name}`,
    );
    if (!/^    timeout-minutes: [1-9][0-9]*$/mu.test(block.text)) {
      throw new Error(`${relativePath} job ${block.name} has no positive timeout-minutes.`);
    }
    if (block.text.includes("actions/checkout@")) requireText(block.text, "persist-credentials: false", `${relativePath} job ${block.name}`);
  }
  for (const artifactBlock of text.split("actions/upload-artifact@").slice(1)) {
    if (!/\n\s+name:\s+NO-GO-/u.test(artifactBlock)) throw new Error(`${relativePath} uploads an artifact without a NO-GO name.`);
    if (!/\n\s+retention-days:\s+[1-9][0-9]*/u.test(artifactBlock)) throw new Error(`${relativePath} artifact has no bounded retention.`);
  }
}

export function validateDockerSmokeText(text) {
  for (const contract of [
    "function rendererEgressEvidence(containerId)",
    "dns.lookup(\"example.com\")",
    "host: \"1.1.1.1\", port: 443",
    "externalInterfaceCount: externalInterfaces.length",
    "const rendererEgress = rendererEgressEvidence(containerIds.renderer);",
    "rendererEgress,",
  ]) {
    requireText(text, contract, "Docker smoke");
  }
}

export function validateRepositoryCi(rootDirectory) {
  const workflows = new Map();
  for (const relativePath of WORKFLOW_FILES) {
    const text = readFileSync(path.join(rootDirectory, relativePath), "utf8");
    validateWorkflowText(relativePath, text);
    workflows.set(relativePath, text);
  }
  const source = workflows.get(".github/workflows/source-ci.yml");
  if (source.includes(" -- --target") || source.includes(" -- --output")) {
    throw new Error("Source evidence arguments must not pass a literal -- token to the Node script.");
  }
  for (const command of [
    "pnpm install --frozen-lockfile --strict-peer-dependencies",
    "pnpm audit --audit-level high",
    "pnpm test:ci-workflows",
    "pnpm test:macos-pkg-runtime-smoke",
    "pnpm typecheck",
    "pnpm test:run",
    "pnpm build",
    "pnpm test:launcher",
    "docker compose config --quiet",
    "pnpm test:release-evidence",
    "pnpm release:evidence:generate",
    "pnpm release:evidence:check",
  ]) requireText(source, command, "source workflow");

  const browser = workflows.get(".github/workflows/browser-release-gates.yml");
  for (const gate of [
    "test:e2e:alignment",
    "test:e2e:alignment:cross-browser",
    "test:e2e:editor",
    "test:e2e:visual",
    "test:e2e:performance",
    "test:e2e:release",
  ]) {
    requireText(browser, gate, "browser workflow");
  }
  requireText(browser, "playwright install --with-deps chromium", "browser workflow");
  requireText(browser, "playwright install --with-deps firefox webkit", "browser workflow");
  requireText(browser, "matrix.gate == 'alignment-cross-browser'", "browser workflow");
  requireText(browser, "PLAYWRIGHT_BROWSERS_PATH: ${{ runner.temp }}/ms-playwright", "browser workflow");
  requireText(browser, "FORMASPEC_ALLOW_SYSTEM_CHROME: \"false\"", "browser workflow");

  const docker = workflows.get(".github/workflows/docker-schema11-smoke.yml");
  requireText(docker, "node scripts/ci-docker-schema11-smoke.mjs", "Docker workflow");
  requireText(docker, "node scripts/ci-cross-browser-docker-smoke.mjs", "Docker workflow");
  requireText(docker, "node scripts/ci-offhost-restore-smoke.mjs", "Docker workflow");
  requireText(docker, "docker compose config --quiet", "Docker workflow");
  requireText(docker, "FORMASPEC_CI_IMAGE: formaspec/server:local", "Docker workflow");
  requireText(docker, "FORMASPEC_CI_EVIDENCE_DIR: artifacts/ci/cross-browser-docker", "Docker workflow");
  requireText(docker, "name: NO-GO-cross-browser-docker-${{ github.sha }}", "Docker workflow");
  requireText(docker, "path: artifacts/ci/cross-browser-docker/", "Docker workflow");
  requireText(docker, "FORMASPEC_CI_EVIDENCE_DIR: artifacts/ci/offhost-restore-simulation", "Docker workflow");
  requireText(docker, "name: NO-GO-offhost-restore-${{ github.sha }}", "Docker workflow");
  requireText(docker, "path: artifacts/ci/offhost-restore-simulation/", "Docker workflow");

  const linux = workflows.get(".github/workflows/linux-native-packaging.yml");
  if (linux.includes(" -- --target") || linux.includes(" -- --output")) {
    throw new Error("Linux evidence arguments must not pass a literal -- token to the Node script.");
  }
  for (const command of [
    "build-linux-deb.js",
    "build-linux-rpm.js",
    "ci-linux-package-evidence.mjs",
    "pnpm release:evidence:check --output artifacts/ci/linux-source-evidence",
    "rpmbuild --version",
    "playwright --version",
    "PLAYWRIGHT_BROWSERS_PATH: ${{ runner.temp }}/ms-playwright",
    "SOURCE_DATE_EPOCH: \"0\"",
  ]) requireText(linux, command, "Linux packaging workflow");
  if (/\b(?:dpkg\s+(?:--install|-i)|rpm\s+(?:--install|-i))\b/u.test(linux)) {
    throw new Error("Linux packaging workflow must not install generated artifacts.");
  }

  const macos = workflows.get(".github/workflows/macos-native-packaging.yml");
  for (const command of [
    "pnpm install --frozen-lockfile --strict-peer-dependencies",
    "playwright install chromium",
    "pnpm test:macos-pkg-evidence",
    "pnpm test:macos-pkg-runtime-smoke",
    "build-macos.js",
    "release-evidence.mjs generate",
    "release-evidence.mjs check",
    "macos-pkg-evidence.mjs generate",
    "macos-pkg-evidence.mjs verify",
    "ci-macos-pkg-runtime-smoke.mjs",
    "CHROMIUM_RUNTIME_CONTAINS_LGPL_NOTICES",
    "PACKAGE_UNSIGNED",
    "NOTARIZATION_EVIDENCE_MISSING",
    "REPRODUCIBILITY_EVIDENCE_MISSING",
    "VULNERABILITY_SCAN_MISSING",
    "name: NO-GO-unsigned-macos-foundation-${{ github.sha }}",
  ]) requireText(macos, command, "macOS packaging workflow");
  if (/^\s*pull_request:/mu.test(macos)) {
    throw new Error("macOS packaging workflow must not build native artifacts for pull requests.");
  }
  if (/^\s*(?:sudo\s+)?(?:\/usr\/sbin\/)?(?:installer|launchctl|security|osascript|codex)\s+/imu.test(macos)) {
    throw new Error("macOS packaging workflow must not install packages or invoke user-agent/credential tooling.");
  }

  const nodeVersion = readFileSync(path.join(rootDirectory, ".node-version"), "utf8").trim();
  if (nodeVersion !== "24.14.0") throw new Error(".node-version must pin Node.js 24.14.0.");
  const rootPackage = JSON.parse(readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
  if (rootPackage.packageManager !== "pnpm@11.9.0") throw new Error("packageManager must pin pnpm 11.9.0.");
  const serverPackage = JSON.parse(readFileSync(path.join(rootDirectory, "apps/server/package.json"), "utf8"));
  if (serverPackage.dependencies?.playwright !== "1.61.1") throw new Error("Server must pin Playwright 1.61.1 exactly.");
  const dockerfile = readFileSync(path.join(rootDirectory, "Dockerfile"), "utf8");
  if (!/^FROM mcr\.microsoft\.com\/playwright:v1\.61\.1-noble@sha256:[a-f0-9]{64}$/mu.test(dockerfile)) {
    throw new Error("Dockerfile must pin the Playwright 1.61.1 image by digest.");
  }
  validateDockerSmokeText(readFileSync(path.join(rootDirectory, "scripts/ci-docker-schema11-smoke.mjs"), "utf8"));
  return { workflows: WORKFLOW_FILES.length, actions: PINNED_ACTIONS };
}

function main() {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateRepositoryCi(rootDirectory);
  process.stdout.write(`CI workflow contracts passed: ${result.workflows} workflows; immutable action refs; explicit NO-GO evidence.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

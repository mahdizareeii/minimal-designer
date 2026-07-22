import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_FIXED_RESOURCES,
  EXPECTED_MCP_TOOL_NAMES,
  EXPECTED_RESOURCE_TEMPLATES,
  MACOS_RUNTIME_SMOKE_CONTRACT,
  assertNonInstallingExecutable,
  canonicalJson,
  filesystemTargetsUnchanged,
  inspectBrowserPayload,
  inspectManagedCodexAssets,
  parseArguments,
  requireContainedDirectory,
  requireContainedRegular,
  snapshotFilesystemTargets,
  writeNoGoSummary,
} from "./ci-macos-pkg-runtime-smoke.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

function temporaryRoot(prefix = "formaspec-macos-smoke-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("pins the current extracted native runtime contract", () => {
  assert.deepEqual(MACOS_RUNTIME_SMOKE_CONTRACT, {
    nodeVersion: "v24.14.0",
    playwrightRevision: "1228",
    schemaVersion: 13,
    mcpProtocolVersion: "2025-06-18",
    mcpToolCount: 52,
    mcpResourceCount: 25,
    maximumPackageBytes: 8 * 1024 * 1024 * 1024,
    maximumCommandOutputBytes: 16 * 1024 * 1024,
    maximumHttpResponseBytes: 16 * 1024 * 1024,
    startupTimeoutMs: 120_000,
    commandTimeoutMs: 180_000,
  });
  assert.equal(EXPECTED_MCP_TOOL_NAMES.length, 52);
  assert.equal(new Set(EXPECTED_MCP_TOOL_NAMES).size, 52);
  assert.equal(EXPECTED_FIXED_RESOURCES.length, 4);
  assert.equal(EXPECTED_RESOURCE_TEMPLATES.length, 21);
  assert.equal(
    new Set([...EXPECTED_FIXED_RESOURCES, ...EXPECTED_RESOURCE_TEMPLATES].map((entry) => entry.name)).size,
    25,
  );
  assert.ok([...EXPECTED_FIXED_RESOURCES, ...EXPECTED_RESOURCE_TEMPLATES]
    .every((entry) => entry.uri.startsWith("formaspec://")));
});

test("canonical evidence sorts object keys recursively while preserving array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ q: 1, a: 2 }, "fixed"] }), [
    "{",
    "  \"a\": {",
    "    \"b\": 3,",
    "    \"y\": 2",
    "  },",
    "  \"list\": [",
    "    {",
    "      \"a\": 2,",
    "      \"q\": 1",
    "    },",
    "    \"fixed\"",
    "  ],",
    "  \"z\": 1",
    "}",
    "",
  ].join("\n"));
});

test("browser inspection accepts only the exact executable Chromium headless-shell revision", () => {
  const root = temporaryRoot();
  const browser = path.join(
    root,
    "chromium_headless_shell-1228",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
  fs.mkdirSync(path.dirname(browser), { recursive: true });
  fs.writeFileSync(browser, "fixture\n", { mode: 0o755 });

  const inspected = inspectBrowserPayload(root, "1228", "arm64");
  assert.equal(inspected.directory, "chromium_headless_shell-1228");
  assert.equal(inspected.revision, "1228");
  assert.equal(inspected.executableRelativePath, "chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  assert.match(inspected.contentTreeSha256, /^[a-f0-9]{64}$/u);

  fs.mkdirSync(path.join(root, "ffmpeg-1011"));
  assert.throws(() => inspectBrowserPayload(root, "1228", "arm64"), /must contain only chromium_headless_shell-1228/u);
});

test("browser inspection rejects a non-executable browser and unsupported host architecture", () => {
  const root = temporaryRoot();
  const browser = path.join(
    root,
    "chromium_headless_shell-1228",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
  fs.mkdirSync(path.dirname(browser), { recursive: true });
  fs.writeFileSync(browser, "fixture\n", { mode: 0o644 });
  assert.throws(() => inspectBrowserPayload(root, "1228", "arm64"), /not executable/u);
  assert.throws(() => inspectBrowserPayload(root, "1228", "ia32"), /Unsupported macOS runtime architecture/u);
});

function writeManagedCodexAsset(root, relativePath, contents) {
  const filename = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function managedCodexAssetsFixture() {
  const root = temporaryRoot("formaspec-macos-codex-assets-");
  const skill = "---\nname: formaspec\ndescription: Fixture.\n---\n";
  const metadata = [
    "interface:",
    "  display_name: \"FormaSpec\"",
    "  default_prompt: \"Use $formaspec to design this interface with FormaSpec.\"",
    "",
  ].join("\n");
  writeManagedCodexAsset(root, "skills/formaspec/SKILL.md", skill);
  writeManagedCodexAsset(root, "skills/formaspec/agents/openai.yaml", metadata);
  writeManagedCodexAsset(root, "codex-marketplace/.agents/plugins/marketplace.json", `${JSON.stringify({
    name: "formaspec",
    interface: { displayName: "FormaSpec" },
    plugins: [{ name: "formaspec", source: { source: "local", path: "./plugins/formaspec" } }],
  })}\n`);
  writeManagedCodexAsset(root, "codex-marketplace/plugins/formaspec/.codex-plugin/plugin.json", `${JSON.stringify({
    name: "formaspec",
    interface: { displayName: "FormaSpec" },
  })}\n`);
  writeManagedCodexAsset(root, "codex-marketplace/plugins/formaspec/skills/formaspec/SKILL.md", skill);
  writeManagedCodexAsset(root, "codex-marketplace/plugins/formaspec/skills/formaspec/agents/openai.yaml", metadata);
  return root;
}

test("packaged Codex assets expose only the canonical FormaSpec agent identity", () => {
  const root = managedCodexAssetsFixture();
  assert.deepEqual(inspectManagedCodexAssets(root), {
    skillName: "formaspec",
    pluginId: "formaspec@formaspec",
    displayName: "FormaSpec",
    mention: "[@FormaSpec](plugin://formaspec@formaspec)",
  });

  fs.mkdirSync(path.join(root, "skills/minimal-ui"), { recursive: true });
  assert.throws(() => inspectManagedCodexAssets(root), /legacy managed Codex path/u);
});

test("nested containment accepts a canonicalized temporary root without allowing escapes", () => {
  const root = temporaryRoot("formaspec-macos-containment-");
  const child = path.join(root, "child");
  const nested = path.join(child, "nested");
  const file = path.join(nested, "entry.js");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(file, "export {};\n");

  const canonicalChild = requireContainedDirectory(root, child, "Child");
  assert.equal(requireContainedDirectory(root, path.join(canonicalChild, "nested"), "Nested"), fs.realpathSync(nested));
  assert.equal(requireContainedRegular(root, path.join(canonicalChild, "nested", "entry.js"), "Entry"), fs.realpathSync(file));
  assert.throws(() => requireContainedDirectory(root, path.dirname(fs.realpathSync(root)), "Escape"), /escapes/u);
});

test("system-target snapshots detect changes without following symlinks", () => {
  const root = temporaryRoot();
  const file = path.join(root, "managed-file");
  const missing = path.join(root, "missing");
  fs.writeFileSync(file, "one\n");
  const before = snapshotFilesystemTargets([file, missing]);
  const same = snapshotFilesystemTargets([file, missing]);
  assert.equal(filesystemTargetsUnchanged(before, same), true);
  fs.writeFileSync(file, "two\n");
  const after = snapshotFilesystemTargets([file, missing]);
  assert.equal(filesystemTargetsUnchanged(before, after), false);

  const link = path.join(root, "link");
  fs.symlinkSync(file, link);
  const links = snapshotFilesystemTargets([link]);
  assert.deepEqual(links[link], {
    state: "present",
    type: "symlink",
    device: links[link].device,
    inode: links[link].inode,
    mode: links[link].mode,
    size: links[link].size,
    modifiedNanoseconds: links[link].modifiedNanoseconds,
    target: file,
  });
});

test("the command boundary rejects installer, service, Keychain, Codex, and browser execution", () => {
  for (const executable of [
    "/usr/sbin/installer",
    "/bin/launchctl",
    "/usr/bin/security",
    "/usr/bin/open",
    "/usr/bin/osascript",
    "/usr/local/bin/codex",
  ]) assert.throws(() => assertNonInstallingExecutable(executable), /forbids invoking/u);
  assert.doesNotThrow(() => assertNonInstallingExecutable("/usr/sbin/pkgutil"));
  assert.doesNotThrow(() => assertNonInstallingExecutable("/private/tmp/extracted/node", "/private/tmp/extracted/node"));
  assert.throws(() => assertNonInstallingExecutable("/bin/sh", "/private/tmp/extracted/node"), /does not allow executable/u);
});

test("argument parsing requires exactly one package and output path", () => {
  const parsed = parseArguments(["--pkg", "fixture.pkg", "--output", "evidence"]);
  assert.equal(parsed.packagePath, path.resolve("fixture.pkg"));
  assert.equal(parsed.outputDirectory, path.resolve("evidence"));
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.throws(() => parseArguments(["--pkg", "fixture.pkg"]), /Usage:/u);
  assert.throws(
    () => parseArguments(["--pkg", "one.pkg", "--pkg", "two.pkg", "--output", "evidence"]),
    /may be supplied only once/u,
  );
  assert.throws(() => parseArguments(["--pkg", "fixture.pkg", "--output", "evidence", "--install"]), /Unknown argument/u);
});

test("NO-GO summary output is canonical, checksum-bound, private, and immutable", () => {
  const root = temporaryRoot();
  const output = path.join(root, "evidence");
  const summary = {
    verificationStatus: "PASS",
    releaseStatus: "NO-GO",
    format: "fixture",
    checks: { z: true, a: true },
  };
  const written = writeNoGoSummary(output, summary);
  const summaryPath = path.join(output, "NO-GO-SUMMARY.json");
  const checksumPath = path.join(output, "SHA256SUMS");
  const text = fs.readFileSync(summaryPath, "utf8");
  assert.equal(text, canonicalJson(summary));
  assert.equal(written.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(fs.readFileSync(checksumPath, "utf8"), `${written.sha256}  NO-GO-SUMMARY.json\n`);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.throws(() => writeNoGoSummary(output, summary), /output already exists/u);
});

test("source contract contains no shell execution or forbidden native lifecycle command", () => {
  const source = fs.readFileSync(path.join(rootDirectory, "scripts/ci-macos-pkg-runtime-smoke.mjs"), "utf8");
  assert.doesNotMatch(source, /execSync|execFile|shell:\s*true/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /--expand-full/u);
  assert.match(source, /releaseStatus:\s*"NO-GO"/u);
  assert.match(source, /installerInvoked:\s*false/u);
  assert.match(source, /launchctlInvoked:\s*false/u);
  assert.match(source, /keychainInvoked:\s*false/u);
  assert.match(source, /codexInvoked:\s*false/u);
  assert.match(source, /browserOpenerInvoked:\s*false/u);
  assert.match(source, /formaspecWorkflowPresent:\s*true/u);
  assert.doesNotMatch(source, /minimalUiWorkflowPresent/u);
});

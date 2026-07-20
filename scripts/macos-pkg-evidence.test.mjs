import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildMacPackageEvidence,
  parseBomPaths,
  parsePackageInfo,
  parseSha256Sidecar,
  readSourceReleaseEvidence,
  renderMacPackageEvidence,
  scanPackageTree,
  scanPackagedNpmComponents,
  verifyPackagedWorkspaceTrees,
  verifyMacPackageEvidence,
  writeMacPackageEvidence,
} from "./macos-pkg-evidence-lib.mjs";
import { deterministicJson, sha256 } from "./release-evidence-lib.mjs";

const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const serverTreeSpecification = Object.freeze([
  Object.freeze({ id: "server-dist", kind: "build-output", relativePath: "apps/server/dist" }),
]);

function writeTreeFile(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function workspaceTreeRoots(prefix = "formaspec-workspace-tree-") {
  const directory = temporaryDirectory(prefix);
  const workspace = path.join(directory, "workspace");
  const payload = path.join(directory, "payload");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(payload, { recursive: true });
  return {
    workspace,
    payload,
    sourceDist: path.join(workspace, "apps", "server", "dist"),
    payloadDist: path.join(
      payload,
      "Library",
      "Application Support",
      "FormaSpec",
      "app",
      "apps",
      "server",
      "dist",
    ),
  };
}

function sourceComponent(name, version, firstParty = false, manifest = undefined) {
  const purl = name.startsWith("@")
    ? `pkg:npm/${encodeURIComponent(name.slice(0, name.indexOf("/")))}/${name.slice(name.indexOf("/") + 1)}@${version}`
    : `pkg:npm/${name}@${version}`;
  return {
    "bom-ref": purl,
    type: firstParty ? "application" : "library",
    name,
    version,
    purl,
    properties: firstParty
      ? [
          { name: "formaspec:first-party", value: "true" },
          { name: "formaspec:workspace:manifest", value: manifest },
          { name: "formaspec:workspace:manifest-sha256", value: "b".repeat(64) },
        ]
      : [{ name: "formaspec:evidence:package-manifest-sha256", value: "b".repeat(64) }],
  };
}

function writeSourceEvidence(directory) {
  const root = sourceComponent("formaspec", "0.2.0", true, "package.json");
  const server = sourceComponent("@formaspec/server", "0.1.0", true, "apps/server/package.json");
  const dependency = sourceComponent("alpha", "1.0.0");
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      component: root,
      properties: [{ name: "formaspec:evidence:target", value: "darwin-arm64" }],
    },
    components: [server, dependency],
    dependencies: [
      { ref: root["bom-ref"], dependsOn: [server["bom-ref"]] },
      { ref: server["bom-ref"], dependsOn: [dependency["bom-ref"]] },
      { ref: dependency["bom-ref"], dependsOn: [] },
    ],
  };
  const licenses = {
    target: "darwin-arm64",
    policy: { status: "pass" },
    packages: [{ purl: dependency.purl }],
    violations: [],
  };
  const bomText = deterministicJson(bom);
  const licenseText = deterministicJson(licenses);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "formaspec.cdx.json"), bomText);
  fs.writeFileSync(path.join(directory, "licenses.json"), licenseText);
  fs.writeFileSync(
    path.join(directory, "SHA256SUMS"),
    `${sha256(bomText)}  formaspec.cdx.json\n${sha256(licenseText)}  licenses.json\n`,
  );
  return { root, server, dependency };
}

test("parses one canonical PKG checksum sidecar", () => {
  const digest = "a".repeat(64);
  assert.equal(parseSha256Sidecar(`${digest}  FormaSpec-0.2.0-macos-arm64-unsigned.pkg\n`, "FormaSpec-0.2.0-macos-arm64-unsigned.pkg"), digest);
  assert.throws(
    () => parseSha256Sidecar(`${digest}  ../FormaSpec.pkg\n`, "FormaSpec.pkg"),
    /canonical SHA-256/u,
  );
});

test("parses strict component PackageInfo metadata", () => {
  const parsed = parsePackageInfo(`<?xml version="1.0"?><pkg-info identifier="com.formaspec.pkg" version="0.2.0" install-location="/" auth="root" generator-version="InstallCmds-1"><payload numberOfFiles="12" installKBytes="34"/><scripts><preinstall file="./preinstall"/><postinstall file="./postinstall"/></scripts></pkg-info>`);
  assert.deepEqual(parsed, {
    identifier: "com.formaspec.pkg",
    version: "0.2.0",
    installLocation: "/",
    auth: "root",
    generatorVersion: "InstallCmds-1",
    numberOfFiles: 12,
    installKBytes: 34,
    scripts: ["preinstall", "postinstall"],
  });
});

test("hashes a package tree deterministically and reports AppleDouble entries", () => {
  const root = temporaryDirectory("formaspec-pkg-tree-");
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "file.txt"), "payload");
  fs.writeFileSync(path.join(root, "a", "._file.txt"), "metadata");
  fs.symlinkSync("file.txt", path.join(root, "a", "link"));
  const first = scanPackageTree(root);
  const second = scanPackageTree(root);
  assert.equal(first.treeSha256, second.treeSha256);
  assert.equal(first.appleDoubleEntryCount, 1);
  assert.equal(first.symlinkCount, 1);
  fs.writeFileSync(path.join(root, "a", "file.txt"), "changed");
  assert.notEqual(scanPackageTree(root).treeSha256, first.treeSha256);
});

test("rejects unsafe BOM paths and payload symlinks", () => {
  assert.throws(() => parseBomPaths(".\n../outside\n"), /safe package-relative path/u);
  const root = temporaryDirectory("formaspec-pkg-link-");
  fs.symlinkSync("../outside", path.join(root, "escape"));
  assert.throws(() => scanPackageTree(root), /escapes its root/u);
});

test("verifies exact packaged workspace file sets and content hashes", () => {
  const roots = workspaceTreeRoots();
  writeTreeFile(roots.sourceDist, "index.js", "export const version = 1;\n");
  writeTreeFile(roots.sourceDist, "nested/index.js.map", "{\"version\":3}\n");
  writeTreeFile(roots.payloadDist, "index.js", "export const version = 1;\n");
  writeTreeFile(roots.payloadDist, "nested/index.js.map", "{\"version\":3}\n");
  fs.symlinkSync("index.js", path.join(roots.sourceDist, "current.js"));
  fs.symlinkSync("index.js", path.join(roots.payloadDist, "current.js"));

  const verification = verifyPackagedWorkspaceTrees(
    roots.workspace,
    roots.payload,
    serverTreeSpecification,
  );
  assert.equal(verification.status, "pass");
  assert.equal(verification.treeCount, 1);
  assert.equal(verification.regularFileCount, 2);
  assert.equal(verification.symlinkCount, 1);
  assert.match(verification.contentSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    verification.trees[0].entries.filter((entry) => entry.type !== "directory").map((entry) => entry.path),
    ["current.js", "index.js", "nested/index.js.map"],
  );
});

test("rejects missing, extra, and content-mismatched packaged workspace files", () => {
  const roots = workspaceTreeRoots();
  writeTreeFile(roots.sourceDist, "app.js", "current app\n");
  writeTreeFile(roots.sourceDist, "backup.js", "current backup\n");
  writeTreeFile(roots.payloadDist, "app.js", "current app\n");
  writeTreeFile(roots.payloadDist, "backup.js", "current backup\n");

  fs.rmSync(path.join(roots.payloadDist, "backup.js"));
  assert.throws(
    () => verifyPackagedWorkspaceTrees(roots.workspace, roots.payload, serverTreeSpecification),
    /missing=backup\.js/u,
  );

  writeTreeFile(roots.payloadDist, "backup.js", "current backup\n");
  writeTreeFile(roots.payloadDist, "unexpected.js", "extra\n");
  assert.throws(
    () => verifyPackagedWorkspaceTrees(roots.workspace, roots.payload, serverTreeSpecification),
    /extra=unexpected\.js/u,
  );

  fs.rmSync(path.join(roots.payloadDist, "unexpected.js"));
  writeTreeFile(roots.payloadDist, "app.js", "stale app\n");
  assert.throws(
    () => verifyPackagedWorkspaceTrees(roots.workspace, roots.payload, serverTreeSpecification),
    /mismatched=app\.js/u,
  );
});

test("rejects a stale server build with omitted renderer endpoint output", () => {
  const roots = workspaceTreeRoots("formaspec-stale-server-tree-");
  const rendererEndpointFiles = [
    "renderer-endpoint.d.ts",
    "renderer-endpoint.d.ts.map",
    "renderer-endpoint.js",
    "renderer-endpoint.js.map",
  ];
  const staleFiles = [
    "app.js",
    "backup.js",
    "config.js",
    "operations-service.js",
    "renderer-worker.js",
    "restore-worker.js",
  ];
  for (const filename of rendererEndpointFiles) {
    writeTreeFile(roots.sourceDist, filename, `current ${filename}\n`);
  }
  for (const filename of staleFiles) {
    writeTreeFile(roots.sourceDist, filename, `current ${filename}\n`);
    writeTreeFile(roots.payloadDist, filename, `stale ${filename}\n`);
  }

  assert.throws(
    () => verifyPackagedWorkspaceTrees(roots.workspace, roots.payload, serverTreeSpecification),
    (error) => {
      assert.match(error.message, /missing=renderer-endpoint\.d\.ts,renderer-endpoint\.d\.ts\.map,renderer-endpoint\.js,renderer-endpoint\.js\.map/u);
      assert.match(error.message, /mismatched=app\.js,backup\.js,config\.js,operations-service\.js,renderer-worker\.js,restore-worker\.js/u);
      return true;
    },
  );
});

test("validates source evidence checksums and target metadata", () => {
  const directory = temporaryDirectory("formaspec-source-evidence-");
  writeSourceEvidence(directory);
  const evidence = readSourceReleaseEvidence(directory);
  assert.equal(evidence.target, "darwin-arm64");
  assert.equal(evidence.thirdPartyPurls.size, 1);
  fs.appendFileSync(path.join(directory, "licenses.json"), " ");
  assert.throws(() => readSourceReleaseEvidence(directory), /checksums do not match/u);
});

test("inventories pnpm package roots and links packaged workspaces", () => {
  const payload = temporaryDirectory("formaspec-pkg-components-");
  const sourceDirectory = temporaryDirectory("formaspec-source-components-");
  writeSourceEvidence(sourceDirectory);
  const source = readSourceReleaseEvidence(sourceDirectory);
  const appRoot = path.join(payload, "Library", "Application Support", "FormaSpec", "app");
  const dependencyRoot = path.join(appRoot, "node_modules", ".pnpm", "alpha@1.0.0", "node_modules", "alpha");
  fs.mkdirSync(dependencyRoot, { recursive: true });
  fs.writeFileSync(path.join(dependencyRoot, "package.json"), deterministicJson({ name: "alpha", version: "1.0.0", license: "MIT" }));
  fs.mkdirSync(path.join(appRoot, "apps", "server"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), deterministicJson({ name: "formaspec", version: "0.2.0", private: true }));
  fs.writeFileSync(path.join(appRoot, "apps", "server", "package.json"), deterministicJson({ name: "@formaspec/server", version: "0.1.0", private: true }));
  const inventory = scanPackagedNpmComponents(payload, source);
  assert.deepEqual([...inventory.records.keys()].sort(), [
    "pkg:npm/%40formaspec/server@0.1.0",
    "pkg:npm/alpha@1.0.0",
    "pkg:npm/formaspec@0.2.0",
  ]);
  assert.deepEqual(inventory.excludedSourceWorkspaces, []);
});

function evidenceFixture(directory) {
  const sourceDirectory = path.join(directory, "source");
  writeSourceEvidence(sourceDirectory);
  const sourceEvidence = readSourceReleaseEvidence(sourceDirectory);
  const records = new Map();
  for (const component of [...sourceEvidence.byPurl.values()]) {
    records.set(component.purl, {
      purl: component.purl,
      name: component.name,
      version: component.version,
      kind: component.purl === "pkg:npm/alpha@1.0.0" ? "third-party" : "workspace",
      manifestSha256: "b".repeat(64),
      paths: [`Library/Application Support/FormaSpec/app/${component.name}/package.json`],
      instanceCount: 1,
    });
  }
  const runtime = {
    "bom-ref": "pkg:generic/nodejs-runtime@unreported?arch=arm64",
    type: "framework",
    name: "Node.js bundled runtime",
    version: "unreported",
    purl: "pkg:generic/nodejs-runtime@unreported?arch=arm64",
    hashes: [{ alg: "SHA-256", content: "c".repeat(64) }],
    licenses: [{ license: { id: "MIT" } }],
    properties: [],
  };
  return buildMacPackageEvidence({
    artifact: {
      filename: "FormaSpec-0.2.0-macos-arm64-unsigned.pkg",
      sha256: "d".repeat(64),
      size: 100,
      checksumSidecar: "FormaSpec-0.2.0-macos-arm64-unsigned.pkg.sha256",
      checksumSidecarStatus: "pass",
      version: "0.2.0",
      architecture: "arm64",
      signed: false,
    },
    signature: { status: "unsigned", tool: "pkgutil", exitCode: 1 },
    packageMetadata: {
      identifier: "com.formaspec.pkg",
      version: "0.2.0",
      installLocation: "/",
      auth: "root",
      generatorVersion: "InstallCmds-1",
      installKBytes: 1,
      componentFilename: "FormaSpec.component.pkg",
    },
    payload: {
      entryCount: 10,
      regularFileCount: 7,
      directoryCount: 3,
      symlinkCount: 0,
      logicalBytes: 100,
      treeSha256: "e".repeat(64),
      bomPathCount: 10,
      bomPathSetSha256: "f".repeat(64),
      appleDoubleEntryCount: 0,
      extractedAppleDoubleEntryCount: 0,
    },
    installerScripts: [{ path: "preinstall", sha256: "1".repeat(64), size: 1, mode: "0755" }],
    keyFiles: [{ path: "VERSION", sha256: "2".repeat(64), size: 6, mode: "0644" }],
    sourceEvidence,
    packagedComponents: { records, excludedSourceWorkspaces: [] },
    workspaceTreeVerification: {
      status: "pass",
      treeCount: 1,
      entryCount: 2,
      regularFileCount: 1,
      directoryCount: 1,
      symlinkCount: 0,
      logicalBytes: 10,
      contentSha256: "3".repeat(64),
      trees: [{
        id: "server-dist",
        kind: "build-output",
        workspacePath: "apps/server/dist",
        artifactPath: "Library/Application Support/FormaSpec/app/apps/server/dist",
        entryCount: 2,
        regularFileCount: 1,
        directoryCount: 1,
        symlinkCount: 0,
        logicalBytes: 10,
        pathSetSha256: "4".repeat(64),
        contentTreeSha256: "5".repeat(64),
        entries: [
          { path: ".", type: "directory" },
          { path: "index.js", type: "file", size: 10, sha256: "6".repeat(64) },
        ],
      }],
    },
    runtimeInventory: {
      components: [runtime],
      blockers: [{ code: "NODE_RUNTIME_LICENSE_EVIDENCE_MISSING", component: runtime.purl, detail: "license-evidence-missing" }],
      browserDirectories: ["chromium-1"],
    },
  });
}

test("builds linked artifact SBOM and explicit unsigned/unscanned NO-GO metadata", () => {
  const directory = temporaryDirectory("formaspec-pkg-evidence-build-");
  const evidence = evidenceFixture(directory);
  assert.equal(evidence.verification.schemaVersion, 2);
  assert.equal(evidence.verification.integrityStatus, "pass");
  assert.equal(evidence.verification.releaseDecision, "no-go");
  assert.ok(evidence.verification.blockers.some((blocker) => blocker.code === "PACKAGE_UNSIGNED"));
  assert.ok(evidence.verification.blockers.some((blocker) => blocker.code === "VULNERABILITY_SCAN_MISSING"));
  assert.match(evidence.bom.metadata.component.externalReferences[0].url, /^urn:formaspec:source-sbom:sha256:/u);
  assert.equal(evidence.componentInventory.summary.missingSourceThirdPartyCount, 0);
  assert.equal(evidence.componentInventory.summary.workspaceTreeCount, 1);
  assert.equal(evidence.verification.workspaceTrees.contentSha256, "3".repeat(64));
});

test("writes deterministic artifact evidence and detects drift", () => {
  const directory = temporaryDirectory("formaspec-pkg-evidence-write-");
  const evidence = evidenceFixture(directory);
  const files = renderMacPackageEvidence(evidence);
  const output = path.join(directory, "output");
  writeMacPackageEvidence(output, files);
  assert.deepEqual(verifyMacPackageEvidence(output, files), []);
  fs.writeFileSync(path.join(output, "verification.json"), "{}\n");
  assert.deepEqual(verifyMacPackageEvidence(output, files), [
    "verification.json does not match the current artifact and source evidence",
  ]);
});

test("pins the exact Node v24.14.0 license and source-archive provenance", () => {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const licenseDirectory = path.join(scriptDirectory, "..", "apps", "installer", "assets", "licenses");
  const license = fs.readFileSync(path.join(licenseDirectory, "node-v24.14.0-LICENSE"));
  const provenance = JSON.parse(
    fs.readFileSync(path.join(licenseDirectory, "node-v24.14.0-provenance.json"), "utf8"),
  );
  assert.equal(sha256(license), "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18");
  assert.equal(license.length, 156_926);
  assert.equal(provenance.version, "24.14.0");
  assert.equal(provenance.licenseSha256, sha256(license));
  assert.equal(provenance.licenseSizeBytes, license.length);
  assert.equal(
    provenance.sourceArchiveSha256,
    "9fe025ef4028aba95d16e7810518bf4a5e8abfb0bdc07d8a3fdbb0afd538d77f",
  );
  assert.equal(provenance.sourceArchive, "https://nodejs.org/dist/v24.14.0/node-v24.14.0.tar.xz");
  assert.doesNotMatch(license.toString("utf8"), /GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE/u);
});

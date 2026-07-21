import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildLinuxPackageEvidence, writeLinuxPackageEvidence } from "./ci-linux-package-evidence.mjs";
import {
  validateDockerSmokeText,
  validateRepositoryCi,
  validateWorkflowText,
} from "./ci-workflow-contracts.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function actualSourceWorkflow() {
  return readFileSync(path.join(rootDirectory, ".github/workflows/source-ci.yml"), "utf8");
}

function actualBrowserWorkflow() {
  return readFileSync(path.join(rootDirectory, ".github/workflows/browser-release-gates.yml"), "utf8");
}

function actualDockerWorkflow() {
  return readFileSync(path.join(rootDirectory, ".github/workflows/docker-schema11-smoke.yml"), "utf8");
}

function actualMacosWorkflow() {
  return readFileSync(path.join(rootDirectory, ".github/workflows/macos-native-packaging.yml"), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("repository workflows satisfy retained enterprise CI contracts", () => {
  const result = validateRepositoryCi(rootDirectory);
  assert.equal(result.workflows, 5);
});

test("mutable actions, missing deadlines, secret consumption, and optimistic artifact names fail closed", () => {
  const workflow = actualSourceWorkflow();
  assert.throws(
    () => validateWorkflowText("fixture.yml", workflow.replace(/actions\/checkout@[a-f0-9]{40}/u, "actions/checkout@v4")),
    /mutable or malformed action reference/u,
  );
  assert.throws(
    () => validateWorkflowText("fixture.yml", workflow.replace("    timeout-minutes: 35\n", "")),
    /has no positive timeout-minutes/u,
  );
  assert.throws(
    () => validateWorkflowText("fixture.yml", `${workflow}\n# \${{ secrets.RELEASE_TOKEN }}\n`),
    /must not consume repository secrets/u,
  );
  assert.throws(
    () => validateWorkflowText("fixture.yml", workflow.replace("  contents: read\n", "  contents: read\n  id-token: write\n")),
    /exactly one top-level contents: read permission block/u,
  );
  assert.throws(
    () => validateWorkflowText("fixture.yml", workflow.replace("  pull_request:\n", "  pull_request_target:\n")),
    /must not use pull_request_target/u,
  );
  assert.throws(
    () => validateWorkflowText("fixture.yml", workflow.replace("name: NO-GO-source-sbom-license-", "name: release-source-sbom-license-")),
    /without a NO-GO name/u,
  );
});

test("the source dependency advisory gate cannot silently drop", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "formaspec-ci-audit-contract-test-"));
  try {
    for (const relativePath of [
      ".node-version",
      "Dockerfile",
      "package.json",
      "apps/server/package.json",
      ".github/workflows/source-ci.yml",
      ".github/workflows/browser-release-gates.yml",
      ".github/workflows/docker-schema11-smoke.yml",
      ".github/workflows/linux-native-packaging.yml",
      ".github/workflows/macos-native-packaging.yml",
      "scripts/ci-docker-schema11-smoke.mjs",
    ]) {
      const destination = path.join(root, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      const source = readFileSync(path.join(rootDirectory, relativePath), "utf8");
      writeFileSync(
        destination,
        relativePath === ".github/workflows/source-ci.yml"
          ? source.replace(
            "          pnpm audit --audit-level high --json | tee artifacts/ci/dependency-audit.json\n",
            "          true\n",
          )
          : source,
      );
    }
    assert.throws(() => validateRepositoryCi(root), /source workflow is missing pnpm audit --audit-level high/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enterprise editor and cross-browser alignment gates cannot silently drop from browser release CI", () => {
  const browserWorkflow = actualBrowserWorkflow();
  assert.match(browserWorkflow, /command: test:e2e:editor/u);
  assert.match(browserWorkflow, /command: test:e2e:alignment:cross-browser/u);
  assert.match(browserWorkflow, /playwright install --with-deps firefox webkit/u);

  const root = mkdtempSync(path.join(os.tmpdir(), "formaspec-ci-workflow-contract-test-"));
  try {
    for (const relativePath of [
      ".node-version",
      "Dockerfile",
      "package.json",
      "apps/server/package.json",
      ".github/workflows/source-ci.yml",
      ".github/workflows/browser-release-gates.yml",
      ".github/workflows/docker-schema11-smoke.yml",
      ".github/workflows/linux-native-packaging.yml",
      ".github/workflows/macos-native-packaging.yml",
      "scripts/ci-docker-schema11-smoke.mjs",
    ]) {
      const destination = path.join(root, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      const source = readFileSync(path.join(rootDirectory, relativePath), "utf8");
      writeFileSync(
        destination,
        relativePath === ".github/workflows/browser-release-gates.yml"
          ? source.replace(/          - gate: editor\n            label: Enterprise editor and prototype\n            command: test:e2e:editor\n/u, "")
          : source,
      );
    }
    assert.throws(() => validateRepositoryCi(root), /browser workflow is missing test:e2e:editor/u);

    const browserPath = path.join(root, ".github/workflows/browser-release-gates.yml");
    writeFileSync(
      browserPath,
      readFileSync(path.join(rootDirectory, ".github/workflows/browser-release-gates.yml"), "utf8")
        .replace(/          - gate: alignment-cross-browser\n            label: Selection alignment Firefox and WebKit\n            command: test:e2e:alignment:cross-browser\n/u, ""),
    );
    assert.throws(
      () => validateRepositoryCi(root),
      /browser workflow is missing test:e2e:alignment:cross-browser/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exact Docker image must retain browser and copied-bundle recovery evidence", () => {
  const dockerWorkflow = actualDockerWorkflow();
  assert.match(dockerWorkflow, /node scripts\/ci-docker-schema11-smoke\.mjs/u);
  assert.match(dockerWorkflow, /node scripts\/ci-cross-browser-docker-smoke\.mjs/u);
  assert.match(dockerWorkflow, /node scripts\/ci-offhost-restore-smoke\.mjs/u);
  assert.match(dockerWorkflow, /FORMASPEC_CI_IMAGE: formaspec\/server:local/u);
  assert.match(dockerWorkflow, /path: artifacts\/ci\/cross-browser-docker\//u);
  assert.match(dockerWorkflow, /path: artifacts\/ci\/offhost-restore-simulation\//u);

  const root = mkdtempSync(path.join(os.tmpdir(), "formaspec-ci-docker-browser-contract-test-"));
  try {
    for (const relativePath of [
      ".node-version",
      "Dockerfile",
      "package.json",
      "apps/server/package.json",
      ".github/workflows/source-ci.yml",
      ".github/workflows/browser-release-gates.yml",
      ".github/workflows/docker-schema11-smoke.yml",
      ".github/workflows/linux-native-packaging.yml",
      ".github/workflows/macos-native-packaging.yml",
      "scripts/ci-docker-schema11-smoke.mjs",
    ]) {
      const destination = path.join(root, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      const source = readFileSync(path.join(rootDirectory, relativePath), "utf8");
      writeFileSync(
        destination,
        relativePath === ".github/workflows/docker-schema11-smoke.yml"
          ? source.replace(
            /      - name: Exercise Firefox and WebKit in the exact built image\n(?:        .+\n)+?        run: node scripts\/ci-cross-browser-docker-smoke\.mjs\n/u,
            "",
          )
          : source,
      );
    }
    assert.throws(
      () => validateRepositoryCi(root),
      /Docker workflow is missing node scripts\/ci-cross-browser-docker-smoke\.mjs/u,
    );

    writeFileSync(
      path.join(root, ".github/workflows/docker-schema11-smoke.yml"),
      readFileSync(path.join(rootDirectory, ".github/workflows/docker-schema11-smoke.yml"), "utf8")
        .replace(
          /      - name: Restore a copied verified bundle into an independent clean project\n(?:        .+\n)+?        run: node scripts\/ci-offhost-restore-smoke\.mjs\n/u,
          "",
        ),
    );
    assert.throws(
      () => validateRepositoryCi(root),
      /Docker workflow is missing node scripts\/ci-offhost-restore-smoke\.mjs/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Docker runtime smoke cannot silently drop its renderer egress canary", () => {
  const smoke = readFileSync(path.join(rootDirectory, "scripts/ci-docker-schema11-smoke.mjs"), "utf8");
  validateDockerSmokeText(smoke);
  assert.throws(
    () => validateDockerSmokeText(smoke.replace(
      "    const rendererEgress = rendererEgressEvidence(containerIds.renderer);\n",
      "",
    )),
    /Docker smoke is missing const rendererEgress/u,
  );
  assert.throws(
    () => validateDockerSmokeText(smoke.replace(
      "host: \"1.1.1.1\", port: 443",
      "host: \"127.0.0.1\", port: 443",
    )),
    /Docker smoke is missing host: "1\.1\.1\.1", port: 443/u,
  );
});

test("macOS native evidence remains main/manual-only, non-installing, and explicitly NO-GO", () => {
  const workflow = actualMacosWorkflow();
  assert.match(workflow, /runs-on: macos-14/u);
  assert.doesNotMatch(workflow, /^\s*pull_request:/mu);
  assert.match(workflow, /node scripts\/ci-macos-pkg-runtime-smoke\.mjs/u);
  assert.match(workflow, /name: NO-GO-unsigned-macos-foundation-/u);
  assert.doesNotMatch(workflow, /\/usr\/sbin\/installer\b|\blaunchctl\b|\bsecurity\b|\bosascript\b|\bcodex\b/iu);

  const root = mkdtempSync(path.join(os.tmpdir(), "formaspec-ci-macos-contract-test-"));
  try {
    for (const relativePath of [
      ".node-version",
      "Dockerfile",
      "package.json",
      "apps/server/package.json",
      ".github/workflows/source-ci.yml",
      ".github/workflows/browser-release-gates.yml",
      ".github/workflows/docker-schema11-smoke.yml",
      ".github/workflows/linux-native-packaging.yml",
      ".github/workflows/macos-native-packaging.yml",
      "scripts/ci-docker-schema11-smoke.mjs",
    ]) {
      const destination = path.join(root, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      const source = readFileSync(path.join(rootDirectory, relativePath), "utf8");
      writeFileSync(
        destination,
        relativePath === ".github/workflows/macos-native-packaging.yml"
          ? source.replace(
            "          node scripts/ci-macos-pkg-runtime-smoke.mjs",
            "          /usr/sbin/installer -pkg \"$FORMASPEC_PKG\" -target /\n          node scripts/ci-macos-pkg-runtime-smoke.mjs",
          )
          : source,
      );
    }
    assert.throws(
      () => validateRepositoryCi(root),
      /must not install packages or invoke user-agent\/credential tooling/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux evidence binds unsigned packages to exact passing source evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "formaspec-ci-evidence-test-"));
  try {
    const artifacts = path.join(root, "packages");
    const source = path.join(root, "source");
    mkdirSync(artifacts);
    mkdirSync(source);
    for (const filename of [
      "FormaSpec-0.2.0-linux-amd64-unsigned.deb",
      "FormaSpec-0.2.0-linux-x86_64-unsigned.rpm",
    ]) {
      const contents = Buffer.from(`fixture:${filename}`);
      writeFileSync(path.join(artifacts, filename), contents);
      writeFileSync(path.join(artifacts, `${filename}.sha256`), `${sha256(contents)}  ${filename}\n`);
    }
    const sbom = Buffer.from("{\"bomFormat\":\"CycloneDX\",\"specVersion\":\"1.6\",\"version\":1,\"components\":[]}\n");
    const licenses = Buffer.from(`${JSON.stringify({
      format: "formaspec-license-evidence",
      schemaVersion: 1,
      target: "test-linux",
      policy: { status: "pass" },
      summary: { deniedComponentCount: 0, installedThirdPartyComponentCount: 2 },
    })}\n`);
    writeFileSync(path.join(source, "formaspec.cdx.json"), sbom);
    writeFileSync(path.join(source, "licenses.json"), licenses);
    writeFileSync(
      path.join(source, "SHA256SUMS"),
      `${sha256(sbom)}  formaspec.cdx.json\n${sha256(licenses)}  licenses.json\n`,
    );

    const evidence = buildLinuxPackageEvidence({ artifactsDirectory: artifacts, sourceEvidenceDirectory: source });
    assert.equal(evidence.releaseStatus, "NO-GO");
    assert.equal(evidence.packages.length, 2);
    assert.ok(evidence.packages.every((entry) => entry.signed === false));
    const output = path.join(root, "evidence");
    writeLinuxPackageEvidence(output, evidence);
    assert.match(readFileSync(path.join(output, "NO-GO-MANIFEST.json"), "utf8"), /"releaseStatus": "NO-GO"/u);

    writeFileSync(path.join(artifacts, `${evidence.packages[0].filename}.sha256`), `${"0".repeat(64)}  ${evidence.packages[0].filename}\n`);
    assert.throws(
      () => buildLinuxPackageEvidence({ artifactsDirectory: artifacts, sourceEvidenceDirectory: source }),
      /Checksum mismatch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

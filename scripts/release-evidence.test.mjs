import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReleaseEvidence,
  classifyPnpmDependencyScopes,
  deterministicJson,
  evaluateLicense,
  mergePnpmLicenseReports,
  parsePnpmLockPackages,
  renderReleaseEvidence,
  validateLicensePolicy,
  verifyReleaseEvidence,
  writeReleaseEvidence,
} from "./release-evidence-lib.mjs";

const permissivePolicy = Object.freeze({
  schemaVersion: 1,
  mode: "permissive-only",
  allowedLicenseIds: ["Apache-2.0", "MIT", "OFL-1.1", "WTFPL"],
  allowedExpressions: ["(MIT OR WTFPL)"],
  forbiddenLicensePrefixes: ["AGPL-", "GPL-", "LGPL-"],
});

const sha512Integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function reports(entries) {
  const result = {};
  for (const entry of entries) {
    result[entry.license] ??= [];
    result[entry.license].push({
      name: entry.name,
      versions: [entry.version],
      paths: entry.paths ?? [`/irrelevant/${entry.name}/${entry.version}`],
    });
  }
  return result;
}

function fixtureInput(rootDirectory = "/tmp/formaspec-evidence-fixture") {
  const rootManifest = {
    directory: rootDirectory,
    relativePath: "package.json",
    name: "formaspec",
    version: "0.2.0",
    private: true,
    sha256: "1".repeat(64),
    manifest: { name: "formaspec", version: "0.2.0", private: true, packageManager: "pnpm@11.9.0" },
  };
  const appManifest = {
    directory: path.join(rootDirectory, "apps", "web"),
    relativePath: "apps/web/package.json",
    name: "@formaspec/web",
    version: "0.1.0",
    private: true,
    sha256: "2".repeat(64),
    manifest: { name: "@formaspec/web", version: "0.1.0", private: true },
  };
  const packages = [
    {
      name: "alpha",
      version: "1.0.0",
      license: "MIT",
      scopes: ["production"],
      packageManifestSha256: "3".repeat(64),
      licenseEvidence: [{ file: "LICENSE", sha256: "4".repeat(64) }],
    },
    {
      name: "dev-helper",
      version: "2.0.0",
      license: "Apache-2.0",
      scopes: ["development"],
      packageManifestSha256: "5".repeat(64),
      licenseEvidence: [],
    },
  ];
  const lockPackages = new Map(
    packages.map((entry) => [
      `${entry.name}\u0000${entry.version}`,
      { name: entry.name, version: entry.version, integrity: sha512Integrity },
    ]),
  );
  return {
    target: "test-target",
    packageManager: "pnpm@11.9.0",
    lockfileSha256: "6".repeat(64),
    policy: permissivePolicy,
    policySha256: "7".repeat(64),
    policyRelativePath: "release/license-policy.json",
    lockPackages,
    workspaces: [rootManifest, appManifest],
    packages,
    dependencyList: [
      {
        name: "formaspec",
        version: "0.2.0",
        path: rootDirectory,
        dependencies: {
          "@formaspec/web": {
            version: "0.1.0",
            path: path.join(rootDirectory, "apps", "web"),
            dependencies: {
              alpha: { version: "1.0.0", dependencies: {} },
            },
          },
        },
        devDependencies: {
          "dev-helper": { version: "2.0.0", dependencies: {} },
        },
      },
    ],
  };
}

test("parses scoped and unscoped pnpm lock packages with exact integrity", () => {
  const lock = `lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/pkg@1.2.3':\n    resolution: {integrity: ${sha512Integrity}}\n\n  plain@2.0.0:\n    resolution: {integrity: ${sha512Integrity}}\n\nsnapshots:\n`;
  const parsed = parsePnpmLockPackages(lock);
  assert.deepEqual(parsed.get("@scope/pkg\u00001.2.3"), {
    name: "@scope/pkg",
    version: "1.2.3",
    integrity: sha512Integrity,
  });
  assert.equal(parsed.get("plain\u00002.0.0")?.integrity, sha512Integrity);
});

test("merges pnpm license scopes without absolute paths entering normalized identity", () => {
  const all = reports([
    { name: "alpha", version: "1.0.0", license: "MIT", paths: ["/build/a/alpha"] },
    { name: "tool", version: "2.0.0", license: "Apache-2.0", paths: ["/build/a/tool"] },
  ]);
  const merged = mergePnpmLicenseReports(
    all,
    reports([{ name: "alpha", version: "1.0.0", license: "MIT" }]),
    reports([{ name: "tool", version: "2.0.0", license: "Apache-2.0" }]),
  );
  assert.deepEqual(
    merged.map(({ name, version, license, scopes }) => ({ name, version, license, scopes })),
    [
      { name: "alpha", version: "1.0.0", license: "MIT", scopes: ["production"] },
      { name: "tool", version: "2.0.0", license: "Apache-2.0", scopes: ["development"] },
    ],
  );
});

test("infers the scope of installed platform packages omitted by pnpm license filters", () => {
  const key = "@native/tool\u00001.0.0";
  const scopes = classifyPnpmDependencyScopes(
    [
      {
        name: "formaspec",
        version: "0.2.0",
        devDependencies: {
          builder: {
            version: "2.0.0",
            optionalDependencies: {
              "@native/tool": { version: "1.0.0" },
            },
          },
        },
      },
    ],
    new Set([key]),
  );
  assert.deepEqual([...scopes.get(key)], ["development"]);
  const merged = mergePnpmLicenseReports(
    reports([{ name: "@native/tool", version: "1.0.0", license: "MIT" }]),
    {},
    {},
    scopes,
  );
  assert.deepEqual(merged[0].scopes, ["development"]);
});

test("enforces the permissive-only policy and rejects copyleft identifiers", () => {
  assert.deepEqual(evaluateLicense("MIT", permissivePolicy), { allowed: true, reason: "allowlisted" });
  assert.deepEqual(evaluateLicense("(MIT OR WTFPL)", permissivePolicy), {
    allowed: true,
    reason: "allowlisted",
  });
  assert.deepEqual(evaluateLicense("LGPL-3.0-or-later", permissivePolicy), {
    allowed: false,
    reason: "forbidden-license",
    identifier: "LGPL-3.0-or-later",
  });
  assert.deepEqual(evaluateLicense("MPL-2.0", permissivePolicy), {
    allowed: false,
    reason: "not-allowlisted",
  });
});

test("requires reviewed policy arrays to be sorted and duplicate-free", () => {
  assert.throws(
    () => validateLicensePolicy({ ...permissivePolicy, allowedLicenseIds: ["MIT", "Apache-2.0"] }),
    /must be sorted/u,
  );
});

test("builds byte-identical path-free CycloneDX and license evidence", () => {
  const firstInput = fixtureInput("/tmp/build-one");
  const secondInput = fixtureInput("/different/checkout/build-two");
  secondInput.workspaces.reverse();
  secondInput.packages.reverse();
  secondInput.dependencyList.reverse();
  const first = renderReleaseEvidence(buildReleaseEvidence(firstInput));
  const second = renderReleaseEvidence(buildReleaseEvidence(secondInput));
  for (const [name, contents] of first) {
    assert.equal(contents, second.get(name), `${name} must be deterministic`);
    assert.doesNotMatch(contents, /\/tmp\/build-one|\/different\/checkout/u);
  }
  const bom = JSON.parse(first.get("formaspec.cdx.json"));
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.components.length, 3);
  assert.deepEqual(
    bom.dependencies.find((entry) => entry.ref === "pkg:npm/formaspec@0.2.0").dependsOn,
    ["pkg:npm/%40formaspec/web@0.1.0", "pkg:npm/dev-helper@2.0.0"],
  );
});

test("writes deterministic checksums and detects stale evidence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "formaspec-evidence-"));
  try {
    const files = renderReleaseEvidence(buildReleaseEvidence(fixtureInput(directory)));
    writeReleaseEvidence(directory, files);
    assert.deepEqual(verifyReleaseEvidence(directory, files), []);
    const checksum = readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
    assert.match(checksum, /^[a-f0-9]{64}  formaspec\.cdx\.json\n[a-f0-9]{64}  licenses\.json\n$/u);
    writeFileSync(path.join(directory, "licenses.json"), `${deterministicJson({ stale: true })}`);
    assert.deepEqual(verifyReleaseEvidence(directory, files), [
      "licenses.json does not match current lock/manifests/policy",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the checked-in policy excludes known copyleft license families", () => {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const policy = JSON.parse(readFileSync(path.join(scriptDirectory, "..", "release", "license-policy.json"), "utf8"));
  const validated = validateLicensePolicy(policy);
  for (const forbidden of ["AGPL-3.0-only", "GPL-3.0-only", "LGPL-3.0-or-later", "SSPL-1.0"]) {
    assert.equal(evaluateLicense(forbidden, validated).allowed, false);
  }
});

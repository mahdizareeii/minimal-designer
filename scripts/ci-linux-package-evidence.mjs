#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
const PACKAGE_PATTERN = /^FormaSpec-([0-9A-Za-z.+~-]+)-linux-(amd64|arm64|x86_64|aarch64)-unsigned\.(deb|rpm)$/u;
const REQUIRED_SOURCE_FILES = Object.freeze(["formaspec.cdx.json", "licenses.json", "SHA256SUMS"]);

function usage() {
  return `Usage: node scripts/ci-linux-package-evidence.mjs \\
  --artifacts <directory> \\
  --source-evidence <directory> \\
  --output <directory>

Validates one unsigned DEB and one unsigned RPM plus their adjacent checksums,
links them to deterministic source SBOM/license evidence, and writes a bounded
NO-GO manifest. It does not install, sign, or approve either package.
`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(filename, maximumBytes, label) {
  const metadata = lstatSync(filename, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  if (metadata.size < 1n || metadata.size > BigInt(maximumBytes)) throw new Error(`${label} has an invalid size.`);
  return readFileSync(filename);
}

function normalizedFile(filename, maximumBytes, label) {
  const bytes = readRegularFile(filename, maximumBytes, label);
  return { filename: path.basename(filename), sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function parseChecksum(text, expectedFilename) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._+~-]+)\n$/u.exec(text);
  if (!match || match[2] !== expectedFilename) throw new Error(`Checksum for ${expectedFilename} is malformed or names another file.`);
  return match[1];
}

function sourceEvidence(directory) {
  const records = REQUIRED_SOURCE_FILES.map((filename) => normalizedFile(
    path.join(directory, filename),
    MAX_EVIDENCE_BYTES,
    `Source evidence ${filename}`,
  ));
  const licensePath = path.join(directory, "licenses.json");
  let licenses;
  let sbom;
  try {
    licenses = JSON.parse(readFileSync(licensePath, "utf8"));
    sbom = JSON.parse(readFileSync(path.join(directory, "formaspec.cdx.json"), "utf8"));
  } catch (error) {
    throw new Error(`Source evidence is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sbom?.bomFormat !== "CycloneDX" || sbom?.specVersion !== "1.6" || sbom?.version !== 1 || !Array.isArray(sbom?.components)) {
    throw new Error("Source SBOM is not deterministic CycloneDX 1.6 evidence.");
  }
  if (licenses?.format !== "formaspec-license-evidence"
    || licenses?.schemaVersion !== 1
    || typeof licenses?.target !== "string"
    || licenses.target.length === 0
    || licenses?.policy?.status !== "pass"
    || licenses?.summary?.deniedComponentCount !== 0
    || !Number.isSafeInteger(licenses?.summary?.installedThirdPartyComponentCount)
    || licenses.summary.installedThirdPartyComponentCount < 0) {
    throw new Error("Source license evidence does not pass the checked-in policy.");
  }
  const checksumLines = readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split(/\r?\n/u);
  const expected = new Map(checksumLines.map((line) => {
    const match = /^([a-f0-9]{64})  (formaspec\.cdx\.json|licenses\.json)$/u.exec(line);
    if (!match) throw new Error("Source evidence SHA256SUMS is malformed.");
    return [match[2], match[1]];
  }));
  if (expected.size !== 2) throw new Error("Source evidence checksum set is incomplete.");
  for (const record of records.filter((record) => record.filename !== "SHA256SUMS")) {
    if (expected.get(record.filename) !== record.sha256) throw new Error(`Source evidence checksum mismatch for ${record.filename}.`);
  }
  return {
    target: licenses.target,
    policyStatus: licenses.policy.status,
    deniedComponentCount: licenses.summary.deniedComponentCount,
    installedThirdPartyComponentCount: licenses.summary.installedThirdPartyComponentCount,
    cyclonedxComponentCount: sbom.components.length,
    files: records,
  };
}

export function buildLinuxPackageEvidence({ artifactsDirectory, sourceEvidenceDirectory }) {
  const packageNames = readdirSync(artifactsDirectory).filter((filename) => filename.endsWith(".deb") || filename.endsWith(".rpm")).sort();
  if (packageNames.length !== 2) throw new Error(`Expected one DEB and one RPM, received ${packageNames.length} package files.`);
  const kinds = new Set();
  const versions = new Set();
  const packages = packageNames.map((filename) => {
    const match = PACKAGE_PATTERN.exec(filename);
    if (!match) throw new Error(`Linux package does not use the mandatory unsigned name: ${filename}`);
    const [, version, architecture, kind] = match;
    if (kinds.has(kind)) throw new Error(`Duplicate ${kind.toUpperCase()} artifact.`);
    kinds.add(kind);
    versions.add(version);
    const artifact = normalizedFile(path.join(artifactsDirectory, filename), MAX_ARTIFACT_BYTES, `Linux ${kind.toUpperCase()} artifact`);
    const checksumFilename = `${filename}.sha256`;
    const checksumText = readRegularFile(
      path.join(artifactsDirectory, checksumFilename),
      1_024,
      `${kind.toUpperCase()} checksum`,
    ).toString("utf8");
    const declaredHash = parseChecksum(checksumText, filename);
    if (declaredHash !== artifact.sha256) throw new Error(`Checksum mismatch for ${filename}.`);
    return {
      kind,
      version,
      architecture,
      filename,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      checksumFilename,
      signed: false,
    };
  });
  if (!kinds.has("deb") || !kinds.has("rpm") || versions.size !== 1) {
    throw new Error("Linux evidence requires one version-matched unsigned DEB and RPM.");
  }
  return {
    format: "formaspec-ci-linux-package-evidence",
    schemaVersion: 1,
    releaseStatus: "NO-GO",
    target: "github-ubuntu-24.04-x64",
    packages,
    sourceEvidence: sourceEvidence(sourceEvidenceDirectory),
    assertions: {
      unsignedFilenames: true,
      adjacentChecksumsMatch: true,
      sourceLicensePolicyPasses: true,
      packagesWereNotInstalledByThisVerifier: true,
    },
    blockers: [
      "Unsigned CI artifacts are engineering evidence only.",
      "No clean install, upgrade, rollback, uninstall, reinstall, systemd, protocol, renderer-egress, or data-preservation lifecycle ran.",
      "Artifact-specific vulnerability scanning, legal approval, independent reproducibility, provenance, and signing remain absent.",
    ],
  };
}

export function writeLinuxPackageEvidence(outputDirectory, evidence) {
  if (existsSync(outputDirectory)) throw new Error("Linux package evidence output already exists.");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const manifest = `${JSON.stringify(evidence, null, 2)}\n`;
  const manifestFilename = "NO-GO-MANIFEST.json";
  writeFileSync(path.join(outputDirectory, manifestFilename), manifest, { mode: 0o644 });
  writeFileSync(path.join(outputDirectory, "SHA256SUMS"), `${sha256(manifest)}  ${manifestFilename}\n`, { mode: 0o644 });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} is required.\n\n${usage()}`);
  }
  return path.resolve(process.argv[index + 1]);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const artifactsDirectory = argument("--artifacts");
  const sourceEvidenceDirectory = argument("--source-evidence");
  const outputDirectory = argument("--output");
  const evidence = buildLinuxPackageEvidence({ artifactsDirectory, sourceEvidenceDirectory });
  writeLinuxPackageEvidence(outputDirectory, evidence);
  process.stdout.write(`Unsigned Linux package evidence: NO-GO; ${outputDirectory}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

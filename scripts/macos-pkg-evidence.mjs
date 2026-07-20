#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMacPackageEvidence,
  renderMacPackageEvidence,
  verifyMacPackageEvidence,
  writeMacPackageEvidence,
} from "./macos-pkg-evidence-lib.mjs";

function usage() {
  return `Usage:
  node scripts/macos-pkg-evidence.mjs generate [options]
  node scripts/macos-pkg-evidence.mjs verify [options]
  node scripts/macos-pkg-evidence.mjs gate [options]

Options:
  --pkg <path>              Unsigned FormaSpec macOS PKG
  --source-evidence <dir>   Source SBOM/license evidence directory
  --output <dir>            Artifact evidence output directory
  --policy <path>           Checked-in permissive-only license policy

Generation and verification are offline. They use local macOS package tools,
the artifact bytes, the source evidence, the current workspace build outputs,
and checked-in policy only.
`;
}

function parseArguments(argv) {
  const command = argv[0];
  if (!["generate", "verify", "gate"].includes(command)) throw new Error(usage());
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--pkg", "--source-evidence", "--output", "--policy"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  return { command, options };
}

function outputSummary(evidence, outputDirectory) {
  const summary = evidence.componentInventory.summary;
  process.stdout.write(
    `macOS PKG evidence: integrity ${evidence.verification.integrityStatus.toUpperCase()}, ` +
      `release ${evidence.verification.releaseDecision.toUpperCase()}; ` +
      `${summary.packagedNpmComponentCount} npm/workspace components, ` +
      `${summary.workspaceTreeCount} exact workspace trees, ` +
      `${summary.runtimeComponentCount} runtime components, ` +
      `${evidence.verification.blockers.length} blocker(s).\n` +
      `Evidence directory: ${outputDirectory}\n`,
  );
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, "..");
  const rootPackage = JSON.parse(fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
  const version = typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0";
  const defaultFilename = `FormaSpec-${version}-macos-${process.arch}-unsigned.pkg`;
  const packagePath = path.resolve(rootDirectory, parsed.options.pkg ?? path.join("artifacts", "installers", defaultFilename));
  const sourceEvidenceDirectory = path.resolve(
    rootDirectory,
    parsed.options["source-evidence"] ?? path.join("artifacts", "release-evidence"),
  );
  const outputDirectory = path.resolve(
    rootDirectory,
    parsed.options.output ?? path.join("artifacts", "release-evidence", "macos-pkg", path.basename(packagePath, ".pkg")),
  );
  const policyPath = path.resolve(rootDirectory, parsed.options.policy ?? path.join("release", "license-policy.json"));
  const evidence = collectMacPackageEvidence({
    packagePath,
    sourceEvidenceDirectory,
    policyPath,
    workspaceRoot: rootDirectory,
  });
  const files = renderMacPackageEvidence(evidence);

  if (parsed.command === "generate") {
    writeMacPackageEvidence(outputDirectory, files);
    outputSummary(evidence, outputDirectory);
    process.stdout.write("Evidence was generated; release blockers remain recorded in verification.json.\n");
    return;
  }

  const differences = verifyMacPackageEvidence(outputDirectory, files);
  if (differences.length > 0) {
    throw new Error(
      `macOS PKG evidence is stale or incomplete:\n${differences.map((difference) => `- ${difference}`).join("\n")}\n` +
        "Run pnpm release:evidence:macos:generate and review the result.",
    );
  }
  outputSummary(evidence, outputDirectory);
  if (parsed.command === "gate" && evidence.verification.blockers.length > 0) {
    throw new Error(
      `macOS PKG release gate remains closed:\n${evidence.verification.blockers
        .map((blocker) => `- ${blocker.code}${blocker.component ? ` (${blocker.component})` : ""}: ${blocker.detail}`)
        .join("\n")}`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

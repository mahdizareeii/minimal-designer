#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectRepositoryReleaseEvidence,
  renderReleaseEvidence,
  verifyReleaseEvidence,
  writeReleaseEvidence,
} from "./release-evidence-lib.mjs";

function usage() {
  return `Usage:
  node scripts/release-evidence.mjs generate [--output <directory>] [--target <name>]
  node scripts/release-evidence.mjs check [--output <directory>] [--target <name>]

The command reads only the installed pnpm dependency graph, pnpm-lock.yaml,
workspace package manifests, package license/notice files, and the checked-in
permissive-only policy. It never contacts a registry or external service.
`;
}

function parseArguments(argv) {
  const command = argv[0];
  if (!command || !["generate", "check"].includes(command)) {
    throw new Error(usage());
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--output" || argument === "--target" || argument === "--policy") {
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

function printSummary(evidence, outputDir) {
  const summary = evidence.licenseReport.summary;
  const status = evidence.licenseReport.policy.status.toUpperCase();
  process.stdout.write(
    `Release evidence: ${status}; ${summary.installedThirdPartyComponentCount} installed third-party components, ` +
      `${summary.deniedComponentCount} policy violation(s).\nEvidence directory: ${outputDir}\n`,
  );
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDirectory, "..");
  const outputDir = path.resolve(rootDir, parsed.options.output ?? "artifacts/release-evidence");
  const policyPath = path.resolve(rootDir, parsed.options.policy ?? "release/license-policy.json");
  const evidence = collectRepositoryReleaseEvidence({
    rootDir,
    policyPath,
    ...(parsed.options.target ? { target: parsed.options.target } : {}),
  });
  const files = renderReleaseEvidence(evidence);

  if (parsed.command === "generate") {
    writeReleaseEvidence(outputDir, files);
    printSummary(evidence, outputDir);
    if (evidence.licenseReport.policy.status !== "pass") {
      process.stdout.write("Evidence was generated, but the permissive-license release gate remains closed.\n");
    }
    return;
  }

  const differences = verifyReleaseEvidence(outputDir, files);
  if (differences.length > 0) {
    throw new Error(
      `Generated release evidence is stale or incomplete:\n${differences.map((difference) => `- ${difference}`).join("\n")}\n` +
        "Run pnpm release:evidence:generate and review the result.",
    );
  }
  printSummary(evidence, outputDir);
  if (evidence.licenseReport.violations.length > 0) {
    const details = evidence.licenseReport.violations
      .map(
        (violation) =>
          `- ${violation.name}@${violation.version}: ${violation.license} (${violation.reason}; ${violation.scopes.join(",")})`,
      )
      .join("\n");
    throw new Error(`Permissive-license policy failed:\n${details}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

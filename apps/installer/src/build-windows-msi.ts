#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWindowsPackagingHost,
  buildUnsignedWindowsMsi,
  normalizeWindowsSourceDateEpoch,
  stageWindowsPayload,
  type WindowsMsiBuildOptions,
  type WindowsServiceHostInput,
} from "./windows-packaging.js";

export interface WindowsApplicationMsiBuildOptions extends Omit<WindowsMsiBuildOptions, "payloadRoot"> {
  applicationPayloadRoot: string;
  serviceHost: WindowsServiceHostInput;
}

export function buildUnsignedWindowsMsiFromApplication(options: WindowsApplicationMsiBuildOptions): string {
  const platform = options.platform ?? process.platform;
  assertWindowsPackagingHost(platform);
  const sourceDateEpoch = normalizeWindowsSourceDateEpoch(options.sourceDateEpoch);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-windows-msi-"));
  const payloadRoot = path.join(staging, "payload");
  try {
    stageWindowsPayload({
      applicationPayloadRoot: options.applicationPayloadRoot,
      payloadRoot,
      serviceHost: options.serviceHost,
      version: options.version,
      architecture: options.architecture,
      sourceDateEpoch,
    });
    return buildUnsignedWindowsMsi({
      payloadRoot,
      outputDirectory: options.outputDirectory,
      version: options.version,
      architecture: options.architecture,
      sourceDateEpoch,
      wixExecutable: options.wixExecutable,
      wixProvenance: options.wixProvenance,
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      platform,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required Windows MSI build argument: ${name}`);
  return value;
}

function usage(): string {
  return `Usage: build-windows-msi \\
  --application-payload <absolute-directory> \\
  --output <absolute-directory> \\
  --version <major.minor.build> \\
  --architecture <x64|arm64> \\
  --service-host <absolute-exe> \\
  --service-host-provenance <absolute-json> \\
  --service-host-license <absolute-license> \\
  --wix <absolute-wix.exe> \\
  --wix-provenance <absolute-json> \\
  [--source-date-epoch <unix-seconds>]

The command runs only on native Windows and emits an unsigned MSI plus SHA-256 file.
It never discovers, downloads, signs, or substitutes a service host or WiX executable.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
  } else {
    const sourceDateEpoch = argument("--source-date-epoch") ?? process.env.SOURCE_DATE_EPOCH;
    const output = buildUnsignedWindowsMsiFromApplication({
      applicationPayloadRoot: path.resolve(requiredArgument("--application-payload")),
      outputDirectory: path.resolve(requiredArgument("--output")),
      version: requiredArgument("--version"),
      architecture: requiredArgument("--architecture"),
      ...(sourceDateEpoch === undefined ? {} : { sourceDateEpoch }),
      serviceHost: {
        executable: path.resolve(requiredArgument("--service-host")),
        provenance: path.resolve(requiredArgument("--service-host-provenance")),
        license: path.resolve(requiredArgument("--service-host-license")),
      },
      wixExecutable: path.resolve(requiredArgument("--wix")),
      wixProvenance: path.resolve(requiredArgument("--wix-provenance")),
    });
    process.stdout.write(`${output}\n`);
  }
}

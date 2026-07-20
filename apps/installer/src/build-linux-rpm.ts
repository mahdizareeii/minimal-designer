#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLinuxPackageVersion,
  linuxPackageArchitecture,
  linuxRpmPostInstallScript,
  linuxRpmPostRemoveScript,
  linuxRpmPreInstallScript,
  linuxRpmPreRemoveScript,
  rpmVersion,
} from "./linux-layout.js";
import {
  assertExecutableFile,
  assertLinuxPackagingHost,
  normalizeSourceDateEpoch,
  stageLinuxPayload,
  writeArtifactChecksum,
} from "./linux-packaging.js";
import {
  runPackageCommand,
  spawnPackageCommandRunner,
  type PackageCommandRunner,
} from "./package-command.js";

export interface RpmPayloadBuildOptions {
  payloadRoot: string;
  outputDirectory: string;
  version: string;
  architecture: string;
  sourceDateEpoch: number;
  rpmbuildExecutable: string;
  commandRunner?: PackageCommandRunner;
  platform?: NodeJS.Platform;
}

export interface LinuxRpmBuildOptions {
  workspaceRoot: string;
  outputDirectory: string;
  nodeExecutable: string;
  playwrightBrowsersDirectory: string;
  version: string;
  architecture?: string;
  sourceDateEpoch?: number;
  rpmbuildExecutable?: string;
  commandRunner?: PackageCommandRunner;
}

function assertSafeRpmMacroPath(value: string): string {
  const resolved = path.resolve(value);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(resolved) || resolved.includes("..")) {
    throw new Error("RPM staging paths must be absolute and contain only safe path characters.");
  }
  return resolved;
}

export function rpmSpec(version: string, architecture: string): string {
  const productVersion = assertLinuxPackageVersion(version);
  const mappedVersion = rpmVersion(productVersion);
  const rpmArchitecture = linuxPackageArchitecture(architecture, "rpm");
  return `%global debug_package %{nil}
%global _build_id_links none
Name: formaspec
Version: ${mappedVersion.version}
Release: ${mappedVersion.release}
Summary: AI-first structured UI design workspace
License: LicenseRef-FormaSpec-Internal AND LicenseRef-Third-Party-Notices
BuildArch: ${rpmArchitecture}
AutoReqProv: no
Requires: systemd
Requires: xdg-utils
Requires: desktop-file-utils
Requires: ca-certificates
Requires: shadow-utils

%description
FormaSpec is a self-hosted browser editor and MCP design service. This native
package contains its pinned Node.js and Chromium headless-shell runtimes and
binds the application API to host loopback.

%prep

%build

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}
cp -a %{formaspec_payload}/. %{buildroot}/

%pre
${linuxRpmPreInstallScript()}

%post
${linuxRpmPostInstallScript()}

%preun
${linuxRpmPreRemoveScript()}

%postun
${linuxRpmPostRemoveScript()}

%files
%defattr(-,root,root,-)
/opt/formaspec
/usr/bin/designer
/usr/bin/formaspec-open
/usr/bin/formaspecctl
/usr/lib/systemd/system/formaspec-api.service
/usr/lib/systemd/system/formaspec-renderer.service
%dir /etc/formaspec
%config(noreplace) /etc/formaspec/formaspec.env
/usr/share/applications/formaspec.desktop
/usr/share/metainfo/com.formaspec.FormaSpec.metainfo.xml
/usr/share/doc/formaspec
`;
}

function assertBuiltArtifact(filename: string): void {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`rpmbuild did not create a regular non-empty artifact: ${filename}`);
  }
}

export function buildRpmFromPayload(options: RpmPayloadBuildOptions): string {
  assertLinuxPackagingHost(options.platform ?? process.platform);
  const version = assertLinuxPackageVersion(options.version);
  const sourceDateEpoch = normalizeSourceDateEpoch(options.sourceDateEpoch);
  assertExecutableFile(options.rpmbuildExecutable);
  const runner = options.commandRunner ?? spawnPackageCommandRunner;
  const rpmArchitecture = linuxPackageArchitecture(options.architecture, "rpm");
  const versionFields = rpmVersion(version);
  const payloadRoot = assertSafeRpmMacroPath(options.payloadRoot);
  const topDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-rpmbuild-"));
  const specsDirectory = path.join(topDirectory, "SPECS");
  const rpmsDirectory = path.join(topDirectory, "RPMS");
  const sourceRpmsDirectory = path.join(topDirectory, "SRPMS");
  const buildDirectory = path.join(topDirectory, "BUILD");
  const buildRootDirectory = path.join(topDirectory, "BUILDROOT");
  const sourcesDirectory = path.join(topDirectory, "SOURCES");
  const specPath = path.join(specsDirectory, "formaspec.spec");
  let publishedOutput: string | undefined;
  try {
    for (const directory of [specsDirectory, rpmsDirectory, sourceRpmsDirectory, buildDirectory, buildRootDirectory, sourcesDirectory]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
      fs.utimesSync(directory, sourceDateEpoch, sourceDateEpoch);
    }
    fs.writeFileSync(specPath, rpmSpec(version, options.architecture), { mode: 0o644 });
    fs.utimesSync(specPath, sourceDateEpoch, sourceDateEpoch);
    runPackageCommand(
      runner,
      path.resolve(options.rpmbuildExecutable),
      [
        "-bb",
        specPath,
        "--define", `_topdir ${topDirectory}`,
        "--define", `_rpmdir ${rpmsDirectory}`,
        "--define", `_srcrpmdir ${sourceRpmsDirectory}`,
        "--define", `_builddir ${buildDirectory}`,
        "--define", `_buildrootdir ${buildRootDirectory}`,
        "--define", `_sourcedir ${sourcesDirectory}`,
        "--define", `_specdir ${specsDirectory}`,
        "--define", `_buildhost formaspec.invalid`,
        "--define", `formaspec_payload ${payloadRoot}`,
        "--define", `_source_date_epoch ${sourceDateEpoch}`,
        "--define", "use_source_date_epoch_as_buildtime 1",
        "--define", "clamp_mtime_to_source_date_epoch 1",
      ],
      {
        env: {
          HOME: topDirectory,
          LC_ALL: "C",
          LANG: "C",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          RPM_BUILD_NCPUS: "1",
          SOURCE_DATE_EPOCH: String(sourceDateEpoch),
          TMPDIR: os.tmpdir(),
          TZ: "UTC",
        },
      },
    );
    const built = path.join(
      rpmsDirectory,
      rpmArchitecture,
      `formaspec-${versionFields.version}-${versionFields.release}.${rpmArchitecture}.rpm`,
    );
    assertBuiltArtifact(built);
    fs.mkdirSync(options.outputDirectory, { recursive: true, mode: 0o755 });
    const output = path.resolve(
      options.outputDirectory,
      `FormaSpec-${version}-linux-${rpmArchitecture}-unsigned.rpm`,
    );
    publishedOutput = output;
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.sha256`, { force: true });
    fs.copyFileSync(built, output);
    fs.chmodSync(output, 0o644);
    assertBuiltArtifact(output);
    writeArtifactChecksum(output);
    return output;
  } catch (error) {
    if (publishedOutput !== undefined) {
      fs.rmSync(publishedOutput, { force: true });
      fs.rmSync(`${publishedOutput}.sha256`, { force: true });
    }
    throw error;
  } finally {
    fs.rmSync(topDirectory, { recursive: true, force: true });
  }
}

export function buildUnsignedLinuxRpm(options: LinuxRpmBuildOptions): string {
  assertLinuxPackagingHost();
  const architecture = options.architecture ?? process.arch;
  linuxPackageArchitecture(architecture, "rpm");
  const sourceDateEpoch = normalizeSourceDateEpoch(options.sourceDateEpoch);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-linux-rpm-"));
  const payloadRoot = path.join(staging, "payload");
  try {
    stageLinuxPayload({
      workspaceRoot: options.workspaceRoot,
      payloadRoot,
      nodeExecutable: options.nodeExecutable,
      playwrightBrowsersDirectory: options.playwrightBrowsersDirectory,
      version: options.version,
      architecture,
      sourceDateEpoch,
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
    });
    return buildRpmFromPayload({
      payloadRoot,
      outputDirectory: options.outputDirectory,
      version: options.version,
      architecture,
      sourceDateEpoch,
      rpmbuildExecutable: options.rpmbuildExecutable ?? "/usr/bin/rpmbuild",
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      platform: process.platform,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function findWorkspaceRoot(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  if (!fs.existsSync(path.join(root, "pnpm-workspace.yaml"))) throw new Error("FormaSpec workspace root was not found.");
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspaceRoot = findWorkspaceRoot();
  const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as { version?: unknown };
  const version = argument("--version") ?? (typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0");
  const outputDirectory = path.resolve(argument("--output") ?? path.join(workspaceRoot, "artifacts", "installers"));
  const nodeExecutable = path.resolve(argument("--node") ?? process.execPath);
  const browsers = path.resolve(
    argument("--playwright-browsers")
      ?? process.env.PLAYWRIGHT_BROWSERS_PATH
      ?? path.join(os.homedir(), ".cache", "ms-playwright"),
  );
  const sourceDateEpoch = normalizeSourceDateEpoch(argument("--source-date-epoch") ?? process.env.SOURCE_DATE_EPOCH);
  const output = buildUnsignedLinuxRpm({
    workspaceRoot,
    outputDirectory,
    nodeExecutable,
    playwrightBrowsersDirectory: browsers,
    version,
    sourceDateEpoch,
    ...(argument("--rpmbuild") === undefined ? {} : { rpmbuildExecutable: path.resolve(argument("--rpmbuild")!) }),
  });
  process.stdout.write(`${output}\n`);
}

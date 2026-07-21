import path from "node:path";

export interface FormaSpecRuntimePaths {
  projectRoot: string;
  runtimeDirectory: string;
  runDirectory: string;
  environmentDirectory: string;
  dataDirectory: string;
  backupDirectory: string;
  logDirectory: string;
  supportDirectory: string;
  usesExternalStatePaths: boolean;
}

const PATH_OVERRIDES = [
  "FORMASPEC_RUNTIME_DIR",
  "FORMASPEC_DATA_DIR",
  "FORMASPEC_BACKUP_DIR",
  "FORMASPEC_LOG_DIR",
  "FORMASPEC_SUPPORT_DIR",
] as const;

type PathOverride = (typeof PATH_OVERRIDES)[number];

function absoluteOverride(environment: NodeJS.ProcessEnv, name: PathOverride): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${name} must be a non-empty absolute path.`);
  }
  return path.resolve(value);
}

export function resolveRuntimePaths(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): FormaSpecRuntimePaths {
  const root = path.resolve(projectRoot);
  const runtimeOverride = absoluteOverride(environment, "FORMASPEC_RUNTIME_DIR");
  const dataOverride = absoluteOverride(environment, "FORMASPEC_DATA_DIR");
  const backupOverride = absoluteOverride(environment, "FORMASPEC_BACKUP_DIR");
  const logOverride = absoluteOverride(environment, "FORMASPEC_LOG_DIR");
  const supportOverride = absoluteOverride(environment, "FORMASPEC_SUPPORT_DIR");
  const runtimeDirectory = runtimeOverride ?? path.join(root, ".designer");
  return {
    projectRoot: root,
    runtimeDirectory,
    runDirectory: path.join(runtimeDirectory, "run"),
    environmentDirectory: path.join(runtimeDirectory, "env"),
    dataDirectory: dataOverride ?? path.join(root, "data"),
    backupDirectory: backupOverride ?? path.join(runtimeDirectory, "backups"),
    logDirectory: logOverride ?? path.join(runtimeDirectory, "logs"),
    supportDirectory: supportOverride ?? path.join(runtimeDirectory, "support-bundles"),
    usesExternalStatePaths: PATH_OVERRIDES.some((name) => environment[name] !== undefined),
  };
}

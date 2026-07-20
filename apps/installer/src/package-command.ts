import { spawnSync } from "node:child_process";
import path from "node:path";

export interface PackageCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PackageCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface PackageCommandRunner {
  run(executable: string, arguments_: readonly string[], options?: PackageCommandOptions): PackageCommandResult;
}

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;

export const spawnPackageCommandRunner: PackageCommandRunner = {
  run(executable, arguments_, options = {}) {
    const result = spawnSync(executable, [...arguments_], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  },
};

function assertCommandInput(
  executable: string,
  arguments_: readonly string[],
  options: PackageCommandOptions | undefined,
): void {
  if (!path.isAbsolute(executable) || executable.includes("\0") || executable.includes("\n") || executable.includes("\r")) {
    throw new Error("Packaging commands require an absolute executable path without control characters.");
  }
  for (const argument of arguments_) {
    if (/[\u0000-\u001f\u007f]/.test(argument)) {
      throw new Error("Packaging command arguments cannot contain control characters.");
    }
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error("Packaging command timeout must be a whole number from 1 ms through 2 hours.");
  }
}

function boundedFailureDetail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `: ${trimmed.slice(0, 4_096)}`;
}

export function runPackageCommand(
  runner: PackageCommandRunner,
  executable: string,
  arguments_: readonly string[],
  options?: PackageCommandOptions,
): PackageCommandResult {
  assertCommandInput(executable, arguments_, options);
  const result = runner.run(executable, arguments_, options);
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`Packaging command ${path.basename(executable)} exceeded its absolute deadline.`, { cause: result.error });
    }
    throw new Error(`Packaging command ${path.basename(executable)} could not start.`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `Packaging command ${path.basename(executable)} failed with exit code ${result.status ?? "unknown"}${boundedFailureDetail(result.stderr)}`,
    );
  }
  return result;
}

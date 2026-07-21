import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  timeoutMs?: number;
  input?: Readable;
  maxOutputBytes?: number;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (executable, args, options = {}) => new Promise((resolve, reject) => {
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024 * 1024) {
    throw new Error("Command output limit is invalid.");
  }
  const child = spawn(executable, [...args], {
    shell: false,
    cwd: options.cwd,
    env: options.env,
    stdio: options.inherit ? "inherit" : [options.input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputError: Error | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    child.kill("SIGTERM");
    forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  const capture = (target: Buffer[], chunk: Buffer | Uint8Array): void => {
    if (outputError) return;
    const buffer = Buffer.from(chunk);
    outputBytes += buffer.length;
    if (outputBytes > maxOutputBytes) {
      outputError = new Error(`Command output exceeded the fixed ${maxOutputBytes}-byte limit.`);
      terminate();
      return;
    }
    target.push(buffer);
  };
  child.stdout?.on("data", (chunk: Buffer | Uint8Array) => capture(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer | Uint8Array) => capture(stderr, chunk));
  let inputError: Error | undefined;
  if (options.input && child.stdin) {
    options.input.once("error", (error) => {
      inputError = error;
      child.stdin?.destroy(error);
      terminate();
    });
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") inputError ??= error;
    });
    options.input.pipe(child.stdin);
  }
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      terminate();
    }, options.timeoutMs);
  child.once("error", (error) => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    if (inputError || outputError) {
      reject(inputError ?? outputError);
      return;
    }
    resolve({
      exitCode: code ?? (signal === null ? 1 : 128),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
});

function executableCandidates(name: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [name];
  const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

export function findExecutable(name: string, environment: NodeJS.ProcessEnv): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Executable name is invalid.");
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const candidateName of executableCandidates(name, environment)) {
      const candidate = path.join(directory, candidateName);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        // Ignore unreadable and missing PATH entries.
      }
    }
  }
  return null;
}

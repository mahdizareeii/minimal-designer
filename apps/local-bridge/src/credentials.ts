import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface CredentialStore {
  read(): Promise<string | null>;
  write(secret: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  #secret: string | null = null;
  async read(): Promise<string | null> { return this.#secret; }
  async write(secret: string): Promise<void> { this.#secret = secret; }
  async clear(): Promise<void> { this.#secret = null; }
}

export interface CredentialCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CredentialCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { input?: string; environment?: NodeJS.ProcessEnv },
) => Promise<CredentialCommandResult>;

function run(
  executable: string,
  args: readonly string[],
  options: { input?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<CredentialCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | Uint8Array) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | Uint8Array) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => resolve({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(options.input ?? "");
  });
}

function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, platform === "win32" ? `${name}.exe` : name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) return candidate;
    } catch {
      // Missing or unreadable PATH entry.
    }
  }
  return null;
}

class MacKeychainCredentialStore implements CredentialStore {
  constructor(
    readonly securityPath: string,
    readonly expectPath: string,
    readonly account: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  async read(): Promise<string | null> {
    const result = await run(this.securityPath, ["find-generic-password", "-a", this.account, "-s", "com.formaspec.agent-grant", "-w"], {
      environment: this.environment,
    });
    if (result.exitCode !== 0) return null;
    const secret = result.stdout.trim();
    return secret || null;
  }

  async write(secret: string): Promise<void> {
    // macOS `security` reads the password prompt from a terminal rather than a
    // plain stdin pipe. The system `expect` helper supplies a private
    // pseudo-terminal while the secret remains on stdin and never appears in
    // argv, environment, logs, Codex config, or process listings.
    const expectProgram = [
      "set timeout 10",
      `set securityPath {${this.securityPath}}`,
      `set account {${this.account}}`,
      "if {[gets stdin secret] < 0} { exit 2 }",
      "log_user 0",
      "spawn $securityPath add-generic-password -U -a $account -s com.formaspec.agent-grant -w",
      "expect {",
      "  -re {(?i)password.*:} { send -- \"$secret\\r\"; exp_continue }",
      "  eof {}",
      "  timeout { exit 3 }",
      "}",
      "set result [wait]",
      "set code [lindex $result 3]",
      "unset secret",
      "exit $code",
    ].join("\n");
    const result = await run(
      this.expectPath,
      ["-c", expectProgram],
      { environment: this.environment, input: `${secret}\n` },
    );
    if (result.exitCode !== 0) throw new Error("macOS Keychain rejected the FormaSpec agent grant.");
    const stored = await this.read();
    const expectedBytes = Buffer.from(secret);
    const storedBytes = Buffer.from(stored ?? "");
    if (storedBytes.length !== expectedBytes.length || !timingSafeEqual(storedBytes, expectedBytes)) {
      await this.clear();
      throw new Error("macOS Keychain did not persist the FormaSpec agent grant exactly.");
    }
  }

  async clear(): Promise<void> {
    await run(this.securityPath, ["delete-generic-password", "-a", this.account, "-s", "com.formaspec.agent-grant"], {
      environment: this.environment,
    });
  }
}

class SecretServiceCredentialStore implements CredentialStore {
  constructor(
    readonly secretToolPath: string,
    readonly account: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  async read(): Promise<string | null> {
    const result = await run(this.secretToolPath, ["lookup", "service", "formaspec", "account", this.account], {
      environment: this.environment,
    });
    if (result.exitCode !== 0) return null;
    const secret = result.stdout.trim();
    return secret || null;
  }

  async write(secret: string): Promise<void> {
    const result = await run(
      this.secretToolPath,
      ["store", "--label=FormaSpec agent grant", "service", "formaspec", "account", this.account],
      { environment: this.environment, input: secret },
    );
    if (result.exitCode !== 0) throw new Error("Secret Service rejected the FormaSpec agent grant.");
  }

  async clear(): Promise<void> {
    await run(this.secretToolPath, ["clear", "service", "formaspec", "account", this.account], {
      environment: this.environment,
    });
  }
}

const WINDOWS_CREDENTIAL_MAX_BYTES = 1024 * 1024;

function assertPrivateCredentialDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The FormaSpec credential directory is not a safe regular directory.");
  }
}

class WindowsDpapiCredentialStore implements CredentialStore {
  readonly #credentialPath: string;

  constructor(
    readonly powershellPath: string,
    credentialDirectory: string,
    readonly account: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly commandRunner: CredentialCommandRunner,
  ) {
    assertPrivateCredentialDirectory(credentialDirectory);
    this.#credentialPath = path.join(credentialDirectory, `${account}.dpapi`);
  }

  async #powershell(script: string, input: string): Promise<CredentialCommandResult> {
    return this.commandRunner(this.powershellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], { environment: this.environment, input });
  }

  async read(): Promise<string | null> {
    let encrypted: string;
    try {
      const stat = fs.lstatSync(this.#credentialPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > WINDOWS_CREDENTIAL_MAX_BYTES) {
        throw new Error("The FormaSpec DPAPI credential file is invalid.");
      }
      encrypted = fs.readFileSync(this.#credentialPath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) {
      throw new Error("The FormaSpec DPAPI credential payload is invalid.");
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$cipherText = [Console]::In.ReadToEnd().Trim()",
      "$cipherBytes = [Convert]::FromBase64String($cipherText)",
      "$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($cipherBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "$plainText = [Text.Encoding]::UTF8.GetString($plainBytes)",
      "[Console]::Out.Write($plainText)",
    ].join("; ");
    const result = await this.#powershell(script, encrypted);
    if (result.exitCode !== 0) throw new Error("Windows DPAPI could not decrypt the FormaSpec agent grant for the current user.");
    return result.stdout || null;
  }

  async write(secret: string): Promise<void> {
    if (!secret || Buffer.byteLength(secret, "utf8") > WINDOWS_CREDENTIAL_MAX_BYTES) {
      throw new Error("The FormaSpec agent grant is empty or exceeds the DPAPI storage limit.");
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$plainText = [Console]::In.ReadToEnd()",
      "$plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)",
      "$cipherBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))",
    ].join("; ");
    const result = await this.#powershell(script, secret);
    const encrypted = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) {
      throw new Error("Windows DPAPI rejected the FormaSpec agent grant.");
    }
    assertPrivateCredentialDirectory(path.dirname(this.#credentialPath));
    const temporary = `${this.#credentialPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${encrypted}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.#credentialPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const stored = await this.read();
    const expectedBytes = Buffer.from(secret);
    const storedBytes = Buffer.from(stored ?? "");
    if (storedBytes.length !== expectedBytes.length || !timingSafeEqual(storedBytes, expectedBytes)) {
      await this.clear();
      throw new Error("Windows DPAPI did not persist the FormaSpec agent grant exactly.");
    }
  }

  async clear(): Promise<void> {
    fs.rmSync(this.#credentialPath, { force: true });
  }
}

class UnavailableCredentialStore implements CredentialStore {
  async read(): Promise<string | null> { return null; }
  async write(): Promise<void> {
    throw new Error("No supported OS credential store is available. Install Secret Service on Linux, ensure PowerShell/DPAPI is available on Windows, or use macOS Keychain.");
  }
  async clear(): Promise<void> {}
}

export function createSystemCredentialStore(
  upstreamMcpUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    commandRunner?: CredentialCommandRunner;
    dataStoreId?: string;
  } = {},
): CredentialStore {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? run;
  if (options.dataStoreId !== undefined && !/^store_[a-f0-9]{32}$/.test(options.dataStoreId)) {
    throw new Error("The FormaSpec data-store identity is invalid.");
  }
  const credentialIdentity = options.dataStoreId === undefined
    ? upstreamMcpUrl
    : `${upstreamMcpUrl}\0${options.dataStoreId}`;
  const account = `upstream-${createHash("sha256").update(credentialIdentity).digest("hex").slice(0, 24)}`;
  if (platform === "darwin") {
    const security = fs.existsSync("/usr/bin/security") ? "/usr/bin/security" : null;
    const expect = fs.existsSync("/usr/bin/expect") ? "/usr/bin/expect" : null;
    return security && expect
      ? new MacKeychainCredentialStore(security, expect, account, environment)
      : new UnavailableCredentialStore();
  }
  if (platform === "linux") {
    const secretTool = findExecutable("secret-tool", environment, platform);
    return secretTool ? new SecretServiceCredentialStore(secretTool, account, environment) : new UnavailableCredentialStore();
  }
  if (platform === "win32") {
    const powershell = findExecutable("powershell", environment, platform)
      ?? findExecutable("pwsh", environment, platform);
    const configuredDirectory = environment.FORMASPEC_CREDENTIALS_DIR;
    const localAppData = environment.LOCALAPPDATA;
    const credentialDirectory = configuredDirectory && path.isAbsolute(configuredDirectory)
      ? configuredDirectory
      : localAppData && path.isAbsolute(localAppData)
        ? path.join(localAppData, "FormaSpec", "credentials")
        : null;
    return powershell && credentialDirectory
      ? new WindowsDpapiCredentialStore(powershell, credentialDirectory, account, environment, commandRunner)
      : new UnavailableCredentialStore();
  }
  return new UnavailableCredentialStore();
}

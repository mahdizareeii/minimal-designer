import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { resolveAccess } from "./authorization.js";
import type { ServerConfig } from "./config.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";

const ORGANIZATION_ID = "organization_legacy";
const SESSION_COOKIE_NAME = "formaspec_session";
const SESSION_IDLE_MILLISECONDS = 8 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const LOGIN_LOCK_MILLISECONDS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;
const MAX_LOGIN_ATTEMPT_ROWS = 10_000;
const LOGIN_ATTEMPT_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const GLOBAL_LOGIN_FAILURE_LIMIT = 100;
const SOURCE_LOGIN_FAILURE_LIMIT = 20;
const SCRYPT_PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1_024 * 1_024 });
const DUMMY_SALT = Buffer.from("FormaSpec browser login timing salt v1", "utf8");

const LoginNameSchema = z.string().min(3).max(128).superRefine((value, context) => {
  const normalized = value.normalize("NFKC").trim();
  if (normalized !== value || !/^[\p{L}\p{N}][\p{L}\p{N}._@+-]{2,127}$/u.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Login name contains unsupported characters or spacing." });
  }
});

const PasswordSchema = z.string().min(12).max(256).superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Password contains unsupported control characters." });
  }
});

const BootstrapInputSchema = z.object({
  loginName: LoginNameSchema,
  displayName: z.string().min(1).max(120).optional(),
  password: PasswordSchema,
  bootstrapToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict();

const LoginInputSchema = z.object({
  loginName: LoginNameSchema,
  password: PasswordSchema,
}).strict();

export interface AuthenticatedBrowserSession {
  actorId: string;
  accountId: string;
  principalId: string;
  organizationId: string;
  loginName: string;
  displayName: string;
  csrfToken: string;
  tokenHash: string;
  expiresAt: string;
  idleExpiresAt: string;
}

interface CreatedBrowserSession extends AuthenticatedBrowserSession {
  sessionToken: string;
}

export interface BrowserAuthenticationStatus {
  mode: "local" | "none" | "session" | "trusted-header" | "token";
  bootstrapRequired: boolean;
  bootstrapTokenRequired: boolean;
  authenticated: boolean;
  csrfToken?: string;
  account?: {
    principalId: string;
    organizationId: string;
    loginName: string;
    displayName: string;
    role: string;
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeEqualStrings(left: string, right: string): boolean {
  return safeEqualBuffers(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeLoginName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizedDisplayName(value: string | undefined, loginName: string): string {
  const normalized = (value ?? loginName).normalize("NFKC").trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", "Display name is invalid.", 422);
  }
  return normalized;
}

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_PARAMETERS.keyLength, {
      N: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
      maxmem: SCRYPT_PARAMETERS.maxmem,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt);
  return [
    "scrypt",
    "1",
    String(SCRYPT_PARAMETERS.N),
    String(SCRYPT_PARAMETERS.r),
    String(SCRYPT_PARAMETERS.p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  if (encoded) {
    const parts = encoded.split("$");
    if (parts.length === 7
      && parts[0] === "scrypt"
      && parts[1] === "1"
      && Number(parts[2]) === SCRYPT_PARAMETERS.N
      && Number(parts[3]) === SCRYPT_PARAMETERS.r
      && Number(parts[4]) === SCRYPT_PARAMETERS.p) {
      try {
        const salt = Buffer.from(parts[5]!, "base64url");
        const expected = Buffer.from(parts[6]!, "base64url");
        if (salt.length === 16 && expected.length === SCRYPT_PARAMETERS.keyLength) {
          const actual = await deriveScrypt(password, salt);
          return safeEqualBuffers(actual, expected);
        }
      } catch {
        // Corrupt password metadata follows the same bounded dummy-work path.
      }
    }
  }
  await deriveScrypt(password, DUMMY_SALT);
  return false;
}

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

export function isPublicSessionAuthenticationPath(url: string): boolean {
  const path = requestPath(url);
  return path === "/api/auth/status"
    || path === "/api/auth/bootstrap"
    || path === "/api/auth/login";
}

export function isPublicSessionAuthenticationWritePath(url: string): boolean {
  const path = requestPath(url);
  return path === "/api/auth/bootstrap" || path === "/api/auth/login";
}

function sessionTokenFromRequest(request: FastifyRequest, optional: boolean): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  let token: string | null = null;
  for (const entry of header.split(";")) {
    const delimiter = entry.indexOf("=");
    if (delimiter < 1) continue;
    const name = entry.slice(0, delimiter).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    if (token !== null) {
      if (optional) return null;
      throw new DomainError("AUTH_REQUIRED", "The browser session cookie is ambiguous.", 401);
    }
    token = entry.slice(delimiter + 1).trim();
  }
  if (token !== null && !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    if (optional) return null;
    throw new DomainError("AUTH_REQUIRED", "The browser session is invalid or expired.", 401);
  }
  return token;
}

function csrfTokenForSession(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("formaspec-browser-session-csrf-v1", "utf8").digest("base64url");
}

function authenticationFailure(): DomainError {
  return new DomainError("AUTH_REQUIRED", "Invalid login credentials.", 401);
}

function loginAttemptHash(scope: "global" | "identity" | "source", value: string): string {
  return sha256(`${scope}\0${value}`);
}

interface LoginAttemptBucket {
  hash: string;
  maximumFailures: number;
}

function isoAfter(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

export class SessionAuthenticationService {
  private readonly now: () => Date;
  private readonly bootstrapTokenHash?: string;

  constructor(
    private readonly database: DesignerDatabase,
    options: { now?: () => Date; bootstrapTokenHash?: string; requireBootstrapCredential?: boolean } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.bootstrapTokenHash = options.bootstrapTokenHash;
    this.initializeBootstrapCredential(options.requireBootstrapCredential === true);
  }

  get bootstrapAuthorizationRequired(): boolean {
    return this.bootstrapTokenHash !== undefined;
  }

  hasBootstrapAccount(): boolean {
    const row = this.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM password_accounts WHERE bootstrap_account = 1",
    ).get() as { count: number };
    return row.count > 0;
  }

  async bootstrap(input: unknown): Promise<CreatedBrowserSession> {
    const parsed = BootstrapInputSchema.parse(input);
    if (this.hasBootstrapAccount()) {
      throw new DomainError("VERSION_CONFLICT", "Administrator bootstrap has already been completed.", 409);
    }
    if (this.bootstrapTokenHash) {
      const suppliedHash = parsed.bootstrapToken ? sha256(parsed.bootstrapToken) : "";
      const credential = this.database.sqlite.prepare(
        "SELECT token_hash, consumed_at FROM bootstrap_credentials WHERE id = 'initial_admin'",
      ).get() as { token_hash: string; consumed_at: string | null } | undefined;
      if (!credential || credential.consumed_at !== null) {
        throw new DomainError("VERSION_CONFLICT", "Administrator bootstrap has already been completed.", 409);
      }
      if (!safeEqualStrings(suppliedHash, credential.token_hash)
        || !safeEqualStrings(credential.token_hash, this.bootstrapTokenHash)) {
        throw new DomainError("AUTH_REQUIRED", "Invalid bootstrap authorization.", 401);
      }
    }
    const loginNameNormalized = normalizeLoginName(parsed.loginName);
    const displayName = normalizedDisplayName(parsed.displayName, parsed.loginName);
    const passwordHash = await hashPassword(parsed.password);
    const now = this.now();
    const nowIso = now.toISOString();
    const principalId = `principal_${randomUUID().replaceAll("-", "")}`;
    const accountId = `account_${randomUUID().replaceAll("-", "")}`;
    const session = this.prepareSession({ accountId, principalId, loginName: parsed.loginName, displayName, now });

    const transaction = this.database.sqlite.transaction(() => {
      const count = this.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM password_accounts WHERE bootstrap_account = 1",
      ).get() as { count: number };
      if (count.count !== 0) {
        throw new DomainError("VERSION_CONFLICT", "Administrator bootstrap has already been completed.", 409);
      }
      this.database.sqlite.prepare(
        `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
         VALUES (?, ?, 'human', ?, ?, ?)`,
      ).run(principalId, ORGANIZATION_ID, displayName, `password:${loginNameNormalized}`, nowIso);
      this.database.sqlite.prepare(
        `INSERT INTO memberships (organization_id, principal_id, role, created_at)
         VALUES (?, ?, 'organization_admin', ?)`,
      ).run(ORGANIZATION_ID, principalId, nowIso);
      this.database.sqlite.prepare(
        `INSERT INTO password_accounts
           (id, organization_id, principal_id, login_name, login_name_normalized,
            password_hash, bootstrap_account, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        accountId,
        ORGANIZATION_ID,
        principalId,
        parsed.loginName,
        loginNameNormalized,
        passwordHash,
        nowIso,
        nowIso,
      );
      if (this.bootstrapTokenHash) {
        const consumed = this.database.sqlite.prepare(
          `UPDATE bootstrap_credentials SET consumed_at = ?, consumed_by = ?
           WHERE id = 'initial_admin' AND token_hash = ? AND consumed_at IS NULL AND consumed_by IS NULL`,
        ).run(nowIso, principalId, this.bootstrapTokenHash);
        if (consumed.changes !== 1) {
          throw new DomainError("VERSION_CONFLICT", "Administrator bootstrap authorization is no longer available.", 409);
        }
      }
      this.insertPreparedSession(session, nowIso);
      this.database.sqlite.prepare(
        `INSERT INTO audit_events
           (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'auth.bootstrap_admin.created', 'principal', ?, ?, ?)`,
      ).run(
        ORGANIZATION_ID,
        session.actorId,
        principalId,
        JSON.stringify({ accountId, loginName: parsed.loginName, authentication: "password_session" }),
        nowIso,
      );
    });
    transaction.immediate();
    return session;
  }

  async login(input: unknown, sourceAddress = "unknown"): Promise<CreatedBrowserSession> {
    const parsed = LoginInputSchema.parse(input);
    const normalized = normalizeLoginName(parsed.loginName);
    const identityHash = loginAttemptHash("identity", normalized);
    const sourceHash = loginAttemptHash("source", sourceAddress.slice(0, 256));
    const globalHash = loginAttemptHash("global", "browser_login");
    const now = this.now();
    const broadBuckets: LoginAttemptBucket[] = [
      { hash: globalHash, maximumFailures: GLOBAL_LOGIN_FAILURE_LIMIT },
      { hash: sourceHash, maximumFailures: SOURCE_LOGIN_FAILURE_LIMIT },
    ];
    if (this.isLoginLocked(broadBuckets.map((bucket) => bucket.hash), now)) throw authenticationFailure();
    const account = this.database.sqlite.prepare(
      `SELECT a.id, a.organization_id, a.principal_id, a.login_name, a.password_hash,
              p.display_name, p.disabled_at, m.role
       FROM password_accounts a
       JOIN principals p ON p.id = a.principal_id AND p.organization_id = a.organization_id
       JOIN memberships m ON m.principal_id = p.id AND m.organization_id = p.organization_id
       WHERE a.organization_id = ? AND a.login_name_normalized = ? AND a.bootstrap_account = 1`,
    ).get(ORGANIZATION_ID, normalized) as {
      id: string;
      organization_id: string;
      principal_id: string;
      login_name: string;
      password_hash: string;
      display_name: string;
      disabled_at: string | null;
      role: string;
    } | undefined;
    const attemptBuckets = account
      ? [...broadBuckets, { hash: identityHash, maximumFailures: MAX_LOGIN_FAILURES }]
      : broadBuckets;
    if (account && this.isLoginLocked([identityHash], now)) throw authenticationFailure();
    const validPassword = await verifyPassword(parsed.password, account?.password_hash);
    if (!account || account.disabled_at || account.role !== "organization_admin" || !validPassword) {
      this.recordLoginFailures(attemptBuckets, now);
      throw authenticationFailure();
    }

    const session = this.prepareSession({
      accountId: account.id,
      principalId: account.principal_id,
      loginName: account.login_name,
      displayName: account.display_name,
      now,
    });
    const nowIso = now.toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("DELETE FROM login_attempts WHERE identity_hash IN (?, ?)")
        .run(identityHash, sourceHash);
      this.database.sqlite.prepare(
        "UPDATE browser_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
      ).run(nowIso, account.id);
      this.insertPreparedSession(session, nowIso);
      this.database.sqlite.prepare(
        `INSERT INTO audit_events
           (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'auth.session.created', 'browser_session', ?, '{}', ?)`,
      ).run(account.organization_id, session.actorId, session.id, nowIso);
    });
    transaction.immediate();
    return session;
  }

  optionalSession(request: FastifyRequest): AuthenticatedBrowserSession | null {
    return this.readSession(request, true);
  }

  requireSession(request: FastifyRequest): AuthenticatedBrowserSession {
    const session = this.readSession(request, false);
    if (!session) throw new DomainError("AUTH_REQUIRED", "A valid browser session is required.", 401);
    return session;
  }

  requireCsrf(request: FastifyRequest, session: AuthenticatedBrowserSession, headerName: string): void {
    const supplied = request.headers[headerName];
    if (typeof supplied !== "string" || !safeEqualStrings(supplied, session.csrfToken)) {
      throw new DomainError("FORBIDDEN", `Missing or invalid session CSRF header ${headerName}.`, 403);
    }
  }

  logout(request: FastifyRequest): void {
    const token = sessionTokenFromRequest(request, false);
    if (!token) throw new DomainError("AUTH_REQUIRED", "A valid browser session is required.", 401);
    const tokenHash = sha256(token);
    const nowIso = this.now().toISOString();
    const row = this.database.sqlite.prepare(
      "SELECT id, organization_id, principal_id FROM browser_sessions WHERE token_hash = ?",
    ).get(tokenHash) as { id: string; organization_id: string; principal_id: string } | undefined;
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        "UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
      ).run(nowIso, tokenHash);
      if (row) {
        this.database.sqlite.prepare(
          `INSERT INTO audit_events
             (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
           VALUES (?, ?, 'auth.session.revoked', 'browser_session', ?, '{}', ?)`,
        ).run(row.organization_id, `session:${row.id}:${row.principal_id}`, row.id, nowIso);
      }
    });
    transaction.immediate();
  }

  sessionCookie(session: CreatedBrowserSession, secure: boolean): string {
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - this.now().getTime()) / 1_000));
    return `${SESSION_COOKIE_NAME}=${session.sessionToken}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  private prepareSession(input: {
    accountId: string;
    principalId: string;
    loginName: string;
    displayName: string;
    now: Date;
  }): CreatedBrowserSession & { id: string; csrfTokenHash: string } {
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = csrfTokenForSession(sessionToken);
    const expiresAt = isoAfter(input.now, SESSION_ABSOLUTE_MILLISECONDS);
    const idleExpiresAt = isoAfter(input.now, SESSION_IDLE_MILLISECONDS);
    const id = `session_${randomUUID().replaceAll("-", "")}`;
    return {
      id,
      actorId: `session:${id}:${input.principalId}`,
      accountId: input.accountId,
      principalId: input.principalId,
      organizationId: ORGANIZATION_ID,
      loginName: input.loginName,
      displayName: input.displayName,
      sessionToken,
      csrfToken,
      csrfTokenHash: sha256(csrfToken),
      tokenHash: sha256(sessionToken),
      expiresAt,
      idleExpiresAt,
    };
  }

  private initializeBootstrapCredential(required: boolean): void {
    const nowIso = this.now().toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      const account = this.database.sqlite.prepare(
        `SELECT principal_id FROM password_accounts
         WHERE bootstrap_account = 1 ORDER BY created_at, id LIMIT 1`,
      ).get() as { principal_id: string } | undefined;
      const credential = this.database.sqlite.prepare(
        "SELECT token_hash, consumed_at, consumed_by FROM bootstrap_credentials WHERE id = 'initial_admin'",
      ).get() as { token_hash: string; consumed_at: string | null; consumed_by: string | null } | undefined;
      if (account) {
        if (credential && credential.consumed_at === null) {
          this.database.sqlite.prepare(
            `UPDATE bootstrap_credentials SET consumed_at = ?, consumed_by = ?
             WHERE id = 'initial_admin' AND consumed_at IS NULL AND consumed_by IS NULL`,
          ).run(nowIso, account.principal_id);
        }
        return;
      }
      if (!this.bootstrapTokenHash) {
        if (required) {
          throw new Error(
            "A fresh server session deployment requires FORMASPEC_BOOTSTRAP_TOKEN_HASH until the first administrator is created.",
          );
        }
        return;
      }
      if (!credential) {
        this.database.sqlite.prepare(
          `INSERT INTO bootstrap_credentials (id, token_hash, created_at, consumed_at, consumed_by)
           VALUES ('initial_admin', ?, ?, ?, ?)`,
        ).run(
          this.bootstrapTokenHash,
          nowIso,
          null,
          null,
        );
        return;
      }
      if (!safeEqualStrings(credential.token_hash, this.bootstrapTokenHash)) {
        this.database.sqlite.prepare(
          `UPDATE bootstrap_credentials SET token_hash = ?
           WHERE id = 'initial_admin' AND consumed_at IS NULL AND consumed_by IS NULL`,
        ).run(this.bootstrapTokenHash);
      }
      if (credential.consumed_at !== null) {
        throw new Error("Bootstrap authorization is consumed without a persisted password administrator account.");
      }
    });
    transaction.immediate();
  }

  private insertPreparedSession(
    session: CreatedBrowserSession & { id: string; csrfTokenHash: string },
    nowIso: string,
  ): void {
    this.database.sqlite.prepare(
      `INSERT INTO browser_sessions
         (id, organization_id, account_id, principal_id, token_hash, csrf_token_hash,
          created_at, last_used_at, idle_expires_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      session.id,
      session.organizationId,
      session.accountId,
      session.principalId,
      session.tokenHash,
      session.csrfTokenHash,
      nowIso,
      nowIso,
      session.idleExpiresAt,
      session.expiresAt,
    );
  }

  private readSession(request: FastifyRequest, optional: boolean): AuthenticatedBrowserSession | null {
    const token = sessionTokenFromRequest(request, optional);
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = this.database.sqlite.prepare(
      `SELECT s.id, s.organization_id, s.account_id, s.principal_id, s.csrf_token_hash,
              s.idle_expires_at, s.expires_at, s.revoked_at,
              a.login_name, p.display_name, p.disabled_at
       FROM browser_sessions s
       JOIN password_accounts a ON a.id = s.account_id
         AND a.organization_id = s.organization_id AND a.principal_id = s.principal_id
       JOIN principals p ON p.id = s.principal_id AND p.organization_id = s.organization_id
       WHERE s.token_hash = ?`,
    ).get(tokenHash) as {
      id: string;
      organization_id: string;
      account_id: string;
      principal_id: string;
      csrf_token_hash: string;
      idle_expires_at: string;
      expires_at: string;
      revoked_at: string | null;
      login_name: string;
      display_name: string;
      disabled_at: string | null;
    } | undefined;
    const now = this.now();
    const nowIso = now.toISOString();
    const csrfToken = csrfTokenForSession(token);
    const unavailable = !row
      || row.revoked_at !== null
      || row.disabled_at !== null
      || row.idle_expires_at <= nowIso
      || row.expires_at <= nowIso
      || !safeEqualStrings(sha256(csrfToken), row.csrf_token_hash);
    if (unavailable) {
      if (row && row.revoked_at === null) {
        this.database.sqlite.prepare(
          "UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        ).run(nowIso, row.id);
      }
      if (optional) return null;
      throw new DomainError("AUTH_REQUIRED", "The browser session is invalid or expired.", 401);
    }
    const idleExpiresAt = new Date(Math.min(
      now.getTime() + SESSION_IDLE_MILLISECONDS,
      Date.parse(row.expires_at),
    )).toISOString();
    this.database.sqlite.prepare(
      `UPDATE browser_sessions SET last_used_at = ?, idle_expires_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(nowIso, idleExpiresAt, row.id);
    return {
      actorId: `session:${row.id}:${row.principal_id}`,
      accountId: row.account_id,
      principalId: row.principal_id,
      organizationId: row.organization_id,
      loginName: row.login_name,
      displayName: row.display_name,
      csrfToken,
      tokenHash,
      expiresAt: row.expires_at,
      idleExpiresAt,
    };
  }

  private isLoginLocked(attemptHashes: readonly string[], now: Date): boolean {
    const read = this.database.sqlite.prepare(
      "SELECT locked_until FROM login_attempts WHERE identity_hash = ? AND locked_until > ?",
    );
    return attemptHashes.some((attemptHash) => read.get(attemptHash, now.toISOString()) !== undefined);
  }

  private recordLoginFailures(attemptBuckets: readonly LoginAttemptBucket[], now: Date): void {
    const nowIso = now.toISOString();
    const retentionCutoff = new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MILLISECONDS).toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        `DELETE FROM login_attempts WHERE identity_hash IN (
           SELECT identity_hash FROM login_attempts
           WHERE updated_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
           ORDER BY updated_at, identity_hash LIMIT 512
         )`,
      ).run(retentionCutoff, nowIso);
      const count = this.database.sqlite.prepare("SELECT COUNT(*) AS count FROM login_attempts").get() as { count: number };
      if (count.count >= MAX_LOGIN_ATTEMPT_ROWS) {
        this.database.sqlite.prepare(
          `DELETE FROM login_attempts WHERE identity_hash IN (
             SELECT identity_hash FROM login_attempts
             WHERE locked_until IS NULL OR locked_until <= ?
             ORDER BY updated_at, identity_hash LIMIT 512
           )`,
        ).run(nowIso);
      }
      const read = this.database.sqlite.prepare(
        `SELECT failure_count, window_started_at
         FROM login_attempts WHERE identity_hash = ?`,
      );
      const write = this.database.sqlite.prepare(
        `INSERT INTO login_attempts
           (identity_hash, failure_count, window_started_at, locked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(identity_hash) DO UPDATE SET
           failure_count = excluded.failure_count,
           window_started_at = excluded.window_started_at,
           locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`,
      );
      const uniqueBuckets = new Map(attemptBuckets.map((bucket) => [bucket.hash, bucket]));
      for (const bucket of uniqueBuckets.values()) {
        const row = read.get(bucket.hash) as {
          failure_count: number;
          window_started_at: string;
        } | undefined;
        const inWindow = row !== undefined
          && Number.isFinite(Date.parse(row.window_started_at))
          && now.getTime() - Date.parse(row.window_started_at) < LOGIN_WINDOW_MILLISECONDS;
        const failureCount = inWindow ? Math.min(1_000, row.failure_count + 1) : 1;
        write.run(
          bucket.hash,
          failureCount,
          inWindow ? row.window_started_at : nowIso,
          failureCount >= bucket.maximumFailures ? isoAfter(now, LOGIN_LOCK_MILLISECONDS) : null,
          nowIso,
        );
      }
    });
    transaction.immediate();
  }
}

function statusFromAccess(
  mode: BrowserAuthenticationStatus["mode"],
  database: DesignerDatabase,
  actorId: string,
): BrowserAuthenticationStatus {
  const access = resolveAccess(database.sqlite, actorId);
  const principal = database.sqlite.prepare(
    "SELECT display_name FROM principals WHERE id = ? AND organization_id = ?",
  ).get(access.principalId, access.organizationId) as { display_name: string } | undefined;
  return {
    mode,
    bootstrapRequired: false,
    bootstrapTokenRequired: false,
    authenticated: true,
    csrfToken: "1",
    account: {
      principalId: access.principalId,
      organizationId: access.organizationId,
      loginName: actorId,
      displayName: principal?.display_name ?? actorId,
      role: access.role,
    },
  };
}

function authenticationResponse(
  database: DesignerDatabase,
  session: AuthenticatedBrowserSession,
): BrowserAuthenticationStatus {
  const access = resolveAccess(database.sqlite, session.actorId);
  return {
    mode: "session",
    bootstrapRequired: false,
    bootstrapTokenRequired: false,
    authenticated: true,
    csrfToken: session.csrfToken,
    account: {
      principalId: session.principalId,
      organizationId: session.organizationId,
      loginName: session.loginName,
      displayName: session.displayName,
      role: access.role,
    },
  };
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
}

export function registerSessionAuthenticationRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  database: DesignerDatabase,
  service: SessionAuthenticationService,
): void {
  const secureCookie = config.appMode === "server" || new URL(config.publicBaseUrl).protocol === "https:";
  app.get("/api/auth/status", async (request, reply) => {
    noStore(reply);
    if (config.authMode !== "session") {
      return statusFromAccess(config.appMode === "local" ? "local" : config.authMode, database, request.actorId);
    }
    const session = service.optionalSession(request);
    if (!session) {
      const bootstrapRequired = !service.hasBootstrapAccount();
      return {
        mode: "session",
        bootstrapRequired,
        bootstrapTokenRequired: bootstrapRequired && service.bootstrapAuthorizationRequired,
        authenticated: false,
      } satisfies BrowserAuthenticationStatus;
    }
    return authenticationResponse(database, session);
  });

  app.post("/api/auth/bootstrap", async (request, reply) => {
    noStore(reply);
    if (config.authMode !== "session") {
      throw new DomainError("NOT_FOUND", "Password-session bootstrap is not available in this mode.", 404);
    }
    const session = await service.bootstrap(request.body);
    reply.header("set-cookie", service.sessionCookie(session, secureCookie));
    return reply.code(201).send(authenticationResponse(database, session));
  });

  app.post("/api/auth/login", async (request, reply) => {
    noStore(reply);
    if (config.authMode !== "session") {
      throw new DomainError("NOT_FOUND", "Password-session login is not available in this mode.", 404);
    }
    const session = await service.login(request.body, request.ip);
    reply.header("set-cookie", service.sessionCookie(session, secureCookie));
    return reply.send(authenticationResponse(database, session));
  });

  app.get("/api/auth/session", async (request, reply) => {
    noStore(reply);
    if (config.authMode !== "session") {
      return statusFromAccess(config.appMode === "local" ? "local" : config.authMode, database, request.actorId);
    }
    return authenticationResponse(database, service.requireSession(request));
  });

  app.post("/api/auth/logout", async (request, reply) => {
    noStore(reply);
    if (config.authMode !== "session") {
      throw new DomainError("NOT_FOUND", "Password-session logout is not available in this mode.", 404);
    }
    service.logout(request);
    reply.header("set-cookie", service.clearSessionCookie(secureCookie));
    return reply.code(204).send();
  });
}

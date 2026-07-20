import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;

interface PairingRecord {
  expiresAt: number;
}

export interface IssuedPairingNonce {
  nonce: string;
  expiresAt: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class PairingNonceStore {
  readonly #records = new Map<string, PairingRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(ttlMs = DEFAULT_TTL_MS): IssuedPairingNonce {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      throw new Error("Pairing nonce TTL must be between 30 seconds and 15 minutes.");
    }
    this.purgeExpired();
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.#records.set(digest(nonce), { expiresAt });
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(nonce: string): boolean {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(nonce)) return false;
    const key = digest(nonce);
    const record = this.#records.get(key);
    this.#records.delete(key);
    return record !== undefined && record.expiresAt > this.now();
  }

  purgeExpired(): void {
    const current = this.now();
    for (const [key, record] of this.#records) {
      if (record.expiresAt <= current) this.#records.delete(key);
    }
  }

  publicState(): { pendingCount: number } {
    this.purgeExpired();
    return { pendingCount: this.#records.size };
  }
}

import { createClientKey } from "../domain";
import { ApiError } from "./api";

interface MutationAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

export function mutationFingerprint(kind: string, input: unknown): string {
  return `${kind}:${JSON.stringify(canonicalize(input))}`;
}

export function isIndeterminateMutationFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE" || error.status === 0;
}

export class MutationIdempotencyRegistry {
  readonly #attempts = new Map<string, MutationAttempt>();

  keyFor(scope: string, fingerprint: string, prefix: string): string {
    const current = this.#attempts.get(scope);
    if (current?.fingerprint === fingerprint) return current.idempotencyKey;
    const idempotencyKey = createClientKey(prefix);
    this.#attempts.set(scope, { fingerprint, idempotencyKey });
    return idempotencyKey;
  }

  complete(scope: string, fingerprint: string): void {
    if (this.#attempts.get(scope)?.fingerprint === fingerprint) this.#attempts.delete(scope);
  }

  fail(scope: string, fingerprint: string, error: unknown): void {
    if (!isIndeterminateMutationFailure(error)) this.complete(scope, fingerprint);
  }

  clear(scope: string): void {
    this.#attempts.delete(scope);
  }
}

export const manualMutationIdempotency = new MutationIdempotencyRegistry();

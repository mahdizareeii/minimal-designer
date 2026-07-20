import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

export const INTERNAL_PROXY_SECRET_HEADER = "x-formaspec-proxy-secret" as const;

const internalProxySecretPattern = /^[A-Za-z0-9._-]{32,256}$/;

const identityHeaderPattern = /^x-[a-z0-9][a-z0-9-]{0,125}$/;

const reservedIdentityHeaders = new Set([
  "x-api-key",
  "x-correlation-id",
  "x-forwarded-client-cert",
  "x-http-method-override",
  "x-real-ip",
  "x-request-id",
  INTERNAL_PROXY_SECRET_HEADER,
]);

const reservedIdentityPrefixes = [
  "x-auth",
  "x-csrf",
  "x-forwarded-",
  "x-original-",
  "x-proxy-",
  "x-rewrite-",
  "x-xsrf",
];

/**
 * Identity headers are an authentication boundary, not general HTTP metadata.
 * Requiring a dedicated x-* name prevents collisions with automatic browser,
 * proxy, hop-by-hop, forwarding, Host, Origin, authorization, and CSRF fields.
 */
export function validateTrustedIdentityHeader(header: string, csrfHeader: string): string {
  const normalized = header.trim().toLowerCase();
  const normalizedCsrf = csrfHeader.trim().toLowerCase();
  if (!identityHeaderPattern.test(normalized)
    || normalized === normalizedCsrf
    || reservedIdentityHeaders.has(normalized)
    || reservedIdentityPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(
      "TRUSTED_USER_HEADER must be a dedicated x-* identity header and must not collide with reserved, forwarding, authentication, Host, Origin, or CSRF headers",
    );
  }
  return normalized;
}

/**
 * The proxy credential is an internal hop credential, not a user/session token.
 * Keep it bounded and header-safe so launchers and reverse proxies can inject it
 * without quoting ambiguity or accidental multiline configuration.
 */
export function validateInternalProxySecret(secret: string | undefined): string {
  if (secret === undefined || !internalProxySecretPattern.test(secret)) {
    throw new Error(
      "FORMASPEC_PROXY_SECRET must contain 32 to 256 header-safe characters in APP_MODE=server",
    );
  }
  return secret;
}

/** Compare fixed-size digests so valid and invalid candidate lengths share the same comparison path. */
export function internalProxySecretMatches(expected: string, candidate: unknown): boolean {
  const candidateValue = typeof candidate === "string" ? candidate : "";
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const candidateDigest = createHash("sha256").update(candidateValue, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

export type TrustedProxyMatcher = (address: string | undefined) => boolean;

function normalizedSocketAddress(address: string): string {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/** Compile only literal IP addresses and CIDRs; named proxy shortcuts are not accepted. */
export function compileTrustedProxyMatcher(entries: readonly string[]): TrustedProxyMatcher {
  const blockList = new BlockList();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("/");
    const network = separator === -1 ? entry : entry.slice(0, separator);
    const familyNumber = isIP(network);
    if (familyNumber === 0) {
      throw new Error(`FORMASPEC_TRUSTED_PROXIES contains an invalid IP address or CIDR: ${entry}`);
    }
    const family = familyNumber === 4 ? "ipv4" : "ipv6";
    try {
      if (separator === -1) {
        blockList.addAddress(network, family);
      } else {
        const prefixText = entry.slice(separator + 1);
        if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText)) throw new Error("invalid prefix");
        const prefix = Number(prefixText);
        const maximum = familyNumber === 4 ? 32 : 128;
        if (prefix > maximum) throw new Error("invalid prefix");
        blockList.addSubnet(network, prefix, family);
      }
    } catch {
      throw new Error(`FORMASPEC_TRUSTED_PROXIES contains an invalid IP address or CIDR: ${entry}`);
    }
  }

  return (address) => {
    if (!address) return false;
    const normalized = normalizedSocketAddress(address);
    const familyNumber = isIP(normalized);
    return familyNumber !== 0 && blockList.check(normalized, familyNumber === 4 ? "ipv4" : "ipv6");
  };
}

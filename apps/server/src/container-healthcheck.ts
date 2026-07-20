import http, { type RequestOptions } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 4310;
const DEFAULT_TIMEOUT_MS = 4_000;

export interface ContainerHealthcheckTarget {
  connectHost: "127.0.0.1";
  port: number;
  hostHeader: string;
  path: "/health/ready";
}

function parsePort(value: string | undefined): number {
  const normalized = value?.trim() || String(DEFAULT_PORT);
  if (!/^\d+$/.test(normalized)) throw new Error("PORT must be an integer from 1 to 65535.");
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function loopbackHostHeader(environment: NodeJS.ProcessEnv, port: number): string {
  for (const entry of (environment.FORMASPEC_ALLOWED_HOSTS ?? "").split(",")) {
    const candidate = entry.trim().toLowerCase();
    if (!candidate) continue;
    try {
      if (isLoopbackHostname(new URL(`http://${candidate}`).hostname)) return candidate;
    } catch {
      // The application configuration reports malformed allowlist entries.
    }
  }
  if (environment.PUBLIC_BASE_URL) {
    const publicUrl = new URL(environment.PUBLIC_BASE_URL);
    if (isLoopbackHostname(publicUrl.hostname)) return publicUrl.host.toLowerCase();
  }
  return `127.0.0.1:${port}`;
}

export function resolveContainerHealthcheckTarget(
  environment: NodeJS.ProcessEnv = process.env,
): ContainerHealthcheckTarget {
  const appMode = environment.APP_MODE?.trim() || "local";
  if (appMode !== "local" && appMode !== "server") {
    throw new Error("APP_MODE must be local or server.");
  }
  const port = parsePort(environment.PORT);
  let hostHeader: string;
  if (appMode === "server") {
    if (!environment.PUBLIC_BASE_URL) {
      throw new Error("PUBLIC_BASE_URL is required for the server-mode container healthcheck.");
    }
    const publicUrl = new URL(environment.PUBLIC_BASE_URL);
    if (publicUrl.protocol !== "https:") {
      throw new Error("Server-mode PUBLIC_BASE_URL must use HTTPS.");
    }
    hostHeader = publicUrl.host.toLowerCase();
  } else {
    hostHeader = loopbackHostHeader(environment, port);
  }
  return {
    connectHost: "127.0.0.1",
    port,
    hostHeader,
    path: "/health/ready",
  };
}

export function containerHealthcheckRequestOptions(target: ContainerHealthcheckTarget): RequestOptions {
  return {
    hostname: target.connectHost,
    port: target.port,
    path: target.path,
    method: "GET",
    headers: {
      accept: "application/json",
      host: target.hostHeader,
    },
  };
}

export function probeContainerReadiness(
  target = resolveContainerHealthcheckTarget(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = http.request(containerHealthcheckRequestOptions(target), (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`FormaSpec readiness returned HTTP ${response.statusCode ?? "unknown"}.`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("FormaSpec readiness probe timed out.")));
    request.once("error", reject);
    request.end();
  });
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  try {
    await probeContainerReadiness();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown readiness error.";
    process.stderr.write(`FormaSpec container healthcheck failed: ${message}\n`);
    process.exitCode = 1;
  }
}

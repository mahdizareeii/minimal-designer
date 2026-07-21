import http, {
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

const PUBLIC_HOST = "design.example.test";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const TRUSTED_PROXY_ADDRESS = "::1";
const TRUSTED_IDENTITY_HEADER = "x-company-identity";
const PROXY_SECRET_HEADER = "x-formaspec-proxy-secret";
const FIRST_PROXY_SECRET = "proxy-secret-first-0123456789abcdef0123456789";
const SECOND_PROXY_SECRET = "proxy-secret-second-0123456789abcdef01234567";
const CANONICAL_IDENTITY = "operator@example.test";

interface HttpResult {
  statusCode: number;
  body: string;
}

interface ProxyState {
  backendPort: number;
  secret: string;
  identity: string;
  appendIdentity: boolean;
  appendSecret: boolean;
  omitSecret: boolean;
}

interface ObservedProxyHeaders {
  host: string | undefined;
  forwarded: string | string[] | undefined;
  forwardedFor: string | string[] | undefined;
  forwardedHost: string | string[] | undefined;
  forwardedProto: string | string[] | undefined;
  realIp: string | string[] | undefined;
  identity: string | string[] | undefined;
  proxySecret: string | string[] | undefined;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener address.");
  return (address as AddressInfo).port;
}

function normalizedAddress(address: string | undefined): string {
  if (!address) return "127.0.0.1";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeProxyHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...incoming };
  for (const header of [
    "connection",
    "forwarded",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-original-forwarded-for",
    "x-real-ip",
    TRUSTED_IDENTITY_HEADER,
    PROXY_SECRET_HEADER,
  ]) delete headers[header];
  return headers;
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return addressPort(server);
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request(
  port: number,
  url: string,
  headers: OutgoingHttpHeaders = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: url,
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    client.once("error", reject);
    client.end();
  });
}

async function startBackend(root: string, proxySecret: string): Promise<{
  application: DesignerApplication;
  port: number;
  observations: ObservedProxyHeaders[];
}> {
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "::",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "compatibility-token-0123456789abcdef",
    TRUSTED_USER_HEADER: TRUSTED_IDENTITY_HEADER,
    FORMASPEC_ALLOWED_HOSTS: PUBLIC_HOST,
    FORMASPEC_TRUSTED_PROXIES: TRUSTED_PROXY_ADDRESS,
    FORMASPEC_PROXY_SECRET: proxySecret,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  const observations: ObservedProxyHeaders[] = [];
  application.app.addHook("onRequest", async (request_) => {
    if (!request_.url.startsWith("/api/designs")) return;
    observations.push({
      host: request_.headers.host,
      forwarded: request_.headers.forwarded,
      forwardedFor: request_.headers["x-forwarded-for"],
      forwardedHost: request_.headers["x-forwarded-host"],
      forwardedProto: request_.headers["x-forwarded-proto"],
      realIp: request_.headers["x-real-ip"],
      identity: request_.headers[TRUSTED_IDENTITY_HEADER],
      proxySecret: request_.headers[PROXY_SECRET_HEADER],
    });
  });
  await application.app.listen({ host: "::", port: 0 });
  const address = application.app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected the backend to use a TCP listener.");
  return { application, port: address.port, observations };
}

function startReverseProxy(state: ProxyState): Server {
  return http.createServer((incoming, outgoing) => {
    const headers = sanitizeProxyHeaders(incoming.headers);
    const clientAddress = normalizedAddress(incoming.socket.remoteAddress);
    headers.host = PUBLIC_HOST;
    headers["x-forwarded-for"] = clientAddress;
    headers["x-forwarded-host"] = PUBLIC_HOST;
    headers["x-forwarded-proto"] = "https";
    headers["x-real-ip"] = clientAddress;
    headers[TRUSTED_IDENTITY_HEADER] = state.appendIdentity
      ? [...headerValues(incoming.headers[TRUSTED_IDENTITY_HEADER]), state.identity]
      : state.identity;
    if (!state.omitSecret) {
      headers[PROXY_SECRET_HEADER] = state.appendSecret
        ? [...headerValues(incoming.headers[PROXY_SECRET_HEADER]), state.secret]
        : state.secret;
    }

    const upstream = http.request({
      host: "::1",
      port: state.backendPort,
      method: incoming.method,
      path: incoming.url,
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const body = Buffer.concat(chunks);
        outgoing.writeHead(response.statusCode ?? 502, {
          "content-type": response.headers["content-type"] ?? "application/octet-stream",
          "content-length": String(body.length),
        });
        outgoing.end(body);
      });
    });
    upstream.once("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("upstream unavailable");
    });
    incoming.pipe(upstream);
  });
}

describe("server reverse-proxy lifecycle", () => {
  it("overwrites authentication headers, denies the direct backend port, and requires restart for secret rotation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-proxy-lifecycle-"));
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
    let proxy: Server | undefined;
    try {
      backend = await startBackend(root, FIRST_PROXY_SECRET);
      const state: ProxyState = {
        backendPort: backend.port,
        secret: FIRST_PROXY_SECRET,
        identity: CANONICAL_IDENTITY,
        appendIdentity: false,
        appendSecret: false,
        omitSecret: false,
      };
      proxy = startReverseProxy(state);
      const proxyPort = await listen(proxy, "127.0.0.1");

      const direct = await request(backend.port, "/api/designs", {
        host: PUBLIC_HOST,
        [TRUSTED_IDENTITY_HEADER]: "direct-attacker@example.test",
        [PROXY_SECRET_HEADER]: FIRST_PROXY_SECRET,
      });
      expect(direct.statusCode).toBe(403);

      state.omitSecret = true;
      const proxiedHealth = await request(proxyPort, "/health/live", {
        host: "attacker.invalid",
        [TRUSTED_IDENTITY_HEADER]: "attacker@example.test",
        [PROXY_SECRET_HEADER]: "attacker-controlled-secret-0123456789abcdef",
      });
      expect(proxiedHealth.statusCode).toBe(200);
      const directHealth = await request(backend.port, "/health/live", { host: PUBLIC_HOST });
      expect(directHealth.statusCode).toBe(403);
      state.omitSecret = false;

      const proxied = await request(proxyPort, "/api/designs", {
        host: "attacker.invalid",
        forwarded: "for=203.0.113.45;proto=http;host=attacker.invalid",
        "x-forwarded-for": "203.0.113.45, 198.51.100.9",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
        [TRUSTED_IDENTITY_HEADER]: ["attacker@example.test", "second-attacker@example.test"],
        [PROXY_SECRET_HEADER]: "attacker-controlled-secret-0123456789abcdef",
      });
      expect(proxied.statusCode).toBe(200);
      expect(backend.observations.at(-1)).toEqual({
        host: PUBLIC_HOST,
        forwarded: undefined,
        forwardedFor: "127.0.0.1",
        forwardedHost: PUBLIC_HOST,
        forwardedProto: "https",
        realIp: "127.0.0.1",
        identity: CANONICAL_IDENTITY,
        proxySecret: FIRST_PROXY_SECRET,
      });
      expect(backend.application.database.sqlite.prepare(
        "SELECT external_id FROM principals WHERE external_id LIKE 'trusted:%' ORDER BY external_id",
      ).all()).toEqual([{ external_id: `trusted:${CANONICAL_IDENTITY}` }]);

      state.appendIdentity = true;
      const appendedIdentity = await request(proxyPort, "/api/designs", {
        [TRUSTED_IDENTITY_HEADER]: "attacker@example.test",
      });
      expect(appendedIdentity.statusCode).toBe(401);
      state.appendIdentity = false;

      state.identity = "é".repeat(101);
      expect((await request(proxyPort, "/api/designs")).statusCode).toBe(401);
      state.identity = CANONICAL_IDENTITY;

      state.appendSecret = true;
      const appendedSecret = await request(proxyPort, "/api/designs", {
        [PROXY_SECRET_HEADER]: "attacker-controlled-secret-0123456789abcdef",
      });
      expect(appendedSecret.statusCode).toBe(403);
      state.appendSecret = false;

      state.secret = SECOND_PROXY_SECRET;
      const beforeRestart = await request(proxyPort, "/api/designs");
      expect(beforeRestart.statusCode).toBe(403);

      await backend.application.app.close();
      backend = await startBackend(root, SECOND_PROXY_SECRET);
      state.backendPort = backend.port;

      const afterRestart = await request(proxyPort, "/api/designs");
      expect(afterRestart.statusCode).toBe(200);
      state.secret = FIRST_PROXY_SECRET;
      const staleAfterRestart = await request(proxyPort, "/api/designs");
      expect(staleAfterRestart.statusCode).toBe(403);
      state.secret = SECOND_PROXY_SECRET;

      expect(backend.application.database.sqlite.prepare(
        "SELECT external_id FROM principals WHERE external_id LIKE 'trusted:%' ORDER BY external_id",
      ).all()).toEqual([{ external_id: `trusted:${CANONICAL_IDENTITY}` }]);
    } finally {
      await closeServer(proxy);
      await backend?.application.app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

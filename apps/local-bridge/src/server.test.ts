import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { PairingNonceStore } from "./pairing.js";
import { MemoryCredentialStore } from "./credentials.js";
import { startBridgeServer, validateLoopbackMcpUrl, type RunningBridge } from "./server.js";

const bridges: RunningBridge[] = [];
const upstreams: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.allSettled(upstreams.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startUpstream(handler: http.RequestListener): Promise<{ url: string }> {
  const server = http.createServer(handler);
  upstreams.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No upstream address.");
  return { url: `http://127.0.0.1:${address.port}/mcp` };
}

async function postWithHost(url: string, hostHeader: string, body: string): Promise<number> {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: {
        host: hostHeader,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

describe("FormaSpec local bridge", () => {
  it("serves loopback health and one-time pairing nonces without exposing stored nonce material", async () => {
    const upstream = await startUpstream((_request, response) => response.end());
    const pairingStore = new PairingNonceStore();
    const bridge = await startBridgeServer({ port: 0, upstreamMcpUrl: upstream.url, pairingStore });
    bridges.push(bridge);

    const issued = await fetch(`${bridge.url}/pairing-nonces`, { method: "POST" }).then((response) => response.json()) as { nonce: string };
    const health = await fetch(`${bridge.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    expect(JSON.stringify(health)).not.toContain(issued.nonce);
    expect(pairingStore.publicState()).toEqual({ pendingCount: 1 });

    const first = await fetch(`${bridge.url}/pairing-nonces/consume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: issued.nonce }),
    });
    const replay = await fetch(`${bridge.url}/pairing-nonces/consume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: issued.nonce }),
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
  });

  it("proxies the MCP boundary while stripping browser and caller credentials", async () => {
    let observedHeaders: http.IncomingHttpHeaders = {};
    const upstream = await startUpstream((request, response) => {
      observedHeaders = request.headers;
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
      response.end('{"jsonrpc":"2.0","result":{}}');
    });
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.write("fsg_bridge-secret");
    const bridge = await startBridgeServer({ port: 0, upstreamMcpUrl: upstream.url, credentialStore });
    bridges.push(bridge);

    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-cross-boundary",
        cookie: "secret=cookie",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    expect(response.status).toBe(200);
    expect(observedHeaders.authorization).toBe("Bearer fsg_bridge-secret");
    expect(observedHeaders.cookie).toBeUndefined();
    expect(observedHeaders["mcp-protocol-version"]).toBe("2025-06-18");
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
  });

  it("fails closed without a stored scoped grant even when the caller supplies Authorization", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end('{}');
    });
    const bridge = await startBridgeServer({ port: 0, upstreamMcpUrl: upstream.url });
    bridges.push(bridge);

    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer fsg_caller-cannot-substitute",
        "content-type": "application/json",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "BRIDGE_AUTH_REQUIRED" });
    expect(upstreamRequests).toBe(0);
  });

  it("requires a browser-issued ticket when legacy unauthenticated self-creation is disabled", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(500).end();
    });
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "authenticated-mode-bridge",
    });
    bridges.push(bridge);

    const missing = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "authenticated-mode-bridge" }),
    });
    const malformed = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "authenticated-mode-bridge",
        pairing: { nonce: "fspair_short", connectionId: `connection_${"a".repeat(32)}` },
      }),
    });

    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "PAIRING_TICKET_REQUIRED" });
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ error: "INVALID_PAIRING_TICKET" });
    expect(upstreamRequests).toBe(0);
  });

  it("pairs the exact issued connection, verifies its grant, and never self-creates in authenticated mode", async () => {
    const nonce = `fspair_${"n".repeat(43)}`;
    const connectionId = `connection_${"a".repeat(32)}`;
    const scopes = ["design:read", "design:preview", "task:read"];
    const projectIds = ["document_alpha"];
    const apiPosts: string[] = [];
    let pairBody: unknown;
    let verifiedAuthorization: string | undefined;
    const upstream = await startUpstream((request, response) => {
      if (request.method === "POST" && request.url?.startsWith("/api/")) apiPosts.push(request.url);
      if (request.url === "/api/agent-connections/pair" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          pairBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            connection: { id: connectionId, status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
            grant: {
              token: "fsg_browser-issued-secret",
              scopes,
              projectIds,
            },
          }));
        });
        return;
      }
      if (request.url === "/api/agent-authorization-context" && request.method === "GET") {
        verifiedAuthorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ role: "agent", scopes: [...scopes].reverse(), projectIds }));
        return;
      }
      if (request.url === "/mcp" && request.method === "POST") {
        verifiedAuthorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"jsonrpc":"2.0","result":{}}');
        return;
      }
      response.writeHead(404).end();
    });
    const credentialStore = new MemoryCredentialStore();
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "ticket-pairing-bridge",
      credentialStore,
    });
    bridges.push(bridge);

    const authorization = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "ticket-pairing-bridge",
        pairing: { nonce, connectionId },
      }),
    });

    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toEqual({
      connectionId,
      status: "active",
      expiresAt: "2099-01-01T00:00:00.000Z",
      credentialStored: true,
      verified: true,
    });
    expect(pairBody).toEqual({ nonce });
    expect(apiPosts).toEqual(["/api/agent-connections/pair"]);
    expect(verifiedAuthorization).toBe("Bearer fsg_browser-issued-secret");
    expect(await credentialStore.read()).toBe("fsg_browser-issued-secret");

    const reused = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "ticket-pairing-bridge" }),
    });
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({
      status: "active",
      reused: true,
      verified: true,
      credentialStored: true,
    });
    expect(apiPosts).toEqual(["/api/agent-connections/pair"]);
  });

  it("rejects hostile Host, browser-origin, fetch-metadata, and no-cors content types before proxying", async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end('{}');
    });
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.write("fsg_boundary-secret");
    const bridge = await startBridgeServer({ port: 0, upstreamMcpUrl: upstream.url, credentialStore });
    bridges.push(bridge);
    const body = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';

    const evilOrigin = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body,
    });
    const crossSite = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body,
    });
    const noCors = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    const badHost = await postWithHost(`${bridge.url}/mcp`, "evil.example", body);

    expect(evilOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(noCors.status).toBe(415);
    expect(badHost).toBe(403);
    expect(upstreamRequests).toBe(0);

    const accepted = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(upstreamRequests).toBe(1);
  });

  it("pairs once, reuses the stored grant after bridge restart, and injects only that credential upstream", async () => {
    let observedMcpAuthorization: string | undefined;
    let observedConnectionRequest: Record<string, unknown> | undefined;
    let connectionsCreated = 0;
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/api/organization/policy" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          organizationPolicy: {
            policy: {
              agents: {
                enabled: true,
                allowedAdapters: ["codex", "generic_mcp"],
                allowedScopes: [
                  "organization_policy:read",
                  "design:read", "design:preview", "design:write",
                  "product_spec:read", "product_spec:preview", "product_spec:write",
                  "planning:read", "planning:write",
                  "task:read", "task:create", "task:claim", "task:update",
                  "design_system:read", "workspace:inventory:read",
                  "implementation_mapping:read", "implementation_mapping:write", "handoff:read",
                  "redesign:read", "redesign:assessment", "redesign:review",
                  "redesign:interview", "redesign:proposal", "redesign:design", "redesign:handoff",
                  "redesign:approve", "redesign:implement", "redesign:cancel",
                ],
                maximumExpirySeconds: 2_592_000,
                requireProjectRestriction: false,
              },
            },
          },
        }));
        return;
      }
      if (request.url === "/api/agent-connections" && request.method === "POST") {
        connectionsCreated += 1;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          observedConnectionRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          setTimeout(() => {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ connection: { id: "connection_test" }, nonce: "fspair_one_time" }));
          }, 20);
        });
        return;
      }
      if (request.url === "/api/agent-connections/pair" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          connection: { id: "connection_test", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
          grant: { token: "fsg_stored-secret" },
        }));
        return;
      }
      if (request.url === "/api/agent-authorization-context" && request.method === "GET") {
        const scopes = observedConnectionRequest?.scopes;
        if (!Array.isArray(scopes)) {
          response.writeHead(500).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          role: "agent",
          scopes: [...scopes].reverse(),
          projectIds: [],
        }));
        return;
      }
      if (request.url === "/mcp") {
        observedMcpAuthorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"jsonrpc":"2.0","result":{}}');
        return;
      }
      response.writeHead(404).end();
    });
    const credentialStore = new MemoryCredentialStore();
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "owned-bridge-instance",
      credentialStore,
      allowLegacySelfCreate: true,
    });
    bridges.push(bridge);

    const rejected = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "wrong" }),
    });
    expect(rejected.status).toBe(403);

    const authorizationResponses = await Promise.all([1, 2].map(() => fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "owned-bridge-instance" }),
    })));
    const authorizationBodies = await Promise.all(authorizationResponses.map(
      (response) => response.json() as Promise<Record<string, unknown>>,
    ));
    expect(authorizationResponses.map((response) => response.status)).toEqual([200, 200]);
    expect(authorizationBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionId: "connection_test", status: "active", credentialStored: true }),
      expect.objectContaining({ status: "active", reused: true, credentialStored: true }),
    ]));
    expect(JSON.stringify(authorizationBodies)).not.toContain("fsg_stored-secret");
    expect(await credentialStore.read()).toBe("fsg_stored-secret");
    expect(observedConnectionRequest).toMatchObject({
      adapter: "codex",
      displayName: "Codex through the local FormaSpec bridge",
      replaceExisting: true,
    });
    const automaticScopes = observedConnectionRequest?.scopes as string[];
    expect(automaticScopes).toContain("implementation_mapping:read");
    expect(automaticScopes).toContain("implementation_mapping:write");
    expect(automaticScopes).toContain("redesign:handoff");
    expect(automaticScopes).not.toContain("redesign:approve");
    expect(automaticScopes).not.toContain("redesign:implement");
    expect(automaticScopes).not.toContain("redesign:cancel");
    expect(connectionsCreated).toBe(1);

    await bridge.close();
    const restarted = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "restarted-owned-bridge",
      credentialStore,
      allowLegacySelfCreate: true,
    });
    bridges.push(restarted);
    const reused = await fetch(`${restarted.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "restarted-owned-bridge" }),
    });
    expect(await reused.json()).toMatchObject({ status: "active", reused: true, credentialStored: true });
    expect(connectionsCreated).toBe(1);

    await fetch(`${restarted.url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer caller-secret", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    expect(observedMcpAuthorization).toBe("Bearer fsg_stored-secret");
  });

  it("derives automatic Codex scopes, expiry, and required project restrictions from organization policy", async () => {
    let observedConnectionRequest: Record<string, unknown> | undefined;
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/api/organization/policy" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          organizationPolicy: {
            policy: {
              agents: {
                enabled: true,
                allowedAdapters: ["codex"],
                allowedScopes: ["organization_policy:read", "design:read", "task:read", "context:write"],
                maximumExpirySeconds: 1_200,
                requireProjectRestriction: true,
              },
            },
          },
        }));
        return;
      }
      if (request.url === "/api/designs?limit=100" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          designs: [
            { id: "document_alpha" },
            { id: "document_beta" },
            { id: "document_alpha" },
          ],
          nextCursor: null,
        }));
        return;
      }
      if (request.url === "/api/agent-connections" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          observedConnectionRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ connection: { id: "connection_restricted" }, nonce: "fspair_restricted" }));
        });
        return;
      }
      if (request.url === "/api/agent-connections/pair" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          connection: { id: "connection_restricted", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
          grant: { token: "fsg_restricted-secret" },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const credentialStore = new MemoryCredentialStore();
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "policy-restricted-bridge",
      credentialStore,
      allowLegacySelfCreate: true,
    });
    bridges.push(bridge);

    const authorization = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "policy-restricted-bridge" }),
    });

    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      connectionId: "connection_restricted",
      status: "active",
      credentialStored: true,
    });
    expect(observedConnectionRequest).toEqual({
      adapter: "codex",
      displayName: "Codex through the local FormaSpec bridge",
      scopes: ["organization_policy:read", "context:write", "design:read", "task:read"],
      projectIds: ["document_alpha", "document_beta"],
      expiresInSeconds: 1_200,
      replaceExisting: true,
    });
    expect(await credentialStore.read()).toBe("fsg_restricted-secret");
  });

  it.each([
    {
      name: "reuses exact reordered scope and project sets",
      contextStatus: 200,
      context: {
        role: "agent",
        scopes: ["task:read", "design:preview", "design:read", "organization_policy:read"],
        projectIds: ["document_beta", "document_alpha"],
      },
      rotated: false,
    },
    {
      name: "rotates a grant missing a currently required scope",
      contextStatus: 200,
      context: {
        role: "agent",
        scopes: ["organization_policy:read", "design:read", "task:read"],
        projectIds: ["document_alpha", "document_beta"],
      },
      rotated: true,
    },
    {
      name: "rotates an overbroad grant after the managed scope set narrows",
      contextStatus: 200,
      context: {
        role: "agent",
        scopes: ["organization_policy:read", "design:read", "design:preview", "task:read", "redesign:approve"],
        projectIds: ["document_alpha", "document_beta"],
      },
      rotated: true,
    },
    {
      name: "rotates a grant with a stale project restriction set",
      contextStatus: 200,
      context: {
        role: "agent",
        scopes: ["organization_policy:read", "design:read", "design:preview", "task:read"],
        projectIds: ["document_alpha"],
      },
      rotated: true,
    },
    {
      name: "rotates when authorization context is malformed",
      contextStatus: 200,
      context: {
        role: "agent",
        scopes: "design:read",
        projectIds: ["document_alpha", "document_beta"],
      },
      rotated: true,
    },
    {
      name: "rotates when authorization context is unavailable",
      contextStatus: 503,
      context: { error: "temporarily unavailable" },
      rotated: true,
    },
  ])("$name", async ({ contextStatus, context, rotated }) => {
    const requiredScopes = ["organization_policy:read", "design:read", "design:preview", "task:read"];
    const requiredProjectIds = ["document_alpha", "document_beta"];
    let connectionsCreated = 0;
    let observedConnectionRequest: Record<string, unknown> | undefined;
    let observedContextAuthorization: string | undefined;
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/api/organization/policy" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          organizationPolicy: {
            policy: {
              agents: {
                enabled: true,
                allowedAdapters: ["codex"],
                allowedScopes: [...requiredScopes, "redesign:approve"],
                maximumExpirySeconds: 3_600,
                requireProjectRestriction: true,
              },
            },
          },
        }));
        return;
      }
      if (request.url === "/api/designs?limit=100" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          designs: requiredProjectIds.map((id) => ({ id })),
          nextCursor: null,
        }));
        return;
      }
      if (request.url === "/mcp" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"jsonrpc":"2.0","result":{}}');
        return;
      }
      if (request.url === "/api/agent-authorization-context" && request.method === "GET") {
        observedContextAuthorization = request.headers.authorization;
        response.writeHead(contextStatus, { "content-type": "application/json" });
        response.end(JSON.stringify(context));
        return;
      }
      if (request.url === "/api/agent-connections" && request.method === "POST") {
        connectionsCreated += 1;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          observedConnectionRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ connection: { id: "connection_rotated" }, nonce: "fspair_rotated" }));
        });
        return;
      }
      if (request.url === "/api/agent-connections/pair" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          connection: { id: "connection_rotated", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
          grant: { token: "fsg_rotated-secret" },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.write("fsg_existing-secret");
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "scope-upgrade-bridge",
      credentialStore,
      allowLegacySelfCreate: true,
    });
    bridges.push(bridge);

    const authorization = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "scope-upgrade-bridge" }),
    });

    expect(authorization.status).toBe(200);
    expect(observedContextAuthorization).toBe("Bearer fsg_existing-secret");
    if (!rotated) {
      expect(await authorization.json()).toMatchObject({ reused: true, credentialStored: true });
      expect(connectionsCreated).toBe(0);
      expect(observedConnectionRequest).toBeUndefined();
      expect(await credentialStore.read()).toBe("fsg_existing-secret");
      return;
    }
    expect(await authorization.json()).toMatchObject({
      connectionId: "connection_rotated",
      status: "active",
      credentialStored: true,
    });
    expect(connectionsCreated).toBe(1);
    expect(observedConnectionRequest).toEqual({
      adapter: "codex",
      displayName: "Codex through the local FormaSpec bridge",
      scopes: requiredScopes,
      projectIds: requiredProjectIds,
      expiresInSeconds: 3_600,
      replaceExisting: true,
    });
    expect(await credentialStore.read()).toBe("fsg_rotated-secret");
  });

  it.each([
    {
      name: "agents are disabled",
      agents: {
        enabled: false,
        allowedAdapters: ["codex"],
        allowedScopes: ["organization_policy:read"],
        maximumExpirySeconds: 3_600,
        requireProjectRestriction: false,
      },
    },
    {
      name: "the Codex adapter is not allowed",
      agents: {
        enabled: true,
        allowedAdapters: ["generic_mcp"],
        allowedScopes: ["organization_policy:read"],
        maximumExpirySeconds: 3_600,
        requireProjectRestriction: false,
      },
    },
  ])("refuses automatic connection before pairing when $name", async ({ agents }) => {
    let pairingRequests = 0;
    let mcpRequests = 0;
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/api/organization/policy" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ organizationPolicy: { policy: { agents } } }));
        return;
      }
      if (request.url === "/api/agent-connections") pairingRequests += 1;
      if (request.url === "/mcp") mcpRequests += 1;
      response.writeHead(404).end();
    });
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.write("fsg_existing-policy-denied-secret");
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "policy-denied-bridge",
      credentialStore,
      allowLegacySelfCreate: true,
    });
    bridges.push(bridge);

    const authorization = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "policy-denied-bridge" }),
    });

    expect(authorization.status).toBe(502);
    expect(await authorization.json()).toEqual({ error: "BRIDGE_REQUEST_FAILED" });
    expect(pairingRequests).toBe(0);
    expect(mcpRequests).toBe(0);
  });

  it("refuses a required project-restricted connection when no project exists", async () => {
    let pairingRequests = 0;
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/api/organization/policy" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          organizationPolicy: {
            policy: {
              agents: {
                enabled: true,
                allowedAdapters: ["codex"],
                allowedScopes: ["organization_policy:read", "design:read"],
                maximumExpirySeconds: 3_600,
                requireProjectRestriction: true,
              },
            },
          },
        }));
        return;
      }
      if (request.url === "/api/designs?limit=100" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ designs: [], nextCursor: null }));
        return;
      }
      if (request.url === "/api/agent-connections") pairingRequests += 1;
      response.writeHead(404).end();
    });
    const bridge = await startBridgeServer({
      port: 0,
      upstreamMcpUrl: upstream.url,
      instanceId: "project-restricted-bridge",
      allowLegacySelfCreate: true,
    });
    bridges.push(bridge);

    const authorization = await fetch(`${bridge.url}/_control/authorize-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "project-restricted-bridge" }),
    });

    expect(authorization.status).toBe(502);
    expect(pairingRequests).toBe(0);
  });

  it("rejects remote, credential-bearing, and non-MCP upstream URLs", () => {
    expect(() => validateLoopbackMcpUrl("https://example.com/mcp")).toThrow(/loopback/);
    expect(() => validateLoopbackMcpUrl("http://user:pass@127.0.0.1:4310/mcp")).toThrow(/credentials/);
    expect(() => validateLoopbackMcpUrl("http://127.0.0.1:4310/anything")).toThrow(/\/mcp/);
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBridgeController, type BridgeController } from "./bridge-lifecycle.js";

const temporaryDirectories: string[] = [];
const controllers: BridgeController[] = [];
const testServers: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(controllers.splice(0).map((controller) => controller.stop()));
  await Promise.allSettled(testServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startRuntimeIdentityServer(
  dataStoreId = `store_${"a".repeat(32)}`,
): Promise<number> {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, dataStoreId }));
      return;
    }
    response.writeHead(404).end();
  });
  testServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No runtime identity port.");
  return address.port;
}

describe("local bridge lifecycle", () => {
  it("starts, owns, reports, and safely stops its loopback process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-bridge-lifecycle-"));
    temporaryDirectories.push(root);
    const runtimeDirectory = path.join(root, "packaged-user-state");
    fs.mkdirSync(path.join(runtimeDirectory, "run"), { recursive: true });
    const apiPort = await startRuntimeIdentityServer();
    fs.writeFileSync(path.join(runtimeDirectory, "run", "api-port"), `${apiPort}\n`);
    const port = await availablePort();
    const controller = createBridgeController(root, {
      ...process.env,
      FORMASPEC_BRIDGE_PORT: String(port),
      FORMASPEC_RUNTIME_DIR: runtimeDirectory,
    });
    controllers.push(controller);

    const started = await controller.ensureStarted();
    expect(started).toEqual({
      running: true,
      url: `http://127.0.0.1:${port}`,
      owned: true,
      upstreamOrigin: `http://127.0.0.1:${apiPort}`,
      upstreamReady: true,
      dataStoreId: `store_${"a".repeat(32)}`,
    });
    expect(await controller.status()).toMatchObject({
      running: true,
      owned: true,
      upstreamOrigin: `http://127.0.0.1:${apiPort}`,
      upstreamReady: true,
      dataStoreId: `store_${"a".repeat(32)}`,
    });
    expect(await fetch(`${started.url}/health`).then((response) => response.json())).toMatchObject({
      service: "formaspec-local-bridge",
      status: "ok",
      buildId: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedDataStoreId: `store_${"a".repeat(32)}`,
      identityMatches: true,
    });
    expect(await controller.stop()).toBe(true);
    expect(await controller.status()).toMatchObject({ running: false, owned: false });
    expect(fs.existsSync(path.join(root, ".designer"))).toBe(false);
  }, 15_000);

  it("rejects a relative packaged runtime-state override", () => {
    expect(() => createBridgeController("/tmp/formaspec", {
      ...process.env,
      FORMASPEC_RUNTIME_DIR: "relative/state",
    })).toThrow(/absolute path/);
  });

  it("restarts an owned bridge when its running build fingerprint is stale", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-bridge-upgrade-"));
    temporaryDirectories.push(root);
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    const apiPort = await startRuntimeIdentityServer();
    fs.writeFileSync(path.join(runDirectory, "api-port"), `${apiPort}\n`);
    const port = await availablePort();
    const instanceId = "stale-owned-bridge-instance";
    let shutdownAccepted = false;
    const staleServer = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          service: "formaspec-local-bridge",
          status: "ok",
          buildId: "stale-build",
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/_control/shutdown") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { instanceId?: unknown };
          if (body.instanceId !== instanceId) {
            response.writeHead(403).end();
            return;
          }
          shutdownAccepted = true;
          response.writeHead(202, { "content-type": "application/json" });
          response.end('{"stopping":true}');
          setImmediate(() => staleServer.close());
        });
        return;
      }
      response.writeHead(404).end();
    });
    testServers.push(staleServer);
    await new Promise<void>((resolve) => staleServer.listen(port, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(runDirectory, "formaspec-bridge.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      instanceId,
    })}\n`, { mode: 0o600 });

    const controller = createBridgeController(root, { ...process.env, FORMASPEC_BRIDGE_PORT: String(port) });
    controllers.push(controller);
    const started = await controller.ensureStarted();
    const health = await fetch(`${started.url}/health`).then((response) => response.json()) as { buildId?: unknown };

    expect(shutdownAccepted).toBe(true);
    expect(started).toMatchObject({ running: true, owned: true });
    expect(health.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(health.buildId).not.toBe("stale-build");
  }, 15_000);

  it("restarts an owned bridge when the recorded upstream API port changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-bridge-upstream-"));
    temporaryDirectories.push(root);
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    const apiPortFile = path.join(runDirectory, "api-port");
    const firstApiPort = await startRuntimeIdentityServer(`store_${"a".repeat(32)}`);
    const secondApiPort = await startRuntimeIdentityServer(`store_${"b".repeat(32)}`);
    fs.writeFileSync(apiPortFile, `${firstApiPort}\n`);
    const port = await availablePort();
    const controller = createBridgeController(root, { ...process.env, FORMASPEC_BRIDGE_PORT: String(port) });
    controllers.push(controller);

    await controller.ensureStarted();
    const statePath = path.join(runDirectory, "formaspec-bridge.json");
    const firstState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      instanceId: string;
      upstreamMcpUrl: string;
      expectedDataStoreId: string;
    };
    expect(firstState.upstreamMcpUrl).toBe(`http://127.0.0.1:${firstApiPort}/mcp`);
    expect(firstState.expectedDataStoreId).toBe(`store_${"a".repeat(32)}`);

    fs.writeFileSync(apiPortFile, `${secondApiPort}\n`);
    await controller.ensureStarted();
    const secondState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      instanceId: string;
      upstreamMcpUrl: string;
      expectedDataStoreId: string;
    };
    expect(secondState.instanceId).not.toBe(firstState.instanceId);
    expect(secondState.upstreamMcpUrl).toBe(`http://127.0.0.1:${secondApiPort}/mcp`);
    expect(secondState.expectedDataStoreId).toBe(`store_${"b".repeat(32)}`);
  }, 15_000);

  it("refuses to report a bridge ready while the upstream identity is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-bridge-not-ready-"));
    temporaryDirectories.push(root);
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health/ready") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, dataStoreId: `store_${"a".repeat(32)}` }));
        return;
      }
      response.writeHead(404).end();
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No runtime identity port.");
    fs.writeFileSync(path.join(runDirectory, "api-port"), `${address.port}\n`);
    const bridgePort = await availablePort();
    const controller = createBridgeController(root, { ...process.env, FORMASPEC_BRIDGE_PORT: String(bridgePort) });
    controllers.push(controller);

    await expect(controller.ensureStarted()).rejects.toThrow(/not ready.*data-store identity/i);
    expect(fs.existsSync(path.join(runDirectory, "formaspec-bridge.json"))).toBe(false);
  });

  it("does not adopt or stop a replacement bridge that fails the recorded instance challenge", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-bridge-instance-"));
    temporaryDirectories.push(root);
    const runDirectory = path.join(root, ".designer", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    const apiPort = await startRuntimeIdentityServer();
    fs.writeFileSync(path.join(runDirectory, "api-port"), `${apiPort}\n`);
    const bridgePort = await availablePort();
    let shutdownRequests = 0;
    const replacement = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          service: "formaspec-local-bridge",
          status: "ok",
          buildId: "replacement",
          upstreamOrigin: `http://127.0.0.1:${apiPort}`,
          upstreamReady: true,
          dataStoreId: `store_${"a".repeat(32)}`,
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/_control/shutdown") shutdownRequests += 1;
      response.writeHead(403, { "content-type": "application/json" }).end('{"error":"CONTROL_AUTHORIZATION_FAILED"}');
    });
    testServers.push(replacement);
    await new Promise<void>((resolve) => replacement.listen(bridgePort, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(runDirectory, "formaspec-bridge.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      url: `http://127.0.0.1:${bridgePort}`,
      instanceId: "recorded-instance-does-not-match",
      upstreamMcpUrl: `http://127.0.0.1:${apiPort}/mcp`,
      expectedDataStoreId: `store_${"a".repeat(32)}`,
    })}\n`, { mode: 0o600 });
    const controller = createBridgeController(root, { ...process.env, FORMASPEC_BRIDGE_PORT: String(bridgePort) });
    controllers.push(controller);

    expect(await controller.status()).toMatchObject({ running: true, owned: false });
    await expect(controller.ensureStarted()).rejects.toThrow(/rejected the shutdown request/i);
    expect(shutdownRequests).toBe(1);
  });
});

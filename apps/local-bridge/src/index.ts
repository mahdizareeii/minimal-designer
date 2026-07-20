#!/usr/bin/env node
import { startBridgeServer, validateLoopbackMcpUrl } from "./server.js";
import { createSystemCredentialStore } from "./credentials.js";

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("Bridge port is invalid.");
  return parsed;
}

const host = process.env.FORMASPEC_BRIDGE_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1") throw new Error("The local bridge must bind to loopback.");
const port = parsePort(process.env.FORMASPEC_BRIDGE_PORT, 4312);
const upstreamMcpUrl = process.env.FORMASPEC_UPSTREAM_MCP_URL ?? "http://127.0.0.1:4310/mcp";
validateLoopbackMcpUrl(upstreamMcpUrl);
const buildId = process.env.FORMASPEC_BRIDGE_BUILD_ID ?? "development";

const bridge = await startBridgeServer({
  host,
  port,
  upstreamMcpUrl,
  buildId,
  credentialStore: createSystemCredentialStore(upstreamMcpUrl),
  ...(process.env.FORMASPEC_BRIDGE_INSTANCE_ID === undefined
    ? {}
    : { instanceId: process.env.FORMASPEC_BRIDGE_INSTANCE_ID }),
});

process.stdout.write(`FormaSpec local bridge listening on ${bridge.url}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await bridge.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

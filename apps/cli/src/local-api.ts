import fs from "node:fs";
import path from "node:path";

function loopbackHttpOrigin(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(host)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("The recorded FormaSpec service URL must be a credential-free loopback HTTP URL.");
  }
  return url.origin;
}

export function localApiOrigin(projectRoot: string): string {
  const runDirectory = path.join(projectRoot, ".designer", "run");
  const urlFile = path.join(runDirectory, "url");
  if (fs.existsSync(urlFile)) return loopbackHttpOrigin(fs.readFileSync(urlFile, "utf8").trim());
  const portFile = path.join(runDirectory, "api-port");
  const rawPort = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim() : "4310";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("The recorded FormaSpec API port is invalid.");
  return `http://127.0.0.1:${port}`;
}

export async function localApiRequest<T>(projectRoot: string, pathname: string, init?: RequestInit): Promise<T> {
  if (!pathname.startsWith("/api/") || pathname.includes("..")) throw new Error("Invalid local FormaSpec API path.");
  const response = await fetch(`${localApiOrigin(projectRoot)}${pathname}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      "x-formaspec-csrf": "1",
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: unknown; code?: unknown } };
    const message = typeof body.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    const code = typeof body.error?.code === "string" ? ` (${body.error.code})` : "";
    throw new Error(`FormaSpec API request failed${code}: ${message}`);
  }
  return response.json() as Promise<T>;
}

export const FORMASPEC_MCP_SERVER_ID = "formaspec";
export const FORMASPEC_MCP_DISPLAY_NAME = "FormaSpec";
export const FORMASPEC_MCP_DISPLAY_ALIASES = ["Minimal UI"] as const;
export const DEFAULT_FORMASPEC_BRIDGE_MCP_URL = "http://127.0.0.1:4312/mcp";

export type GenericMcpConfigurationFormat = "all" | "json" | "toml";

export interface GenericMcpConfiguration {
  serverId: typeof FORMASPEC_MCP_SERVER_ID;
  displayName: typeof FORMASPEC_MCP_DISPLAY_NAME;
  displayAliases: typeof FORMASPEC_MCP_DISPLAY_ALIASES;
  transport: "streamable_http";
  url: string;
  healthUrl: string;
  jsonSnippet: string;
  tomlSnippet: string;
  verificationInstructions: readonly string[];
}

export interface GenericMcpConfigIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  format: GenericMcpConfigurationFormat;
  snippetOnly: boolean;
  url: string;
}

const defaultIo: GenericMcpConfigIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function usage(): string {
  return `FormaSpec generic MCP configuration generator

Usage:
  formaspec-mcp-config [--format all|json|toml] [--url LOOPBACK_MCP_URL]
                       [--snippet-only]

This command prints client-neutral Streamable HTTP snippets and verification
instructions. It never reads or changes an MCP client's configuration files.
The endpoint must be a credential-free HTTP loopback URL whose path is /mcp.`;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function normalizeGenericMcpUrl(value: string): string {
  if (value.trim() !== value || value.length === 0) {
    throw new Error("MCP URL must be a non-empty URL without surrounding whitespace.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP URL must be a valid credential-free HTTP loopback URL.");
  }
  if (url.protocol !== "http:" || !loopbackHostname(url.hostname)) {
    throw new Error("MCP URL must use HTTP on 127.0.0.1, localhost, or ::1.");
  }
  if (url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL must use the exact /mcp path and contain no credentials, query, or fragment.");
  }
  return url.toString();
}

export function createGenericMcpConfiguration(
  mcpUrl = DEFAULT_FORMASPEC_BRIDGE_MCP_URL,
): GenericMcpConfiguration {
  const url = normalizeGenericMcpUrl(mcpUrl);
  const origin = new URL(url).origin;
  const jsonSnippet = JSON.stringify({
    mcpServers: {
      [FORMASPEC_MCP_SERVER_ID]: {
        type: "streamable_http",
        url,
      },
    },
  }, null, 2);
  const tomlSnippet = `[mcp_servers.${FORMASPEC_MCP_SERVER_ID}]
type = "streamable_http"
url = ${JSON.stringify(url)}`;
  return {
    serverId: FORMASPEC_MCP_SERVER_ID,
    displayName: FORMASPEC_MCP_DISPLAY_NAME,
    displayAliases: FORMASPEC_MCP_DISPLAY_ALIASES,
    transport: "streamable_http",
    url,
    healthUrl: `${origin}/health`,
    jsonSnippet,
    tomlSnippet,
    verificationInstructions: [
      `Check that the authorized local bridge is healthy: curl --fail --silent --show-error ${origin}/health`,
      "Copy the appropriate snippet into the client's documented MCP settings manually. FormaSpec does not edit unsupported client files.",
      "If the client uses different field names, map only the server ID, Streamable HTTP transport, and URL; do not invent authentication fields.",
      `Run the client's MCP connection test and confirm server '${FORMASPEC_MCP_SERVER_ID}' is available as ${FORMASPEC_MCP_DISPLAY_NAME}.`,
      "Confirm both natural-language identities are recognized: 'Use FormaSpec' and 'Use Minimal UI'.",
      "List MCP resources and confirm formaspec://schema/v1 and formaspec://schema/v2 are readable.",
      "Keep write-tool approval enabled. Do not add a bearer token or Authorization header; the loopback bridge holds the scoped upstream grant.",
    ],
  };
}

function parseArguments(rawArguments: readonly string[]): ParsedArguments | "help" {
  let format: GenericMcpConfigurationFormat = "all";
  let snippetOnly = false;
  let url = DEFAULT_FORMASPEC_BRIDGE_MCP_URL;
  let formatSeen = false;
  let urlSeen = false;
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--snippet-only") {
      if (snippetOnly) throw new Error("--snippet-only may be supplied only once.");
      snippetOnly = true;
      continue;
    }
    if (argument === "--format") {
      if (formatSeen) throw new Error("--format may be supplied only once.");
      const value = rawArguments[index + 1];
      if (value !== "all" && value !== "json" && value !== "toml") {
        throw new Error("--format requires all, json, or toml.");
      }
      format = value;
      formatSeen = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      if (formatSeen) throw new Error("--format may be supplied only once.");
      const value = argument.slice("--format=".length);
      if (value !== "all" && value !== "json" && value !== "toml") {
        throw new Error("--format requires all, json, or toml.");
      }
      format = value;
      formatSeen = true;
      continue;
    }
    if (argument === "--url") {
      if (urlSeen) throw new Error("--url may be supplied only once.");
      const value = rawArguments[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--url requires a loopback MCP URL.");
      url = value;
      urlSeen = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--url=")) {
      if (urlSeen) throw new Error("--url may be supplied only once.");
      url = argument.slice("--url=".length);
      urlSeen = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { format, snippetOnly, url };
}

function selectedSnippets(configuration: GenericMcpConfiguration, format: GenericMcpConfigurationFormat): string[] {
  if (format === "json") return [configuration.jsonSnippet];
  if (format === "toml") return [configuration.tomlSnippet];
  return [
    `Common JSON\n\n${configuration.jsonSnippet}`,
    `Common TOML\n\n${configuration.tomlSnippet}`,
  ];
}

export function runGenericMcpConfigCli(
  rawArguments: readonly string[],
  io: GenericMcpConfigIo = defaultIo,
): number {
  try {
    const parsed = parseArguments(rawArguments);
    if (parsed === "help") {
      io.stdout(usage());
      return 0;
    }
    const configuration = createGenericMcpConfiguration(parsed.url);
    const snippets = selectedSnippets(configuration, parsed.format);
    if (parsed.snippetOnly) {
      io.stdout(snippets.join("\n\n"));
      return 0;
    }
    io.stdout(`FormaSpec (${configuration.displayName}) generic MCP configuration`);
    io.stdout("This output is advisory and print-only; no client configuration file was read or changed.");
    io.stdout(`Server ID: ${configuration.serverId}`);
    io.stdout(`Agent identities: ${[configuration.displayName, ...configuration.displayAliases].join(", ")}`);
    io.stdout(`Transport: Streamable HTTP (${configuration.transport})`);
    io.stdout(`Endpoint: ${configuration.url}`);
    io.stdout("");
    io.stdout(snippets.join("\n\n"));
    io.stdout("");
    io.stdout("Verification");
    configuration.verificationInstructions.forEach((instruction, index) => io.stdout(`${index + 1}. ${instruction}`));
    return 0;
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

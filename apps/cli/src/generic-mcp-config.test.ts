import { describe, expect, it } from "vitest";

import {
  createGenericMcpConfiguration,
  normalizeGenericMcpUrl,
  runGenericMcpConfigCli,
  type GenericMcpConfigIo,
} from "./generic-mcp-config.js";

function collectingIo(): GenericMcpConfigIo & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  };
}

describe("generic MCP client configuration", () => {
  it("emits token-free common JSON and TOML for the loopback Streamable HTTP bridge", () => {
    const configuration = createGenericMcpConfiguration();
    expect(configuration).toMatchObject({
      serverId: "formaspec",
      displayName: "FormaSpec",
      displayAliases: ["Minimal UI"],
      transport: "streamable_http",
      connectionMode: "loopback_bridge",
      url: "http://127.0.0.1:4312/mcp",
      healthUrl: "http://127.0.0.1:4312/health",
    });
    expect(JSON.parse(configuration.jsonSnippet)).toEqual({
      mcpServers: {
        formaspec: {
          type: "streamable_http",
          url: "http://127.0.0.1:4312/mcp",
        },
      },
    });
    expect(configuration.tomlSnippet).toBe(`[mcp_servers.formaspec]
type = "streamable_http"
url = "http://127.0.0.1:4312/mcp"`);
    for (const snippet of [configuration.jsonSnippet, configuration.tomlSnippet]) {
      expect(snippet.toLowerCase()).not.toMatch(/authorization|bearer|token|header|secret|password/);
    }
    expect(configuration.verificationInstructions.join("\n")).toContain("formaspec://schema/v2");
    expect(configuration.verificationInstructions.join("\n")).toContain("does not edit unsupported client files");
    expect(configuration.verificationInstructions.join("\n")).toContain("primary natural-language identity");
    expect(configuration.verificationInstructions.join("\n")).toContain("Use FormaSpec");
    expect(configuration.verificationInstructions.join("\n")).toContain("compatibility-only");
  });

  it("accepts credential-free exact /mcp URLs on loopback HTTP or public HTTPS", () => {
    expect(normalizeGenericMcpUrl("http://localhost:7654/mcp")).toBe("http://localhost:7654/mcp");
    expect(normalizeGenericMcpUrl("http://[::1]:7654/mcp")).toBe("http://[::1]:7654/mcp");
    expect(normalizeGenericMcpUrl("https://design.company.example/mcp")).toBe("https://design.company.example/mcp");
    expect(createGenericMcpConfiguration("https://design.company.example/mcp")).toMatchObject({
      connectionMode: "public_server",
      healthUrl: "https://design.company.example/health/live",
    });
    expect(createGenericMcpConfiguration("https://design.company.example/mcp").verificationInstructions.join("\n"))
      .toContain("Agent Connections");
    const unsafe = [
      "https://127.0.0.1:4312/mcp",
      "http://192.168.1.5:4312/mcp",
      "http://localhost.example:4312/mcp",
      "http://user:secret@127.0.0.1:4312/mcp",
      "http://127.0.0.1:4312/mcp?token=secret",
      "http://127.0.0.1:4312/mcp#fragment",
      "http://127.0.0.1:4312/mcp/",
      " http://127.0.0.1:4312/mcp",
    ];
    for (const value of unsafe) expect(() => normalizeGenericMcpUrl(value)).toThrow();
  });

  it("prints either neutral format without accessing a client configuration file", () => {
    const jsonIo = collectingIo();
    expect(runGenericMcpConfigCli(["--format", "json", "--snippet-only"], jsonIo)).toBe(0);
    expect(jsonIo.errors).toEqual([]);
    expect(jsonIo.output).toHaveLength(1);
    expect(JSON.parse(jsonIo.output[0]!)).toMatchObject({
      mcpServers: { formaspec: { type: "streamable_http" } },
    });

    const tomlIo = collectingIo();
    expect(runGenericMcpConfigCli([
      "--format=toml",
      "--url=http://localhost:54321/mcp",
      "--snippet-only",
    ], tomlIo)).toBe(0);
    expect(tomlIo.errors).toEqual([]);
    expect(tomlIo.output).toEqual([
      `[mcp_servers.formaspec]
type = "streamable_http"
url = "http://localhost:54321/mcp"`,
    ]);
  });

  it("includes manual verification guidance by default and rejects unknown options", () => {
    const io = collectingIo();
    expect(runGenericMcpConfigCli([], io)).toBe(0);
    const output = io.output.join("\n");
    expect(output).toContain("print-only; no client configuration file was read or changed");
    expect(output).toContain("curl --fail --silent --show-error http://127.0.0.1:4312/health");
    expect(output).toContain("Keep write-tool approval enabled");
    expect(output).toContain("Primary agent identity: FormaSpec");
    expect(output).toContain("Compatibility aliases: Minimal UI");

    const invalidIo = collectingIo();
    expect(runGenericMcpConfigCli(["--output", "/tmp/client.json"], invalidIo)).toBe(1);
    expect(invalidIo.output).toEqual([]);
    expect(invalidIo.errors).toEqual(["Error: Unknown option: --output"]);
  });
});

#!/usr/bin/env node
import { runGenericMcpConfigCli } from "./generic-mcp-config.js";

process.exitCode = runGenericMcpConfigCli(process.argv.slice(2));

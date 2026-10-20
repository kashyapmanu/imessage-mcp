#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// stdout carries the MCP protocol. Anything diagnostic must go to stderr.
const server = new McpServer({
  name: "imessage-mcp",
  version: "0.1.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[imessage-mcp] ready on stdio (read-only)");

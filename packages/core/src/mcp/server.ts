#!/usr/bin/env node
/**
 * helium-mcp — stdio MCP server exposing buildTools() to a `claude -p`
 * senior-lane child (spec §4). Tool set selection (env-filtered by
 * HELIUM_TOOLS and HELIUM_ALLOW_MUTATIONS) lives in ./selection.js, kept
 * separate so it is unit-testable without importing this module's own
 * top-level side effect below (a real StdioServerTransport connection).
 *
 * SDK shape verified live against the installed @modelcontextprotocol/sdk
 * 1.30.0 types (task-1.7-report.md Spike B): McpServer + StdioServerTransport,
 * server.registerTool(name, { description, inputSchema }, cb) where
 * inputSchema is a zod raw shape (ZodRawShape).
 * @module @helium/core/mcp/server
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selected } from "./selection.js";

const server = new McpServer({ name: "helium", version: "0.2.0" });
for (const tool of selected()) {
  const shape =
    tool.paramsSchema instanceof z.ZodObject
      ? (tool.paramsSchema.shape as z.ZodRawShape)
      : ({} as z.ZodRawShape);
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: shape },
    async (args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: await tool.run(args) }],
    }),
  );
}
await server.connect(new StdioServerTransport());

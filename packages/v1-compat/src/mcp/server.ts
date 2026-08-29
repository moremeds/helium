#!/usr/bin/env node
/**
 * helium-mcp — stdio MCP server exposing the v1 toolkit to the senior-lane
 * child process (spec §4). Tool set selection (env-filtered by HELIUM_TOOLS
 * and HELIUM_ALLOW_MUTATIONS) is core's `selected()`, kept separate so it is
 * unit-testable without importing this module's own top-level side effect
 * below (a real StdioServerTransport connection); the catalog it filters is
 * built here, because building it names business domains.
 *
 * SDK shape verified live against the installed @modelcontextprotocol/sdk
 * 1.30.0 types (task-1.7-report.md Spike B): McpServer + StdioServerTransport,
 * server.registerTool(name, { description, inputSchema }, cb) where
 * inputSchema is a zod raw shape (ZodRawShape).
 * @module @helium/v1-compat/mcp/server
 */
import { selected } from "@helium/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { catalogFromEnv } from "../tools/index.js";

const server = new McpServer({ name: "helium", version: "0.2.0" });
// `selected()` is called at module top level, so it is contractually
// non-throwing: a throw here would mean the server never starts and the senior
// lane loses every tool over one missing capability. Unknown names are rejected
// far earlier, at job load. A declared-but-unconfigured tool arrives as a named
// degradation instead, reported on stderr -- never stdout, which is the MCP
// protocol channel -- so the tenant's health row can say which capability is
// missing and why.
const selection = selected(catalogFromEnv());
if (selection.degraded.length > 0) {
  console.error(
    `helium-mcp: DEGRADED -- ${selection.degraded
      .map((d) => `${d.tool} (${d.reason})`)
      .join(", ")}`,
  );
}
for (const tool of selection.tools) {
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

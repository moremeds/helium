#!/usr/bin/env node
/**
 * helium-mcp — stdio MCP server exposing buildTools() to a `claude -p`
 * senior-lane child (spec §4). Tool set is filtered by env: HELIUM_TOOLS
 * (csv allow-list; empty/unset means "all") and HELIUM_ALLOW_MUTATIONS
 * ('1' admits mutating tools; otherwise they are dropped, matching the
 * dsh in-process registration's own always-read-only default).
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
import { buildTools } from "../tools/index.js";

function selected(): ReturnType<typeof buildTools> {
  const tools = buildTools({
    argonBase: process.env.HELIUM_ARGON_BASE ?? "http://127.0.0.1:8400",
    apexBase: process.env.HELIUM_APEX_BASE ?? "http://127.0.0.1:8322",
    livewireDb: process.env.HELIUM_LIVEWIRE_DB,
    stateRoot: process.env.HELIUM_STATE_ROOT ?? process.cwd(),
  });
  const allowMutations = process.env.HELIUM_ALLOW_MUTATIONS === "1";
  const names = (process.env.HELIUM_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return tools
    .filter((t) => allowMutations || !t.mutating)
    .filter((t) => names.length === 0 || names.includes(t.name));
}

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

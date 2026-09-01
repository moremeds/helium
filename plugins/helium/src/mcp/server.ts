#!/usr/bin/env node
/**
 * helium-mcp — stdio MCP server exposing the merged tenant tool catalog to the
 * team-lane child process (spec §4). Tool set selection (env-filtered by HELIUM_TOOLS
 * and HELIUM_ALLOW_MUTATIONS) is core's `selected()`, kept separate so it is
 * unit-testable without importing this module's own top-level side effect
 * below (a real StdioServerTransport connection); the catalog it filters is
 * built here, because building it names business domains.
 *
 * SDK shape verified live against the installed @modelcontextprotocol/sdk
 * 1.30.0 types (task-1.7-report.md Spike B): McpServer + StdioServerTransport,
 * server.registerTool(name, { description, inputSchema }, cb) where
 * inputSchema is a zod raw shape (ZodRawShape).
 * @module dsh-plugin-helium/mcp/server
 */
import { isAbsolute } from "node:path";
import { selected } from "@helium/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadTenants } from "../tenants.js";
import { loadTenantTools, type MergedToolCatalog } from "../tenant-tools.js";

const server = new McpServer({ name: "helium", version: "0.2.0" });
// `selected()` is called at module top level, so it is contractually
// non-throwing: a throw here would mean the server never starts and the senior
// lane loses every tool over one missing capability. Unknown names are rejected
// far earlier, at job load. A declared-but-unconfigured tool arrives as a named
// degradation instead, reported on stderr -- never stdout, which is the MCP
// protocol channel -- so the tenant's health row can say which capability is
// missing and why.
// REQUIRED and ABSOLUTE. There is no cwd-relative default: this process is
// spawned by dsh with its cwd inside an isolated workspace under
// `stateRoot/workspaces`, where a relative "plugins" resolves to nothing, and a
// silent miss serves every team agent zero tools.
const tenantsDir = process.env.HELIUM_TENANTS_DIR;
const stateRoot = process.env.HELIUM_STATE_ROOT ?? process.cwd();
// Load failures are reported on stderr and degrade the catalog; they never
// throw. This module connects a real stdio transport at top level, so a throw
// here means the agent gets NO tools instead of one missing capability -- the
// same fail-open-at-startup / fail-loud-at-load split `selected()` documents.
// The fallback is the THESIS-ONLY catalog, never an empty one: `selected()`
// filters `catalog.tools`, so an empty catalog serves nothing at all, including
// core's own `thesis_read`/`thesis_write`.
let catalog: MergedToolCatalog = await loadTenantTools([], {
  stateRoot,
  env: process.env,
});
let tenantCount = 0;
if (tenantsDir === undefined || !isAbsolute(tenantsDir)) {
  console.error(
    `helium-mcp: HELIUM_TENANTS_DIR must be set to an absolute path; got ${tenantsDir ?? "<unset>"} \u2014 serving the thesis tools only`,
  );
} else {
  try {
    const loaded = loadTenants(tenantsDir);
    tenantCount = loaded.tenants.length;
    catalog = await loadTenantTools(loaded.tenants, {
      stateRoot,
      env: process.env,
    });
    for (const skip of [...loaded.skipped, ...catalog.skipped]) {
      console.error(
        `helium-mcp: SKIPPED tenant ${skip.tenant}: ${skip.reason}`,
      );
    }
  } catch (error: unknown) {
    console.error(
      `helium-mcp: tenant tool load FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const selection = selected(catalog);
console.error(
  `helium-mcp: tenants=${tenantCount} tools=${catalog.tools.length}`,
);
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

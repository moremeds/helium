// Spike B fixture: the smallest MCP stdio server that proves a `claude -p`
// child can call a helium-owned tool. Phase 2 replaces it with helium-mcp.
//
// Verified against @modelcontextprotocol/sdk 1.30.0 (installed in this
// fixture's node_modules): `McpServer` + `StdioServerTransport` are the
// documented surface; `server.tool(name, description, schema, cb)` is a
// deprecated-but-functional overload in 1.30.0 (the SDK's replacement is
// `registerTool`), kept here because it matches the brief's shape exactly.
// The empty `{}` schema is a plain-object ZodRawShapeCompat, so no zod
// import is needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "helium", version: "0.0.0" });

server.tool(
  "helium_ping",
  "Liveness probe for the helium MCP bridge. Returns the string pong.",
  {},
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

await server.connect(new StdioServerTransport());

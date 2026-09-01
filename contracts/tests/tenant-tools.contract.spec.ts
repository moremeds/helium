/**
 * The MCP stdio server resolves its tenant catalog from an ABSOLUTE
 * `HELIUM_TENANTS_DIR`, never from its own cwd. This matters because the daemon
 * spawns this process with its cwd inside an isolated workspace under
 * `stateRoot/workspaces`; a cwd-relative "plugins" would resolve to nothing
 * there and serve every team agent zero tools, silently. So the proof spawns
 * the real built server from a foreign temp cwd and speaks real MCP to it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/dsh.js";

/** initialize → initialized → tools/list, one JSON-RPC message per line. */
const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "contract", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
]
  .map((message) => `${JSON.stringify(message)}\n`)
  .join("");

describe("contract: the MCP server resolves tenants from an absolute env path", () => {
  it("serves a catalog with the server started from an unrelated cwd", () => {
    const child = spawnSync(
      process.execPath,
      [join(repoRoot, "plugins", "helium", "lib", "mcp", "server.js")],
      {
        cwd: mkdtempSync(join(tmpdir(), "helium-foreign-cwd-")),
        env: {
          ...process.env,
          HELIUM_TENANTS_DIR: resolve(repoRoot, "plugins"),
          HELIUM_STATE_ROOT: mkdtempSync(join(tmpdir(), "helium-state-")),
          HELIUM_TOOLS: "thesis_read",
        },
        input: handshake,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(child.stderr).toMatch(/helium-mcp: tenants=\d+ tools=\d+/);
    expect(child.stderr).not.toMatch(/must be set to an absolute path/);
    expect(child.stdout).toContain("thesis_read");
  });

  it("degrades to the thesis-only catalog when the env path is relative", () => {
    const child = spawnSync(
      process.execPath,
      [join(repoRoot, "plugins", "helium", "lib", "mcp", "server.js")],
      {
        cwd: mkdtempSync(join(tmpdir(), "helium-foreign-cwd-")),
        env: {
          ...process.env,
          HELIUM_TENANTS_DIR: "plugins",
          HELIUM_STATE_ROOT: mkdtempSync(join(tmpdir(), "helium-state-")),
          HELIUM_TOOLS: "thesis_read",
        },
        input: handshake,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(child.stderr).toMatch(/must be set to an absolute path/);
    expect(child.stderr).toMatch(/helium-mcp: tenants=0 tools=2/);
    expect(child.stdout).toContain("thesis_read");
  });
});

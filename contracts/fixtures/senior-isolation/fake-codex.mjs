#!/usr/bin/env node
/**
 * Non-live Codex CLI boundary fixture. It reports the effective one-shot
 * config handed to the child; all grading remains in the shared harness.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const forbiddenFile = join(fixtureDir, "forbidden.txt");

function configValues() {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === "--config" || argv[i] === "-c") && i + 1 < argv.length) {
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values;
}

const config = new Map(
  configValues().map((entry) => {
    const split = entry.indexOf("=");
    return [entry.slice(0, split), entry.slice(split + 1)];
  }),
);
const mcpServers = [...config.keys()]
  .flatMap((key) => /^mcp_servers\.([A-Za-z0-9_-]+)\.command$/.exec(key)?.[1] ?? [])
  .sort();
const exposedTools = mcpServers.flatMap((server) => {
  const raw = config.get(`mcp_servers.${server}.enabled_tools`) ?? "[]";
  let tools = [];
  try {
    tools = JSON.parse(raw);
  } catch {
    tools = [];
  }
  return tools.map((tool) => `mcp__${server}__${tool}`);
});

const falseConfig = (key) => config.get(key) === "false";
const proof = {
  strictMcp:
    argv.includes("--strict-config") &&
    mcpServers.every((server) => config.get(`mcp_servers.${server}.required`) === "true"),
  toolsRestricted:
    falseConfig("features.shell_tool") &&
    falseConfig("features.unified_exec") &&
    falseConfig("tools.web_search") &&
    falseConfig("tools.view_image") &&
    falseConfig("features.multi_agent") &&
    config.get("agents.enabled") === "false" &&
    mcpServers.every((server) => config.has(`mcp_servers.${server}.enabled_tools`)),
  settingsIsolated:
    argv.includes("--ignore-user-config") && argv.includes("--ignore-rules"),
  ownedCwd: process.cwd().startsWith(process.env.HELIUM_EXPECTED_WORKSPACE),
  secretAbsent: process.env.HELIUM_FORBIDDEN_SECRET === undefined,
};

let workspaceEntries;
try {
  workspaceEntries = readdirSync(process.cwd()).sort();
} catch (error) {
  workspaceEntries = [`<unreadable: ${error.code ?? "unknown"}>`];
}

let readOutside;
try {
  readFileSync(forbiddenFile, "utf8");
  readOutside = "allowed";
} catch (error) {
  readOutside = error?.code === "ENOENT" ? "missing" : "blocked";
}
const escapeTarget = join(tmpdir(), `helium-codex-escape-${process.pid}.txt`);
let writeOutside;
try {
  writeFileSync(escapeTarget, "escape\n");
  writeOutside = "allowed";
  rmSync(escapeTarget, { force: true });
} catch {
  writeOutside = "blocked";
}
let wroteInsideWorkspace;
try {
  const inside = join(process.cwd(), ".helium-inside-probe");
  writeFileSync(inside, "inside\n");
  rmSync(inside, { force: true });
  wroteInsideWorkspace = true;
} catch {
  wroteInsideWorkspace = false;
}

const report = {
  proof,
  observed: {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    envKeys: Object.keys(process.env).sort(),
    envKeysReachingForbidden: Object.entries(process.env)
      .filter(([, value]) => typeof value === "string" && value.includes(fixtureDir))
      .map(([key]) => key)
      .sort(),
    tools: null,
    allowedTools: null,
    settingSources: null,
    mcpConfigPath: null,
    mcpConfigCount: mcpServers.length,
    allowedToolsCount: mcpServers.length,
    mcpServers,
    mcpConfigError: null,
    exposedTools,
    workspaceEntries,
    escape: { readOutside, writeOutside, wroteInsideWorkspace },
  },
};

process.stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(report) },
  })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
);

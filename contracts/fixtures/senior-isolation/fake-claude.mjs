#!/usr/bin/env node
/**
 * Execution-boundary conformance fixture: a fake `claude -p` that never talks
 * to a model. It reports what ACTUALLY reached the child — argv, cwd, the
 * environment, the supplied `--mcp-config` file, and two filesystem escape
 * probes — so `contracts/harness/execution-boundary.ts` can grade a subject's
 * real boundary instead of trusting what the subject claims.
 *
 * It owns NO assertions. Every judgement except the five `proof` booleans the
 * plan pins here belongs to the harness.
 *
 * Output shape mirrors the real CLI: `claude -p --output-format json` streams
 * the whole run as a JSON ARRAY with the envelope last, so the harness gets
 * exercised against the same parser `runClaude()` uses in production. The
 * report rides in the envelope's `result` string.
 *
 * The plan says "emit a JSON result only when all of these are true". Emitting
 * NOTHING on a failed proof would make every boundary violation
 * indistinguishable from a crashed binary, so the failure is encoded as
 * `is_error: true` instead — a successful result still requires all five
 * booleans, and the report always survives for diagnosis.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const fixtureDir = dirname(fileURLToPath(import.meta.url));
/** Outside every workspace, on purpose: the read-escape probe's target. */
const forbiddenFile = join(fixtureDir, "forbidden.txt");

/** The value that follows `--flag`, or null when the flag is absent. */
function flagValue(flag) {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
}

function countFlag(flag) {
  return argv.filter((a) => a === flag).length;
}

// The five booleans the plan pins to this fixture (plan Task 2, Step 1).
const proof = {
  strictMcp: argv.includes("--strict-mcp-config"),
  toolsRestricted: argv.includes("--tools"),
  settingsIsolated: argv.includes("--setting-sources"),
  ownedCwd: process.cwd().startsWith(process.env.HELIUM_EXPECTED_WORKSPACE),
  secretAbsent: process.env.HELIUM_FORBIDDEN_SECRET === undefined,
};

// Read the workspace BEFORE the probes write anything into it, so the
// harness's "no undeclared instruction file" check sees the workspace as the
// subject handed it over.
let workspaceEntries;
try {
  workspaceEntries = readdirSync(process.cwd()).sort();
} catch (error) {
  workspaceEntries = [`<unreadable: ${error.code ?? "unknown"}>`];
}

// The MCP servers the child can actually see: exactly what is inside the file
// named by `--mcp-config`, or null when no config was supplied at all.
let mcpServers = null;
let mcpConfigError = null;
const mcpConfigPath = flagValue("--mcp-config");
if (mcpConfigPath !== null) {
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    mcpServers = Object.keys(parsed?.mcpServers ?? {}).sort();
  } catch (error) {
    mcpConfigError = String(error?.message ?? error);
  }
}

/**
 * Can the child reach the sentinel file that lives outside its workspace?
 * "missing" is deliberately distinct from "blocked": a probe that cannot run
 * proves nothing, and the harness treats it as inconclusive rather than as
 * evidence of a sandbox.
 */
let readOutside;
try {
  readFileSync(forbiddenFile, "utf8");
  readOutside = "allowed";
} catch (error) {
  readOutside = error?.code === "ENOENT" ? "missing" : "blocked";
}
// Never echo the sentinel's contents — only whether the read succeeded.

const escapeTarget = join(tmpdir(), `helium-escape-probe-${process.pid}.txt`);
let writeOutside;
try {
  writeFileSync(escapeTarget, "helium escape probe\n");
  writeOutside = "allowed";
  rmSync(escapeTarget, { force: true });
} catch {
  writeOutside = "blocked";
}

let wroteInsideWorkspace;
try {
  const inside = join(process.cwd(), ".helium-inside-probe");
  writeFileSync(inside, "helium inside probe\n");
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
    // Keys only. Values are never reported: a boundary fixture must not be a
    // way to exfiltrate whatever the parent happened to be holding.
    envKeys: Object.keys(process.env).sort(),
    // Which handed-in env values would route the child back out to the
    // sentinel — an env-shaped escape hatch, reported without the values.
    envKeysReachingForbidden: Object.entries(process.env)
      .filter(([, v]) => typeof v === "string" && v.includes(fixtureDir))
      .map(([k]) => k)
      .sort(),
    tools: flagValue("--tools"),
    allowedTools: flagValue("--allowedTools"),
    settingSources: flagValue("--setting-sources"),
    mcpConfigPath,
    mcpConfigCount: countFlag("--mcp-config"),
    allowedToolsCount: countFlag("--allowedTools"),
    mcpServers,
    mcpConfigError,
    workspaceEntries,
    escape: { readOutside, writeOutside, wroteInsideWorkspace },
  },
};

const isError = !Object.values(proof).every(Boolean);
process.stdout.write(
  `${JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      num_turns: 1,
      result: JSON.stringify(report),
    },
  ])}\n`,
);

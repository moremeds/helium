import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingReleasePaths } from "./check-plist-paths.mjs";

/** A release tree holding exactly the paths named. */
function release(...paths) {
  const root = mkdtempSync(join(tmpdir(), "helium-release-"));
  for (const p of paths) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), "");
  }
  return root;
}

const RELEASES = "/Users/moremeds/projects/helium-releases";

test("flags a plist key whose path the new release dropped", () => {
  // The real v0.1.11 -> tenant-lane case: the MCP binary moved out of
  // packages/v1-compat, which the release then deleted.
  const dest = release("plugins/helium/lib/mcp/server.js");
  const missing = missingReleasePaths(
    {
      HELIUM_MCP_BIN: `${RELEASES}/current/packages/v1-compat/lib/mcp/server.js`,
      HELIUM_JOBS_DIR: `${RELEASES}/current/jobs`,
    },
    RELEASES,
    dest,
  );
  assert.deepEqual(
    missing.map((m) => m.key).sort(),
    ["HELIUM_JOBS_DIR", "HELIUM_MCP_BIN"],
  );
});

test("passes once the plist names the paths the release actually ships", () => {
  const dest = release("plugins/helium/lib/mcp/server.js", "teams/ops.yaml");
  assert.deepEqual(
    missingReleasePaths(
      {
        HELIUM_MCP_BIN: `${RELEASES}/current/plugins/helium/lib/mcp/server.js`,
        HELIUM_TEAMS_DIR: `${RELEASES}/current/teams`,
      },
      RELEASES,
      dest,
    ),
    [],
  );
});

test("ignores values that do not point into the releases tree", () => {
  // Credentials and state live outside a release and must never be checked
  // against one -- flagging them would refuse every deploy.
  const dest = release("plugins/helium/lib/mcp/server.js");
  assert.deepEqual(
    missingReleasePaths(
      {
        HELIUM_ENV_FILE: "/Users/moremeds/.helium/helium.env",
        HELIUM_STATE_ROOT: "/Users/moremeds/.helium/state",
        PATH: "/opt/homebrew/bin:/usr/bin",
      },
      RELEASES,
      dest,
    ),
    [],
  );
});

test("ignores a bare release root with no path under it", () => {
  const dest = release("plugins/helium/lib/mcp/server.js");
  assert.deepEqual(
    missingReleasePaths({ SOME_ROOT: `${RELEASES}/current` }, RELEASES, dest),
    [],
  );
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = new URL("../..", import.meta.url).pathname;
const cli = join(repo, "scripts/review/team-canary.mjs");

test("writes a private, bounded controlled-canary request", () => {
  const root = mkdtempSync(join(tmpdir(), "helium-team-canary-cli-"));
  const output = JSON.parse(execFileSync(process.execPath, [
    cli,
    "request",
    "--state-root", root,
    "--tenant", "option-wizard",
    "--case-key", "weekend-smoke-1",
    "--operator", "operator-one",
    "--reason", "prove review-only",
  ], { encoding: "utf8" }));
  const saved = JSON.parse(readFileSync(output.path, "utf8"));
  assert.equal(saved.tenant, "option-wizard");
  assert.equal(saved.caseKey, "weekend-smoke-1");
  assert.match(saved.requestId, /^canary-[0-9a-f]{24}$/);
  assert.ok(Date.parse(saved.expiresAt) - Date.parse(saved.createdAt) <= 30 * 60_000);
  assert.equal(statSync(output.path).mode & 0o777, 0o600);
});

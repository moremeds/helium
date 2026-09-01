import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./validate-jobs.mjs", import.meta.url).pathname;

test("validates a clean release through the v1-compat job boundary", () => {
  const release = mkdtempSync(join(tmpdir(), "helium-release-jobs-"));
  mkdirSync(join(release, "packages/v1-compat/lib"), { recursive: true });
  mkdirSync(join(release, "jobs"), { recursive: true });
  writeFileSync(join(release, "packages/v1-compat/package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(release, "packages/v1-compat/lib/job.js"), `
    export function loadJobs(directory) {
      if (!directory.endsWith("/jobs")) throw new Error("wrong jobs directory");
      return [{ name: "fixture-job" }];
    }
  `);
  writeFileSync(join(release, "jobs/fixture.yaml"), "name: fixture-job\n");

  const output = execFileSync(process.execPath, [helper, release], { encoding: "utf8" });
  assert.match(output, /1 job file\(s\) parse cleanly: fixture-job/);
});

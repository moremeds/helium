#!/usr/bin/env node
// Prints the number of runs that have a run_started row with no terminal row.
// Used by deploy.sh's drain gate before an atomic flip (Task 3.5, spec §9).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(
  process.env.HELIUM_STATE_ROOT ?? join(homedir(), ".helium", "state"),
  "jsonl",
);
const files = readdirSync(dir)
  .filter((f) => f.startsWith("runs-"))
  .sort()
  .slice(-2);
const open = new Set();
for (const f of files) {
  for (const line of readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter(Boolean)) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.runId) continue;
    if (r.phase === "run_started") open.add(r.runId);
    else open.delete(r.runId);
  }
}
console.log(open.size);

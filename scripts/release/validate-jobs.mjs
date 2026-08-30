#!/usr/bin/env node
/** Validate every v1 tenant from the same clean release that will be flipped. */
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const release = resolve(process.argv[2] ?? "");
if (process.argv.length !== 3 || process.argv[2] === "") {
  throw new Error("usage: validate-jobs.mjs RELEASE_ROOT");
}
const modulePath = join(release, "packages", "v1-compat", "lib", "job.js");
const { loadJobs } = await import(pathToFileURL(modulePath).href);
if (typeof loadJobs !== "function") throw new Error("v1-compat release has no loadJobs export");
const jobs = loadJobs(join(release, "jobs"));
process.stdout.write(`  ${jobs.length} job file(s) parse cleanly: ${jobs.map((job) => job.name).join(", ")}\n`);

#!/usr/bin/env node
/** Emit the newest valid raw heartbeat row for each requested tenant. */
import { isAbsolute, join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

const [dir, ...tenants] = process.argv.slice(2);
if (dir === undefined || !isAbsolute(dir)) fail("absolute heartbeat directory required");
if (tenants.length === 0 || tenants.length > 100) fail("one to 100 tenants required");
if (new Set(tenants).size !== tenants.length) fail("duplicate tenant id");
for (const tenant of tenants) {
  if (!/^[A-Za-z0-9_.-]+$/.test(tenant)) fail(`invalid tenant id: ${tenant}`);
}

let names;
try {
  names = readdirSync(dir)
    .filter((name) => /^heartbeat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .slice(-3);
} catch (error) {
  fail(`cannot read heartbeat directory: ${message(error)}`);
}

const requested = new Set(tenants);
const latest = new Map();
for (const name of names) {
  const path = join(dir, name);
  let text;
  try {
    if (!statSync(path).isFile()) continue;
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const row = JSON.parse(line);
      if (
        typeof row?.job !== "string" ||
        !requested.has(row.job) ||
        typeof row?.ts !== "string" ||
        !Number.isFinite(Date.parse(row.ts))
      ) continue;
      const previous = latest.get(row.job);
      if (previous === undefined || Date.parse(row.ts) >= previous.at) {
        latest.set(row.job, { at: Date.parse(row.ts), line });
      }
    } catch {
      // Crash-torn or unrelated lines cannot erase the last valid row.
    }
  }
}

for (const tenant of tenants) {
  const found = latest.get(tenant);
  if (found !== undefined) process.stdout.write(`${found.line}\n`);
}

function fail(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(64);
}

function message(error) {
  return error instanceof Error ? error.message : "unknown error";
}

#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [pagePath, evidencePath] = process.argv.slice(2);
if (!pagePath || !evidencePath) {
  console.error("usage: flash-review-validate.mjs <page> <run-evidence.json>");
  process.exit(2);
}

const fail = (reason) => {
  console.error(`flash-review: inconclusive: ${reason}`);
  process.exit(1);
};
const page = readFileSync(pagePath, "utf8");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const step = [...(evidence.steps ?? [])]
  .reverse()
  .find((entry) => entry.task === "reviewer" || entry.role === "reviewer");
if (!step?.output) fail("no reviewer output in saved run evidence");

let verdict;
try {
  verdict = JSON.parse(step.output.trim());
} catch {
  fail("reviewer output is not one JSON object");
}
if (
  !verdict ||
  typeof verdict !== "object" ||
  !["pass", "fail"].includes(verdict.verdict) ||
  !Array.isArray(verdict.findings) ||
  !Array.isArray(verdict.events_checked) ||
  !Array.isArray(verdict.kept_inference)
)
  fail("reviewer output does not match the verdict schema");

const toolIo = evidence.run?.toolIo;
if (typeof toolIo !== "string") fail("saved evidence names no tool recordings");
const datedPages = new Map();
const evidenceNames = new Set();
for (const name of readdirSync(toolIo).sort()) {
  if (!name.endsWith(".json") && !name.endsWith(".json.gz")) continue;
  const bytes = readFileSync(`${toolIo}/${name}`);
  const record = JSON.parse(
    (name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
  );
  let result;
  try {
    result = JSON.parse(record.raw ?? "");
  } catch {
    if (record.tool === "fr_dated_events")
      fail("dated-event enumerator recording is unreadable");
    continue;
  }
  if (record.tool === "fr_evidence") {
    if (typeof record.args?.file === "string") evidenceNames.add(record.args.file);
    if (typeof result.file === "string") evidenceNames.add(result.file);
    for (const entry of result.recordings ?? [])
      if (typeof entry?.file === "string") evidenceNames.add(entry.file);
    continue;
  }
  if (record.tool !== "fr_dated_events") continue;
  if ((result.unreadable?.length ?? 0) > 0)
    fail("dated-event enumeration includes unreadable evidence");
  const window = result.window;
  if (
    !window ||
    typeof window !== "object" ||
    (window.from !== undefined && typeof window.from !== "string") ||
    (window.to !== undefined && typeof window.to !== "string") ||
    !Number.isInteger(result.offset) ||
    result.offset < 0 ||
    !Number.isInteger(result.total) ||
    result.total < 0 ||
    !Array.isArray(result.events)
  )
    fail("dated-event enumeration has no valid paged result");
  const key = `${window.from ?? ""}|${window.to ?? ""}`;
  const pages = datedPages.get(key) ?? new Map();
  if (pages.has(result.offset)) fail("dated-event enumeration repeats a page offset");
  pages.set(result.offset, result);
  datedPages.set(key, pages);
}

let expected;
for (const pages of datedPages.values()) {
  let offset = 0;
  const all = [];
  for (;;) {
    const result = pages.get(offset);
    if (!result) break;
    if (result.offset !== offset || result.returned !== result.events.length)
      fail("dated-event page does not describe its returned events");
    all.push(...result.events);
    if (result.nextOffset === undefined) {
      if (result.truncated || offset + result.events.length !== result.total)
        fail("dated-event enumeration ended before its declared total");
      expected = all;
      break;
    }
    if (
      !result.truncated ||
      !Number.isInteger(result.nextOffset) ||
      result.nextOffset <= offset ||
      result.nextOffset !== offset + result.events.length ||
      result.nextOffset >= result.total
    )
      fail("dated-event enumeration has an invalid continuation");
    offset = result.nextOffset;
  }
  if (expected !== undefined) break;
}
if (expected === undefined)
  fail("reviewer never completed a dated-event page sequence");

let hasBlockingOrMajor = false;
for (const finding of verdict.findings) {
  if (
    !finding ||
    typeof finding.signature !== "string" ||
    finding.signature === "" ||
    typeof finding.sentence !== "string" ||
    finding.sentence === "" ||
    !page.includes(finding.sentence) ||
    typeof finding.evidence !== "string" ||
    finding.evidence === "" ||
    !["blocking", "major", "minor"].includes(finding.severity)
  )
    fail("a finding is not a quotable, evidenced page finding");
  if (
    finding.evidence !== "absent from evidence" &&
    ![...evidenceNames].some((name) => finding.evidence.includes(name))
  )
    fail("a finding does not reference saved evidence");
  if (finding.severity === "blocking" || finding.severity === "major")
    hasBlockingOrMajor = true;
}
if (verdict.verdict === "pass" && hasBlockingOrMajor)
  fail("pass conflicts with a blocking or major finding");
if (verdict.verdict === "fail" && !hasBlockingOrMajor)
  fail("fail has no blocking or major finding");

const expectedOccurrences = new Map();
for (const event of expected) {
  const key = `${event.date}|${event.file}`;
  const occurrences = expectedOccurrences.get(key) ?? new Set();
  occurrences.add(`${event.tool}|${event.token}|${event.snippet}`);
  expectedOccurrences.set(key, occurrences);
}
const checked = new Map();
for (const event of verdict.events_checked) {
  if (
    !event ||
    typeof event.event !== "string" ||
    event.event === "" ||
    typeof event.date !== "string" ||
    typeof event.recording !== "string" ||
    typeof event.in_page !== "boolean"
  )
    fail("events_checked has an invalid row");
  const key = `${event.date}|${event.recording}`;
  checked.set(key, (checked.get(key) ?? 0) + 1);
}
for (const [key, occurrences] of expectedOccurrences)
  if ((checked.get(key) ?? 0) < occurrences.size)
    fail(`events_checked omits an enumerated event occurrence (${key})`);

console.log("flash-review: verdict is structurally usable");

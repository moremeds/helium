#!/usr/bin/env node
// Manual review accounting only; this does not judge prose or authorize adoption.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalJson, parseStrictJson } from "../packages/core/lib/index.js";
import { measureRuntimeCoverage } from "../plugins/option-wizard/lib/eval/runtime-coverage.js";

const [eventsPath, reviewPath, articlePath, outputPath, ...extra] = process.argv.slice(2);
if (!outputPath || extra.length)
  throw new Error("usage: node scripts/runtime-coverage.mjs events.json review.json final-article|- new-measurement.json");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const eventBytes = readFileSync(eventsPath);
const reviewBytes = readFileSync(reviewPath);
const events = parseStrictJson(eventBytes.toString("utf8"));
const review = parseStrictJson(reviewBytes.toString("utf8"));
if (!Array.isArray(events)) throw new Error("Preregistered events must be a separate JSON array");
if (!review || typeof review !== "object" || Array.isArray(review) || Object.hasOwn(review, "events"))
  throw new Error("Review must not supply or replace the preregistered event denominator");
const finalArtifactHash = articlePath === "-" ? null : digest(readFileSync(articlePath));
if (review.finalArtifactHash !== finalArtifactHash || (review.completed && finalArtifactHash === null))
  throw new Error("Review does not bind the supplied final artifact");
const measurement = measureRuntimeCoverage({ ...review, events });
const lines = articlePath === "-" ? [] : readFileSync(articlePath, "utf8").split(/\r?\n/);
for (const row of review.reviews) {
  const event = events.find(event => event.id === row.eventId);
  if (row.sourceRefs.some(ref => !event.evidenceRefs.includes(ref)))
    throw new Error("Review source reference is outside its preregistered event evidence");
  for (const ref of row.finalSpanRefs) {
    const match = /^final:([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(ref);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!match || end < start || end > lines.length || !lines.slice(start - 1, end).join("\n").trim())
      throw new Error("Final span reference does not resolve to nonempty article lines");
  }
}
writeFileSync(outputPath, canonicalJson({
  mode: "MANUAL_REVIEW_DIAGNOSTIC",
  eventManifestHash: digest(eventBytes), reviewHash: digest(reviewBytes), finalArtifactHash,
  measurement,
}) + "\n", { flag: "wx", mode: 0o600 });
console.log(outputPath);

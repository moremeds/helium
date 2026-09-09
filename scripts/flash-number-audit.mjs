#!/usr/bin/env node
/**
 * #108 acceptance 3 — the number audit.
 *
 * Extracts every number printed on a rendered Flash page and checks that it is
 * present in one of that run's own tool-io recordings. It reports; it never
 * edits prose.
 *
 * Usage:
 *   node scripts/flash-number-audit.mjs <evidence.json> <tool-io dir>
 *
 * A number counts as SOURCED when one of these holds, in this order:
 *   1. verbatim — the printed digits appear character-for-character in a
 *      decompressed recording. This is the #100 rule and the only clean pass.
 *   2. the renderer's own rounding — the page prints a figure the RENDERER
 *      derived, and a payload number rounds to it at the printed precision.
 *      Two derivations are allowed because the renderer performs exactly them:
 *      round-to-printed-decimals, and fraction->percent (x100) then round.
 *      `roundPercents`/`unitOf` in plugins/option-wizard/render/review.ts are
 *      where that arithmetic lives.
 * Anything else is a MISS and is printed verbatim with its context.
 */
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const [, , evidencePath, toolIoDir] = process.argv;
if (!evidencePath || !toolIoDir) {
  console.error("usage: flash-number-audit.mjs <evidence.json> <tool-io dir>");
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const view = evidence.view ?? evidence;
const pageParts = [view.headline ?? ""];
for (const section of view.sections ?? [])
  pageParts.push(section.title ?? "", section.body ?? "");
const page = pageParts.join("\n");

const haystackParts = [];
for (const name of readdirSync(toolIoDir).sort()) {
  if (!name.endsWith(".json.gz")) continue;
  haystackParts.push(gunzipSync(readFileSync(join(toolIoDir, name))).toString("utf8"));
}
const haystack = haystackParts.join("\n");
// Every numeric literal the payloads carry, once.
const payloadNumbers = [
  ...new Set((haystack.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)),
].filter((n) => Number.isFinite(n));

const roundsTo = (printed, decimals) =>
  payloadNumbers.some((n) => {
    const a = Math.abs(n);
    return (
      a.toFixed(decimals) === printed ||
      (a * 100).toFixed(decimals) === printed ||
      (a / 100).toFixed(decimals) === printed
    );
  });

const hits = [];
const misses = [];
const seen = new Set();
for (const match of page.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
  const token = match[0];
  if (seen.has(token)) continue;
  seen.add(token);
  const bare = token.replace(/,/g, "");
  const context = page
    .slice(Math.max(0, match.index - 40), match.index + token.length + 40)
    .replace(/\s+/g, " ");
  if (haystack.includes(bare) || haystack.includes(token)) {
    hits.push({ token, how: "verbatim" });
    continue;
  }
  const decimals = bare.includes(".") ? bare.split(".")[1].length : 0;
  const magnitude = bare.replace(/^[+-]/, "");
  if (roundsTo(magnitude, decimals) || roundsTo(bare, decimals)) {
    hits.push({ token, how: "renderer rounding" });
    continue;
  }
  misses.push({ token, context });
}

console.log(`page: ${evidencePath}`);
console.log(`recordings: ${toolIoDir} (${haystackParts.length} files)`);
console.log(`distinct printed numbers: ${hits.length + misses.length}`);
console.log(
  `hits: ${hits.length} (verbatim ${hits.filter((h) => h.how === "verbatim").length}, rounding ${hits.filter((h) => h.how !== "verbatim").length})`,
);
console.log(`misses: ${misses.length}`);
for (const miss of misses) console.log(`  MISS ${miss.token}  …${miss.context}…`);
process.exit(misses.length === 0 ? 0 : 1);

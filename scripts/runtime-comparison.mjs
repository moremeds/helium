#!/usr/bin/env node
// Offline paired analysis: frozen registration + independently bound trial evidence
// -> a NEW output directory. Never overwrites, never activates, never infers scores.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson, parseStrictJson } from "../packages/core/lib/index.js";
import { analyzeComparison } from "../plugins/option-wizard/lib/eval/runtime-comparison.js";

const [registrationPath, trialsDir, refsDir, outputDir, ...extra] = process.argv.slice(2);
if (!outputDir || extra.length)
  throw new Error("usage: node scripts/runtime-comparison.mjs registration.json trials-dir refs-dir|- new-output-dir");
if (existsSync(outputDir))
  throw new Error(`output path already exists: ${outputDir}; refusing to overwrite evidence`);

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path, errors) => {
  let bytes = null;
  try { bytes = readFileSync(path); } catch (error) { if (error.code !== "ENOENT") errors.push(`${path.split("/").pop()}: ${error.message}`); }
  if (bytes === null) return { bytes: null, value: null };
  try { return { bytes, value: parseStrictJson(bytes.toString("utf8")) }; }
  catch (error) { errors.push(`${path.split("/").pop()}: ${error.message}`); return { bytes: null, value: null }; }
};

const registrationBytes = readFileSync(registrationPath);
const registration = parseStrictJson(registrationBytes.toString("utf8"));

const refs = [];
if (refsDir !== "-")
  for (const name of readdirSync(refsDir).sort())
    refs.push({ name, bytes: readFileSync(join(refsDir, name)), sha256: digest(readFileSync(join(refsDir, name))) });

const trials = [];
for (const label of readdirSync(trialsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  const dir = join(trialsDir, label);
  const inputErrors = [];
  const trial = readJson(join(dir, "trial.json"), inputErrors);
  const events = readJson(join(dir, "events.json"), inputErrors);
  const review = readJson(join(dir, "review.json"), inputErrors);
  const measurement = readJson(join(dir, "measurement.json"), inputErrors);
  const snapshot = readJson(join(dir, "snapshot.json"), inputErrors);
  const claims = readJson(join(dir, "claims.json"), inputErrors);
  const result = readJson(join(dir, "result.json"), inputErrors);
  const failure = readJson(join(dir, "failure.json"), inputErrors);
  if (result.bytes !== null && failure.bytes !== null)
    inputErrors.push("both result.json and failure.json are present");
  const outcome = result.bytes !== null ? result : failure;
  let finalBytes = null;
  try { finalBytes = readFileSync(join(dir, "final.txt")); } catch { /* absent final artifact */ }
  trials.push({
    label,
    trial: trial.value, trialSha256: trial.bytes === null ? null : digest(trial.bytes),
    events: events.value, eventsSha256: events.bytes === null ? null : digest(events.bytes),
    review: review.value, reviewSha256: review.bytes === null ? null : digest(review.bytes),
    measurement: measurement.value, measurementSha256: measurement.bytes === null ? null : digest(measurement.bytes),
    snapshot: snapshot.value, snapshotSha256: snapshot.bytes === null ? null : digest(snapshot.bytes),
    outcome: outcome.value, outcomeSha256: outcome.bytes === null ? null : digest(outcome.bytes),
    outcomeFile: result.bytes !== null ? "result.json" : failure.bytes !== null ? "failure.json" : null,
    claims: claims.value, claimsSha256: claims.bytes === null ? null : digest(claims.bytes),
    finalSha256: finalBytes === null ? null : digest(finalBytes),
    finalLines: finalBytes === null ? null : finalBytes.toString("utf8").split(/\r?\n/),
    inputErrors,
    files: { "trial.json": trial.bytes, "events.json": events.bytes, "review.json": review.bytes,
      "measurement.json": measurement.bytes, "snapshot.json": snapshot.bytes, "claims.json": claims.bytes,
      "result.json": result.bytes, "failure.json": failure.bytes, "final.txt": finalBytes },
  });
}

const result = analyzeComparison({
  registration, registrationSha256: digest(registrationBytes),
  refs: refs.map((ref) => ({ name: ref.name, sha256: ref.sha256 })), trials,
});

mkdirSync(outputDir);
copyFileSync(registrationPath, join(outputDir, "registration.json"));
mkdirSync(join(outputDir, "inputs"));
for (const trial of trials) {
  const dir = join(outputDir, "inputs", trial.label);
  mkdirSync(dir);
  for (const [name, bytes] of Object.entries(trial.files))
    if (bytes !== null) writeFileSync(join(dir, name), bytes, { flag: "wx" });
}
if (refs.length > 0) {
  mkdirSync(join(outputDir, "refs"));
  for (const ref of refs) writeFileSync(join(outputDir, "refs", ref.name), ref.bytes, { flag: "wx" });
}
writeFileSync(join(outputDir, "comparison.json"), canonicalJson(result) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(join(outputDir, "provenance.json"), canonicalJson({
  command: process.argv.slice(2),
  executedAt: new Date().toISOString(),
  engineSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  inputs: result.provenance.files,
  outputs: {
    "comparison.json": digest(readFileSync(join(outputDir, "comparison.json"))),
    "registration.json": digest(registrationBytes),
  },
}) + "\n", { flag: "wx", mode: 0o600 });
console.log(`${result.decision} ${outputDir}`);

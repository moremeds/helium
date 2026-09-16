import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

test("manual measurement binds actual article and separate denominator, preserving prior output", () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-coverage-command-"));
  const file = name => join(dir, name);
  const article = "Explicit simulation: the example event was addressed.";
  writeFileSync(file("article.txt"), article);
  writeFileSync(file("events.json"), JSON.stringify([{ id: "simulation", evidenceRefs: ["synthetic-source"] }]));
  const review = { completed: true,
    finalArtifactHash: createHash("sha256").update(article).digest("hex"),
    reviewer: { identity: "simulated reviewer", rubricHash: "a".repeat(64) },
    reviews: [{ eventId: "simulation", verdict: "addressed", finalSpanRefs: ["final:1"],
      sourceRefs: ["synthetic-source"], criticalErrors: 0, adjudication: "resolved" }],
  };
  writeFileSync(file("review.json"), JSON.stringify(review));
  const run = () => spawnSync(process.execPath, [new URL("./runtime-coverage.mjs", import.meta.url).pathname,
    file("events.json"), file("review.json"), file("article.txt"), file("measurement.json")], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const before = readFileSync(file("measurement.json"), "utf8");
  assert.equal(JSON.parse(before).measurement.coverageFinal, 1);
  assert.notEqual(run().status, 0);
  writeFileSync(file("article.txt"), "changed simulation");
  assert.match(run().stderr, /does not bind/);
  writeFileSync(file("article.txt"), article);
  writeFileSync(file("review.json"), JSON.stringify({ ...review, events: [] }));
  assert.match(run().stderr, /must not supply/);
  writeFileSync(file("review.json"), JSON.stringify({ ...review,
    reviews: [{ ...review.reviews[0], finalSpanRefs: ["final:999"] }] }));
  assert.match(run().stderr, /does not resolve/);
  writeFileSync(file("review.json"), JSON.stringify({ ...review,
    reviews: [{ ...review.reviews[0], sourceRefs: ["unregistered"] }] }));
  assert.match(run().stderr, /outside its preregistered/);
  assert.equal(readFileSync(file("measurement.json"), "utf8"), before);
});

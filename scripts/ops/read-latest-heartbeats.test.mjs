import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./read-latest-heartbeats.mjs", import.meta.url));

test("returns only the latest valid raw row for each requested tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-heartbeat-reader-"));
  try {
    writeFileSync(join(dir, "heartbeat-2026-08-28.jsonl"), [
      '{"ts":"2026-08-28T23:59:00.000Z","job":"macro-watch","detail":"old"}',
      '{"ts":"2026-08-28T23:59:30.000Z","job":"apex-health"}',
    ].join("\n") + "\n");
    writeFileSync(join(dir, "heartbeat-2026-08-29.jsonl"), [
      '{"ts":"2026-08-29T00:01:00.000Z","job":"macro-watch","detail":"latest"}',
      '{"ts":"invalid","job":"apex-health"}',
      '{"ts":"2026-08-29T00:02:00.000Z","job":"not-requested"}',
      '{"torn":',
    ].join("\n"));

    const output = execFileSync(process.execPath, [
      script,
      dir,
      "macro-watch",
      "apex-health",
      "missing",
    ], { encoding: "utf8" });
    expectLines(output, [
      '{"ts":"2026-08-29T00:01:00.000Z","job":"macro-watch","detail":"latest"}',
      '{"ts":"2026-08-28T23:59:30.000Z","job":"apex-health"}',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects relative directories and invalid tenant names", () => {
  assert.throws(
    () => execFileSync(process.execPath, [script, "relative", "macro-watch"]),
    /absolute heartbeat directory/,
  );
  assert.throws(
    () => execFileSync(process.execPath, [script, "/tmp", "bad/tenant"]),
    /invalid tenant id/,
  );
});

function expectLines(actual, expected) {
  assert.deepEqual(actual.trim().split("\n").filter(Boolean), expected);
}

/**
 * Tool I/O recordings: what makes a live-only tool replayable at all.
 * @module @helium/cli/tool-io.test
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  argsKey,
  loadRecordings,
  pruneRecordings,
  recordingsDir,
  writeRecording,
} from "./tool-io.js";

const AT = "2026-09-05T13:45:00.000Z";

function record(tool: string, args: Record<string, unknown>, raw: string) {
  return {
    tool,
    args,
    at: AT,
    raw,
    rawSha256: "unused-by-lookup",
    rawBytes: Buffer.byteLength(raw, "utf8"),
    context: null,
  };
}

describe("argsKey", () => {
  it("does not depend on key order", () => {
    expect(argsKey("ow_spot", { b: 2, a: 1 })).toBe(
      argsKey("ow_spot", { a: 1, b: 2 }),
    );
  });

  it("separates two tools called with the same arguments", () => {
    expect(argsKey("ow_spot", { t: ["SPY"] })).not.toBe(
      argsKey("ow_uw_chain", { t: ["SPY"] }),
    );
  });

  it("separates two argument sets for one tool", () => {
    expect(argsKey("ow_spot", { tickers: ["SPY"] })).not.toBe(
      argsKey("ow_spot", { tickers: ["QQQ"] }),
    );
  });

  it("sorts nested keys too", () => {
    expect(argsKey("t", { o: { b: 1, a: 2 } })).toBe(
      argsKey("t", { o: { a: 2, b: 1 } }),
    );
  });
});

describe("writeRecording and loadRecordings", () => {
  it("round-trips a response through gzip and serves it by tool and args", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(
      dir,
      1,
      record("ow_spot", { tickers: ["SPY"] }, '{"close":661}'),
    );
    const index = loadRecordings(dir);
    expect(index.size).toBe(1);
    expect(index.has("ow_spot")).toBe(true);
    expect(index.has("ow_uw_gex")).toBe(false);
    expect(index.lookup("ow_spot", { tickers: ["SPY"] })).toBe('{"close":661}');
    expect(index.lookup("ow_spot", { tickers: ["QQQ"] })).toBeUndefined();
  });

  it("counts a tool as served only once it has actually answered", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, record("ow_spot", {}, "x"));
    writeRecording(dir, 2, record("ow_uw_gex", {}, "y"));
    const index = loadRecordings(dir);
    expect(index.served()).toEqual([]);
    index.lookup("ow_spot", {});
    index.lookup("ow_uw_gex", { nope: 1 });
    expect(index.served()).toEqual(["ow_spot"]);
  });

  it("keeps the last recording when one tool answered twice for the same args", () => {
    // A tool called twice in a run is normal. The later answer is the one a
    // replay of the whole run should see.
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, record("ow_spot", {}, "first"));
    writeRecording(dir, 12, record("ow_spot", {}, "second"));
    expect(loadRecordings(dir).lookup("ow_spot", {})).toBe("second");
  });

  it("serves nothing, and does not throw, for a directory that is not there", () => {
    const index = loadRecordings(join(tmpdir(), "helium-io-absent-xyz"));
    expect(index.size).toBe(0);
    expect(index.lookup("ow_spot", {})).toBeUndefined();
  });

  it("never serves an error record as if it were a response", () => {
    const dir = recordingsDir(
      mkdtempSync(join(tmpdir(), "helium-io-")),
      "run-1",
    );
    mkdirSync(dir, { recursive: true });
    writeRecording(dir, 1, {
      tool: "ow_spot",
      args: {},
      at: AT,
      raw: null,
      rawSha256: null,
      rawBytes: 0,
      context: null,
      error: "ECONNREFUSED",
    });
    const index = loadRecordings(dir);
    expect(index.has("ow_spot")).toBe(false);
    expect(index.lookup("ow_spot", {})).toBeUndefined();
  });
});

describe("pruneRecordings", () => {
  function runDir(root: string, runId: string, ageDays: number): void {
    const dir = join(root, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker"), "x", "utf8");
    const when = new Date(Date.UTC(2026, 8, 5) - ageDays * 86_400_000);
    utimesSync(dir, when, when);
  }

  it("removes runs older than 30 natural days and keeps the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    runDir(root, "old", 31);
    runDir(root, "edge", 29);
    runDir(root, "new", 0);
    const removed = pruneRecordings(root, {
      now: new Date("2026-09-05T00:00:00Z"),
    });
    expect(removed).toEqual(["old"]);
    expect(readdirSync(join(root, "runs")).sort()).toEqual(["edge", "new"]);
  });

  it("honours a keep-list and removes nothing it names", () => {
    // The caller — not this module — decides what is worth keeping. Nothing
    // here reads a ledger, a database or a config file.
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    runDir(root, "old-a", 40);
    runDir(root, "old-b", 40);
    const removed = pruneRecordings(root, {
      now: new Date("2026-09-05T00:00:00Z"),
      keep: (runId) => runId === "old-b",
    });
    expect(removed).toEqual(["old-a"]);
    expect(readdirSync(join(root, "runs")).sort()).toEqual(["old-b"]);
  });

  it("returns nothing, and does not throw, when there is no runs directory", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-prune-"));
    expect(pruneRecordings(root)).toEqual([]);
  });
});

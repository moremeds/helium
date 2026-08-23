import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlWriter } from "../src/jsonl.js";

/** A throwaway directory for one writer. */
function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "helium-jsonl-"));
}

describe("JsonlWriter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the stream file after the UTC date and injects ts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T23:30:00.000Z"));
    const dir = makeDir();
    new JsonlWriter(dir).append("runs", { job: "macro-watch" });
    const row = JSON.parse(
      readFileSync(join(dir, "runs-2026-08-23.jsonl"), "utf8").trim(),
    );
    expect(row).toEqual({
      ts: "2026-08-23T23:30:00.000Z",
      job: "macro-watch",
    });
  });

  it("keeps a caller-supplied ts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T23:30:00.000Z"));
    const dir = makeDir();
    new JsonlWriter(dir).append("runs", {
      ts: "2020-01-01T00:00:00.000Z",
      job: "x",
    });
    const row = JSON.parse(
      readFileSync(join(dir, "runs-2026-08-23.jsonl"), "utf8").trim(),
    );
    expect(row.ts).toBe("2020-01-01T00:00:00.000Z");
  });

  it("appends across calls instead of truncating", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    const writer = new JsonlWriter(dir);
    writer.append("runs", { n: 1 });
    writer.append("runs", { n: 2 });
    const lines = readFileSync(join(dir, "runs-2026-08-23.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).n)).toEqual([1, 2]);
  });

  it("prune deletes only date-stamped files older than the retention window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const dir = makeDir();
    const writer = new JsonlWriter(dir);
    writeFileSync(join(dir, "runs-2026-01-01.jsonl"), "{}\n");
    writeFileSync(join(dir, "runs-2026-08-01.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "keep me\n");
    writeFileSync(join(dir, "runs-latest.jsonl"), "keep me\n");
    writer.append("runs", { n: 1 });
    writer.prune(90);
    expect(readdirSync(dir).sort()).toEqual([
      "notes.txt",
      "runs-2026-08-01.jsonl",
      "runs-2026-08-23.jsonl",
      "runs-latest.jsonl",
    ]);
  });
});

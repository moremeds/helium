import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalJson, openEventStore } from "../src/event-store.js";

const RecordSchema = z.strictObject({ kind: z.string(), n: z.number() });
const first = { kind: "a", n: 1 };
const second = { kind: "b", n: 2 };
const third = { kind: "c", n: 3 };

const dir = () => mkdtempSync(join(tmpdir(), "helium-events-"));

describe("event store", () => {
  it("appends and replays in order", () => {
    const store = openEventStore(dir(), { schema: RecordSchema });
    store.append(first);
    store.append(second);
    expect(store.replay()).toEqual([first, second]);
  });

  it("hashes each record canonically, independent of key order", () => {
    const store = openEventStore(dir(), { schema: RecordSchema });
    const expected = createHash("sha256")
      .update(canonicalJson(first))
      .digest("hex");
    expect(store.contentHash(first)).toBe(`sha256:${expected}`);
    expect(store.contentHash({ n: 1, kind: "a" })).toBe(store.contentHash(first));
  });

  it("crosses an fsync boundary on every append", () => {
    const sync = vi.fn();
    const store = openEventStore(dir(), { schema: RecordSchema, sync });
    store.append(first);
    store.append(second);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("drops a truncated final line and recovers, never repairing the record", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema });
    store.append(first);
    store.append(second);
    store.snapshot();
    store.append(third);

    const raw = readFileSync(store.logPath, "utf8");
    truncateSync(store.logPath, raw.length - 12);

    const reopened = openEventStore(d, { schema: RecordSchema });
    expect(reopened.replay()).toEqual([first, second]);
  });

  it("replays through a snapshot plus its tail", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema });
    store.append(first);
    store.append(second);
    const snap = store.snapshot();
    expect(snap.lastSeq).toBe(2);
    expect(snap.lastHash).toBe(store.contentHash(second));
    store.append(third);
    expect(openEventStore(d, { schema: RecordSchema }).replay()).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("discards a snapshot whose hash disagrees with the log — the log is authoritative", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema });
    store.append(first);
    store.append(second);
    store.snapshot();
    const tampered = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    tampered.lastHash = "sha256:0000";
    writeFileSync(store.snapshotPath, JSON.stringify(tampered));

    expect(openEventStore(d, { schema: RecordSchema }).replay()).toEqual([
      first,
      second,
    ]);
  });

  it("discards a snapshot at an unsupported version — the log is authoritative", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema });
    store.append(first);
    store.snapshot();
    const bumped = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    bumped.v = 999;
    writeFileSync(store.snapshotPath, JSON.stringify(bumped));

    expect(openEventStore(d, { schema: RecordSchema }).replay()).toEqual([first]);
  });

  it("refuses a record the caller's schema rejects", () => {
    const store = openEventStore(dir(), { schema: RecordSchema });
    expect(() => store.append({ kind: "a" } as never)).toThrow();
  });
});

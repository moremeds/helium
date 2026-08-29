import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
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

/**
 * Most of these cases are about append/replay/snapshot SEMANTICS, not about
 * durability, and a real `fsync` per append made them contend on CI: with 36
 * unit files fanned across workers, one run stalled past the 5s default and
 * failed. `fsync` latency on shared runner storage is unbounded, so the
 * default was a wrong assumption rather than a bug in the store.
 *
 * The fsync boundary itself stays under test two ways: one case asserts it is
 * crossed once per append using a spy, and "appends and replays in order"
 * deliberately keeps the real `fsyncSync` default with a timeout that reflects
 * what shared storage can actually cost.
 */
const noSync = () => {};

describe("event store", () => {
  it(
    "appends and replays in order, across a real fsync",
    () => {
      const store = openEventStore(dir(), { schema: RecordSchema });
      store.append(first);
      store.append(second);
      expect(store.replay()).toEqual([first, second]);
    },
    30_000,
  );

  it("hashes each record canonically, independent of key order", () => {
    const store = openEventStore(dir(), { schema: RecordSchema, sync: noSync });
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

  it("creates owner-only directories, logs, and snapshots and refuses permissive state", () => {
    const base = mkdtempSync(join(tmpdir(), "helium-private-events-"));
    const privateDir = join(base, "private");
    const store = openEventStore(privateDir, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.snapshot();
    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(statSync(store.logPath).mode & 0o777).toBe(0o600);
    expect(statSync(store.snapshotPath).mode & 0o777).toBe(0o600);

    chmodSync(privateDir, 0o755);
    expect(() => openEventStore(privateDir, { schema: RecordSchema })).toThrow(
      /owner-only/,
    );
  });

  it("drops a truncated final line and recovers, never repairing the record", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.append(second);
    store.snapshot();
    store.append(third);

    const raw = readFileSync(store.logPath, "utf8");
    truncateSync(store.logPath, raw.length - 12);

    const reopened = openEventStore(d, { schema: RecordSchema, sync: noSync });
    expect(reopened.replay()).toEqual([first, second]);
  });

  it("replays through a snapshot plus its tail", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.append(second);
    const snap = store.snapshot();
    expect(snap.lastSeq).toBe(2);
    expect(snap.lastHash).toBe(store.contentHash(second));
    store.append(third);
    expect(openEventStore(d, { schema: RecordSchema, sync: noSync }).replay()).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("discards a snapshot whose hash disagrees with the log — the log is authoritative", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.append(second);
    store.snapshot();
    const tampered = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    tampered.lastHash = "sha256:0000";
    writeFileSync(store.snapshotPath, JSON.stringify(tampered));

    expect(openEventStore(d, { schema: RecordSchema, sync: noSync }).replay()).toEqual([
      first,
      second,
    ]);
  });

  it("discards a snapshot whose earlier record was changed behind a valid anchor", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.append(second);
    store.snapshot();
    const tampered = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    tampered.records[0].n = 999;
    writeFileSync(store.snapshotPath, JSON.stringify(tampered));

    expect(openEventStore(d, { schema: RecordSchema, sync: noSync }).replay()).toEqual([
      first,
      second,
    ]);
  });

  it("discards a snapshot at an unsupported version — the log is authoritative", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.snapshot();
    const bumped = JSON.parse(readFileSync(store.snapshotPath, "utf8"));
    bumped.v = 999;
    writeFileSync(store.snapshotPath, JSON.stringify(bumped));

    expect(openEventStore(d, { schema: RecordSchema, sync: noSync }).replay()).toEqual([first]);
  });

  it("refuses a log whose record content no longer matches its persisted hash", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    const envelope = JSON.parse(readFileSync(store.logPath, "utf8"));
    envelope.record.n = 999;
    writeFileSync(store.logPath, `${JSON.stringify(envelope)}\n`);
    expect(() => openEventStore(d, { schema: RecordSchema, sync: noSync }))
      .toThrow(/content hash mismatch/);
  });

  it("refuses a reordered or deleted log prefix by checking contiguous sequence numbers", () => {
    const d = dir();
    const store = openEventStore(d, { schema: RecordSchema, sync: noSync });
    store.append(first);
    store.append(second);
    const lines = readFileSync(store.logPath, "utf8").trim().split("\n");
    writeFileSync(store.logPath, `${lines[1]}\n`);
    expect(() => openEventStore(d, { schema: RecordSchema, sync: noSync }))
      .toThrow(/sequence mismatch/);
  });

  it("refuses a record the caller's schema rejects", () => {
    const store = openEventStore(dir(), { schema: RecordSchema, sync: noSync });
    expect(() => store.append({ kind: "a" } as never)).toThrow();
  });
});

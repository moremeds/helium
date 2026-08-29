import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OperationsStore } from "../src/operations/store.js";
import type { OperationsEvent } from "../src/operations/events.js";

const dir = () => mkdtempSync(join(tmpdir(), "helium-ops-store-"));
const noSync = () => {};
const digest = `sha256:${"a".repeat(64)}`;

const opened: OperationsEvent = {
  v: 1,
  id: "ev-1",
  at: "2026-08-25T04:00:00.000Z",
  type: "incident-opened",
  incidentId: "inc-1",
  componentId: "runtime",
  dimension: "controller",
  observationIds: [],
};
const proposed: OperationsEvent = {
  v: 1,
  id: "ev-2",
  at: "2026-08-25T04:01:00.000Z",
  type: "action-proposed",
  actionId: "act-1",
  incidentId: "inc-1",
  componentId: "runtime",
  sopId: "restart",
  sopVersion: 1,
  sopDigest: digest,
};

describe("OperationsStore", () => {
  it("appends and projects", () => {
    const store = OperationsStore.open(dir(), { sync: noSync });
    store.append(opened);
    store.append(proposed);
    expect(store.state().incidents["inc-1"].state).toBe("open");
    expect(store.state().actions["act-1"].state).toBe("proposed");
  });

  it("reopens onto the same state by replaying the log", () => {
    const d = dir();
    const first = OperationsStore.open(d, { sync: noSync });
    first.append(opened);
    first.append(proposed);
    const reopened = OperationsStore.open(d, { sync: noSync });
    expect(reopened.state()).toEqual(first.state());
  });

  it("crosses an fsync boundary on every append", () => {
    const sync = vi.fn();
    const store = OperationsStore.open(dir(), { sync });
    store.append(opened);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("refuses a duplicate event id", () => {
    const store = OperationsStore.open(dir(), { sync: noSync });
    store.append(opened);
    expect(() => store.append({ ...proposed, id: "ev-1" })).toThrow(/duplicate/);
  });

  it("refuses an unsupported event version", () => {
    const store = OperationsStore.open(dir(), { sync: noSync });
    expect(() => store.append({ ...opened, v: 2 })).toThrow();
  });

  it("refuses an unknown event type", () => {
    const store = OperationsStore.open(dir(), { sync: noSync });
    expect(() => store.append({ ...opened, type: "invented-event" })).toThrow();
  });

  // Write-ahead means the log is the truth. A rejected event must not reach
  // it, or the next replay resurrects a transition the store refused.
  it("does not append an event it rejects", () => {
    const store = OperationsStore.open(dir(), { sync: noSync });
    store.append(opened);
    expect(() =>
      store.append({
        v: 1,
        id: "ev-bad",
        at: "2026-08-25T04:02:00.000Z",
        type: "action-authorized",
        actionId: "never-proposed",
        authority: "auto",
      }),
    ).toThrow();
    expect(store.replay().map((e) => e.id)).toEqual(["ev-1"]);
    expect(OperationsStore.open(store.logPath.replace(/\/events\.jsonl$/, ""), {
      sync: noSync,
    }).replay()).toHaveLength(1);
  });

  it("recovers from a truncated final line", () => {
    const d = dir();
    const store = OperationsStore.open(d, { sync: noSync });
    store.append(opened);
    store.append(proposed);
    const raw = readFileSync(store.logPath, "utf8");
    truncateSync(store.logPath, raw.length - 20);
    expect(OperationsStore.open(d, { sync: noSync }).replay().map((e) => e.id)).toEqual([
      "ev-1",
    ]);
  });

  it("falls back to full replay when the snapshot does not describe the log", () => {
    const d = dir();
    const store = OperationsStore.open(d, { sync: noSync });
    store.append(opened);
    store.append(proposed);
    store.snapshot();
    const snapshotPath = join(d, "snapshot.json");
    const corrupt = JSON.parse(readFileSync(snapshotPath, "utf8"));
    corrupt.lastHash = "sha256:0000";
    writeFileSync(snapshotPath, JSON.stringify(corrupt));

    const reopened = OperationsStore.open(d, { sync: noSync });
    expect(reopened.replay().map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(reopened.state().actions["act-1"].state).toBe("proposed");
  });
});

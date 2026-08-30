import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpsResourcePressureReader } from "./ops-pressure.js";

const root = () => mkdtempSync(join(tmpdir(), "helium-ops-pressure-"));

function observation(
  at: string,
  state: "ok" | "degraded" | "failed" | "unknown",
  value?: Record<string, unknown>,
) {
  return JSON.stringify({
    record: {
      type: "observation-recorded",
      observation: {
        componentId: "host",
        dimension: "memory-pressure",
        state,
        ...(value === undefined ? {} : { value }),
        observedAt: at,
        expiresAt: new Date(Date.parse(at) + 10 * 60_000).toISOString(),
      },
    },
  });
}

describe("OpsResourcePressureReader", () => {
  it("derives the sustained degraded window from the opsd observation stream", () => {
    const path = join(root(), "events.jsonl");
    const reader = new OpsResourcePressureReader(path, {
      read: () => [
        observation("2026-08-30T00:00:00.000Z", "degraded"),
        observation("2026-08-30T00:05:00.000Z", "degraded"),
      ].join("\n"),
      now: () => new Date("2026-08-30T00:05:00.000Z"),
    });
    expect(reader.read()).toEqual({ memoryState: "degraded", observedForMs: 300_000 });
  });

  it("holds recovery until the healthy streak has been sustained", () => {
    const path = join(root(), "events.jsonl");
    const rows = [
      observation("2026-08-30T00:00:00.000Z", "failed"),
      observation("2026-08-30T00:05:00.000Z", "ok"),
      observation("2026-08-30T00:06:00.000Z", "ok"),
    ].join("\n");
    expect(new OpsResourcePressureReader(path, {
      read: () => rows,
      now: () => new Date("2026-08-30T00:06:00.000Z"),
    }).read()).toEqual({
      memoryState: "ok",
      observedForMs: 60_000,
      recoveringFromPressure: true,
      recoveredForMs: 60_000,
    });
  });

  it("admits the bounded canary when degraded means only historical swap, not current pressure", () => {
    const path = join(root(), "events.jsonl");
    const safe = {
      pressure: { level: "normal", freePercent: 35 },
      pageoutRate: 14.8,
      serviceImpact: false,
      swap: { usedBytes: 12_136_344_453 },
    };
    const rows = [
      observation("2026-08-30T00:00:00.000Z", "degraded", safe),
      observation("2026-08-30T00:05:00.000Z", "degraded", safe),
    ].join("\n");
    expect(new OpsResourcePressureReader(path, {
      read: () => rows,
      now: () => new Date("2026-08-30T00:05:00.000Z"),
    }).read()).toEqual({ memoryState: "ok", observedForMs: 300_000 });
  });

  it("keeps warning pressure, high pageout churn, and service impact refused", () => {
    const path = join(root(), "events.jsonl");
    for (const value of [
      { pressure: { level: "warning", freePercent: 12 }, pageoutRate: 1, serviceImpact: false },
      { pressure: { level: "normal", freePercent: 35 }, pageoutRate: 500, serviceImpact: false },
      { pressure: { level: "normal", freePercent: 35 }, pageoutRate: 1, serviceImpact: true },
    ]) {
      expect(new OpsResourcePressureReader(path, {
        read: () => observation("2026-08-30T00:00:00.000Z", "degraded", value),
        now: () => new Date("2026-08-30T00:05:00.000Z"),
      }).read()).toEqual({ memoryState: "degraded", observedForMs: 300_000 });
    }
  });

  it("returns unknown for a missing, malformed, expired, or future-only stream", () => {
    const path = join(root(), "events.jsonl");
    for (const read of [
      () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      () => "not-json",
      () => observation("2026-08-29T00:00:00.000Z", "degraded"),
      () => observation("2026-08-31T00:00:00.000Z", "degraded"),
    ]) {
      expect(new OpsResourcePressureReader(path, {
        read,
        now: () => new Date("2026-08-30T00:00:00.000Z"),
      }).read()).toEqual({ memoryState: "unknown", observedForMs: 0 });
    }
  });
});

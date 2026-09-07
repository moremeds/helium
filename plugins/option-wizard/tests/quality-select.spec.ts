/**
 * The ranking is arithmetic in code, and the phrase that describes it is
 * formatted here so the model only ever copies it. Every level and move used
 * below is the recorded 2026-09-03 close payload; the medians are constructed
 * denominators, which is what a median is.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditStore } from "@helium/core";
import { readFileSync } from "node:fs";
import { extractChannels, type Channel } from "../quality/channels.js";
import {
  MIN_HISTORY,
  MOVE_METRIC,
  channelHistory,
  type ChannelHistory,
} from "../quality/history.js";
import {
  EVENT_SCORE,
  RATIO_THRESHOLD,
  select,
} from "../quality/select.js";

const FIX = join(__dirname, "fixtures", "review");
const macro: unknown = JSON.parse(
  readFileSync(join(FIX, "macro-2026-09-03-close.json"), "utf8"),
);
const DAY = "2026-09-03";
const channels = extractChannels({ macro, day: DAY });
const byId = (id: string): Channel => channels.find((c) => c.id === id)!;

function history(
  entries: Array<[string, number[], 0 | 1]>,
): Map<Channel["id"], ChannelHistory> {
  return new Map(
    entries.map(([id, moves, medianSource]) => [
      id as Channel["id"],
      { moves, medianSource },
    ]),
  ) as Map<Channel["id"], ChannelHistory>;
}

/** 20 observations whose median is `mid`. */
function flat(mid: number): number[] {
  return Array.from({ length: MIN_HISTORY }, () => mid);
}

describe("select", () => {
  it("scores the leader against its own median and hands the model the phrase", () => {
    // VIXCLS 16.34 -> 15.2 is a 1.14-point move against a 0.35 median.
    const out = select({
      channels: [byId("vol"), byId("credit")],
      history: history([
        ["vol", flat(0.35), 1],
        ["credit", flat(4), 1],
      ]),
    });
    expect(out.mode).toBe("ratio");
    expect(out.ranked[0]!.channel.id).toBe("vol");
    expect(out.ranked[0]!.score).toBeCloseTo(1.14 / 0.35, 10);
    expect(out.ranked[0]!.medianSource).toBe(1);
    expect(out.why).toBe(
      "largest normalised move of the session, 3.3x its 20-session median",
    );
  });

  it("breaks a tie by channel order, never by chance", () => {
    // rates is order 1, credit order 4. Both score exactly 2.5.
    const rates = { ...byId("rates"), magnitude: 2.5 };
    const credit = { ...byId("credit"), magnitude: 2.5 };
    const out = select({
      channels: [credit, rates],
      history: history([
        ["rates", flat(1), 1],
        ["credit", flat(1), 1],
      ]),
    });
    expect(out.ranked.map((r) => r.channel.id)).toEqual(["rates", "credit"]);
    expect(out.ranked[0]!.score).toBe(2.5);
  });

  it("scores null and ranks last on a short history with no sign flip", () => {
    const out = select({
      channels: [byId("vol"), byId("credit")],
      history: history([
        ["vol", [0.4, 0.3], 0],
        ["credit", flat(0.2), 1],
      ]),
    });
    expect(out.ranked.at(-1)!.channel.id).toBe("vol");
    expect(out.ranked.at(-1)!.score).toBeNull();
    expect(out.ranked.at(-1)!.medianSource).toBeNull();
    expect(out.mode).toBe("ratio");
  });

  it("scores a sign flip on a short history rather than dropping it", () => {
    const flipped: Channel = { ...byId("vol"), signFlip: true };
    const out = select({
      channels: [flipped],
      history: history([["vol", [0.4], 0]]),
    });
    expect(out.ranked[0]!.score).toBe(EVENT_SCORE);
  });

  it("falls back to persistence, with a streak, when nothing stood out", () => {
    const out = select({
      channels: [byId("vol")],
      history: history([["vol", flat(1.14 / 1.4), 1]]),
      trail: [
        { day: "2026-09-02", values: { [MOVE_METRIC.vol]: 0.9 } },
        { day: "2026-09-01", values: { [MOVE_METRIC.vol]: 0.8 } },
        { day: "2026-08-31", values: { [MOVE_METRIC.vol]: 0.2, [MOVE_METRIC.credit]: 3 } },
      ],
    });
    expect(out.ranked[0]!.score).toBeCloseTo(1.4, 6);
    expect(out.ranked[0]!.score! < RATIO_THRESHOLD).toBe(true);
    expect(out.mode).toBe("persistence");
    expect(out.streak).toBe(2);
    expect(out.why).toContain("has led for 2 sessions");
  });

  it("returns no-data with an empty ranking when every channel is excluded", () => {
    const out = select({
      channels: [byId("dealer"), byId("event")],
      history: history([]),
    });
    expect(out.mode).toBe("no-data");
    expect(out.ranked).toEqual([]);
    expect(out.why).toBe("");
  });

  it("lets a breached standing invalidation win against a higher score", () => {
    const out = select({
      channels: [byId("vol"), byId("credit")],
      history: history([
        ["vol", flat(0.35), 1],
        ["credit", flat(4), 1],
      ]),
      standing: {
        series: "BAMLH0A0HYM2",
        threshold: ">2.60",
        horizon: "5 sessions",
      },
    });
    expect(out.mode).toBe("invalidation");
    expect(out.breach).toEqual({
      series: "BAMLH0A0HYM2",
      threshold: ">2.60",
      horizon: "5 sessions",
      level: "2.66",
    });
    expect(out.ranked[0]!.channel.id).toBe("credit");
  });

  it("does not fire an invalidation whose threshold was not reached", () => {
    const out = select({
      channels: [byId("credit")],
      history: history([["credit", flat(4), 1]]),
      standing: {
        series: "BAMLH0A0HYM2",
        threshold: ">3.00",
        horizon: "5 sessions",
      },
    });
    expect(out.mode).not.toBe("invalidation");
  });
});

describe("channelHistory", () => {
  function db(): { path: string; env: NodeJS.ProcessEnv } {
    // A file, not `:memory:` — `channelHistory` opens its OWN connection from
    // the environment, and an in-memory database is private to the handle that
    // created it, so nothing written through a second one would be visible.
    const path = join(mkdtempSync(join(tmpdir(), "ow-history-")), "audit.db");
    return { path, env: { HELIUM_AUDIT_DB: path } };
  }

  it("prefers the accumulated metric rows and says so", () => {
    const { path, env } = db();
    const store = new AuditStore(path);
    for (let i = 0; i < MIN_HISTORY; i += 1) {
      const day = `2026-08-${String(i + 1).padStart(2, "0")}`;
      store.appendMetric({
        runId: `run-${i}`,
        name: MOVE_METRIC.vol,
        value: 0.35,
        ts: `${day}T20:15:00.000Z`,
        day,
        label: "close",
      });
    }
    store.close();
    const out = channelHistory({
      channels: [byId("vol")],
      inputs: { macro, day: DAY },
      days: ["2026-08-01", "2026-08-31"],
      env,
    });
    expect(out.history.get("vol")!.medianSource).toBe(1);
    expect(out.history.get("vol")!.moves).toHaveLength(MIN_HISTORY);
    expect(out.note).toBeUndefined();
  });

  it("falls back to the channel's own daily series and labels the denominator", () => {
    const { env } = db();
    const out = channelHistory({
      channels: [byId("vol")],
      inputs: { macro, day: DAY },
      days: ["2026-08-01", "2026-08-31"],
      env,
    });
    const entry = out.history.get("vol")!;
    expect(entry.medianSource).toBe(0);
    // 22 VIXCLS observations make 21 consecutive moves, capped at 20.
    expect(entry.moves).toHaveLength(MIN_HISTORY);
    expect(entry.moves[0]).toBeCloseTo(1.14, 10);
  });

  it("returns an empty history rather than a zero denominator when neither source answers", () => {
    const { env } = db();
    const out = channelHistory({
      channels: [byId("dealer")],
      inputs: { day: DAY },
      days: ["2026-08-01", "2026-08-31"],
      env,
    });
    expect(out.history.get("dealer")!.moves).toEqual([]);
  });

  it("closes its handle — calling it twice in one process raises nothing", () => {
    const { env } = db();
    const args = {
      channels: [byId("vol")],
      inputs: { macro, day: DAY },
      days: ["2026-08-01", "2026-08-31"],
      env,
    };
    expect(() => {
      channelHistory(args);
      channelHistory(args);
    }).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  atr, bs, gexLevels, impliedVol, legsValue, sma, spotWhereLossReaches, swings, volumeProfile,
  type DailyBar, type Leg,
} from "../tools/levels.js";

const bar = (close: number, high = close + 1, low = close - 1): DailyBar => ({ time: "", open: close, high, low, close });

describe("position-review levels", () => {
  it("sma, atr and swing lows on hand-checkable bars", () => {
    const bars = [10, 11, 12, 13, 14].map((c) => bar(c));
    expect(sma(bars, 5)).toBe(12);
    expect(sma(bars, 6)).toBeUndefined();
    // every true range is 2 (high-low) since gaps of 1 sit inside the bar
    expect(atr(bars, 3)).toBeCloseTo(2, 10);
    const v = [5, 4, 3, 2, 3, 4, 5].map((c) => bar(c));
    expect(swings(v, 3).lows.map((b) => b.close)).toEqual([2]);
  });

  it("black-scholes obeys put-call parity and implied vol round-trips", () => {
    const [s, k, t, iv, r] = [7400, 7300, 0.05, 0.22, 0.04];
    const c = bs("C", s, k, t, iv, r);
    const p = bs("P", s, k, t, iv, r);
    expect(c - p).toBeCloseTo(s - k * Math.exp(-r * t), 4);
    expect(impliedVol("P", p, s, k, t, r)).toBeCloseTo(iv, 4);
  });

  it("volume profile puts the POC where the volume is", () => {
    const m = (low: number, high: number, volume: number) => ({ time: "", low, high, close: low, volume });
    const p = volumeProfile([m(100, 100.4, 10), m(101, 101.4, 1000), m(102, 102.4, 10)], 0.5)!;
    expect(p.poc).toBe(101.25);
  });

  it("gex walls are chosen per side of spot", () => {
    const g = gexLevels(
      [
        { strike: 7000, callGamma: 0, putGamma: -50 },
        { strike: 7200, callGamma: 5, putGamma: -90 },
        { strike: 7500, callGamma: 200, putGamma: -1 },
        { strike: 7600, callGamma: 40, putGamma: 0 },
      ],
      7400,
    );
    expect(g.callWall).toBe(7500);
    expect(g.putWall).toBe(7200);
    expect(g.accelerator).toBe(7200);
    expect(g.flip).toBe(7500); // cumulative: -50, -135, +64 -> sign change at 7500
  });

  it("a short put vertical's loss is bounded by its width and the cushion level is found", () => {
    const legs: Leg[] = [
      { right: "P", strike: 7400, expiry: "2026-11-20", qty: -1, iv: 0.2 },
      { right: "P", strike: 7300, expiry: "2026-11-20", qty: 1, iv: 0.22 },
    ];
    const asOf = new Date("2026-11-09T15:00:00Z");
    const now = legsValue(legs, 7500, asOf);
    const deep = legsValue(legs, 6000, asOf);
    expect(now - deep).toBeLessThanOrEqual(100 * 100);
    expect(now - deep).toBeGreaterThan(0);
    const s = spotWhereLossReaches(legs, 7500, 3000, asOf, 6000)!;
    expect(now - legsValue(legs, s, asOf)).toBeCloseTo(3000, 0);
    expect(spotWhereLossReaches(legs, 7500, 1e9, asOf, 6000)).toBeUndefined();
  });
});

describe("position-review stop/take-profit side", () => {
  it("a long put's stop is above spot and its take-profit below", async () => {
    const { sideCandidates } = await import("../tools/analyse.js");
    // Futu XLV 261218 P170 x40 (long), estPnl from the 2026-11-08 run (IB daily bars, frozen).
    const s = sideCandidates([
      { id: "swing_low_2026-10-28", level: 177.07, side: "below", estPnlAtLevel: 6374.66 },
      { id: "atr2_up", level: 191.98, side: "above", estPnlAtLevel: -2602.71 },
      { id: "x", level: 180, side: "below", estPnlAtLevel: null },
    ]);
    expect(s.stopCandidates.map((c) => c.id)).toEqual(["atr2_up"]);
    expect(s.takeProfitCandidates.map((c) => c.id)).toEqual(["swing_low_2026-10-28"]);
    expect(s.unclassified.map((c) => c.id)).toEqual(["x"]);
  });
});

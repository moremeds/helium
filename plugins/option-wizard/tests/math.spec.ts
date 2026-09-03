/**
 * Every expected value here is hand-computed and written out, not captured from
 * the implementation. The failure this file exists to stop reached a reader on
 * 2026-09-02: a max loss printed as the max gain (6x), and a put spread whose
 * direction was inverted.
 */
import { describe, expect, it } from "vitest";
import {
  formatScheduleMagnitude,
  priceStructure,
  scheduleTimeLabel,
  width,
  type Leg,
} from "../render/math.js";

const EXP = "2026-09-30";
const leg = (
  right: "call" | "put",
  action: "buy" | "sell",
  strike: number,
  mid?: number,
): Leg => ({
  right,
  action,
  strike,
  expiry: EXP,
  ...(mid === undefined ? {} : { mid }),
});

describe("priceStructure", () => {
  it("prices a put credit spread: sell 100P @2.00 / buy 95P @0.80", () => {
    // net = +2.00 - 0.80 = +1.20 credit; width 5.00
    // max gain = 1.20 x 100 = 120 (spot >= 100)
    // max loss = (5.00 - 1.20) x 100 = 380 (spot <= 95)
    // breakeven = 100 - 1.20 = 98.80
    const priced = priceStructure(
      [leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)],
      100,
    );
    expect(priced).toMatchObject({
      kind: "priced",
      net: 1.2,
      maxGain: 120,
      maxLoss: 380,
      breakevens: [98.8],
    });
  });

  it("prices a call debit spread: buy 100C @3.00 / sell 105C @1.20", () => {
    // net = -3.00 + 1.20 = -1.80 debit
    // max gain = (5.00 - 1.80) x 100 = 320; max loss = 180; breakeven 101.80
    const priced = priceStructure(
      [leg("call", "buy", 100, 3.0), leg("call", "sell", 105, 1.2)],
      100,
    );
    expect(priced).toMatchObject({
      kind: "priced",
      net: -1.8,
      maxGain: 320,
      maxLoss: 180,
      breakevens: [101.8],
    });
  });

  it("prices an iron condor with two breakevens", () => {
    // sell 95P @1.00 / buy 90P @0.40 / sell 105C @1.00 / buy 110C @0.40
    // net = 1.00 - 0.40 + 1.00 - 0.40 = +1.20; each wing 5 wide
    // max gain 120 (95 <= spot <= 105); max loss (5 - 1.20) x 100 = 380
    // breakevens 95 - 1.20 = 93.80 and 105 + 1.20 = 106.20
    const priced = priceStructure(
      [
        leg("put", "sell", 95, 1.0),
        leg("put", "buy", 90, 0.4),
        leg("call", "sell", 105, 1.0),
        leg("call", "buy", 110, 0.4),
      ],
      100,
    );
    expect(priced).toMatchObject({
      kind: "priced",
      net: 1.2,
      maxGain: 120,
      maxLoss: 380,
      breakevens: [93.8, 106.2],
    });
  });

  it("refuses an uncovered short call as an invalid structure", () => {
    expect(priceStructure([leg("call", "sell", 100, 2.0)], 100)).toEqual({
      kind: "invalid",
      reason:
        "Invalid structure: net short call leg with no covering long of the same right",
    });
  });

  it("refuses an uncovered short put as an invalid structure", () => {
    expect(priceStructure([leg("put", "sell", 100, 2.0)], 100)).toEqual({
      kind: "invalid",
      reason:
        "Invalid structure: net short put leg with no covering long of the same right",
    });
  });

  it("returns unpriced, never an estimate, when a leg has no mid", () => {
    expect(
      priceStructure(
        [leg("put", "sell", 100, 2.0), leg("put", "buy", 95)],
        100,
      ),
    ).toEqual({
      kind: "unpriced",
      reason: "Unpriced: put 95 has no mid",
    });
  });

  it("returns unpriced for a multi-expiry structure rather than mispricing it", () => {
    const far: Leg = {
      right: "put",
      action: "buy",
      strike: 95,
      expiry: "2026-10-30",
      mid: 1.1,
    };
    expect(priceStructure([leg("put", "sell", 100, 2.0), far], 100)).toEqual({
      kind: "unpriced",
      reason:
        "Unpriced: multiple expiries, cannot compute a single payoff at expiry",
    });
  });

  it("computes the +/-5/10/20% expiry P&L row against the given spot", () => {
    const priced = priceStructure(
      [leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)],
      100,
    );
    if (priced.kind !== "priced") throw new Error("expected priced");
    expect(priced.pnlAt.map((p) => [p.pct, p.spot, p.pnl])).toEqual([
      // spot 80 and 90: below the long strike, spread at full width -> -380
      [-20, 80, -380],
      [-10, 90, -380],
      // spot 95: at the long strike, still full width -> -380
      [-5, 95, -380],
      // spot 105, 110, 120: both puts expire worthless -> keep the credit
      [5, 105, 120],
      [10, 110, 120],
      [20, 120, 120],
    ]);
  });

  it("reports an unbounded max gain as null rather than as a number", () => {
    // A lone long call is not something this tenant proposes, but the engine
    // must say "unbounded" instead of quietly reporting a far evaluation point
    // as if it were the maximum.
    const priced = priceStructure([leg("call", "buy", 100, 3.0)], 100);
    expect(priced).toMatchObject({
      kind: "priced",
      maxGain: null,
      maxLoss: 300,
    });
  });
});

describe("width", () => {
  it("is the widest strike span, per share", () => {
    expect(
      width([leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)]),
    ).toBe(5);
  });
});

describe("scheduleTimeLabel", () => {
  // The bug this exists to close: the 2026-09-03 premarket schedule table
  // showed "2026-09-03T19:00:00Z / 15:00 ET" — both the ISO and the ET the
  // model had already converted, side by side. 19:00 UTC on 2026-09-03 is
  // 15:00 ET (EDT, UTC-4 in September).
  it("renders only the ET part when a full ISO utc is present", () => {
    expect(
      scheduleTimeLabel({ utc: "2026-09-03T19:00:00Z", et: "15:00 ET" }),
    ).toBe("15:00 ET");
  });

  it("derives ET from utc via the IANA zone even when the model wrote no et", () => {
    expect(scheduleTimeLabel({ utc: "2026-09-03T19:00:00Z" })).toBe("15:00 ET");
  });

  it("derives ET from utc across the DST boundary (January, EST, UTC-5)", () => {
    expect(scheduleTimeLabel({ utc: "2026-01-15T19:00:00Z" })).toBe("14:00 ET");
  });

  it("falls back to the model's own et string when utc does not parse", () => {
    // The real 2026-09-03 regime step wrote abbreviated "HH:MMZ" utc values
    // ("12:30Z"), not full ISO — Date.parse cannot resolve those to an
    // instant, so the model's own et string is trusted as written.
    expect(scheduleTimeLabel({ utc: "12:30Z", et: "08:30 ET" })).toBe(
      "08:30 ET",
    );
  });

  it("appends ET to a fallback et string that lacks it", () => {
    expect(scheduleTimeLabel({ et: "08:30" })).toBe("08:30 ET");
  });

  it("is empty when neither utc nor et is present", () => {
    expect(scheduleTimeLabel({})).toBe("");
  });
});

describe("formatScheduleMagnitude", () => {
  // Employment Report row, 2026-09-03 premarket briefing: payrolls forecast
  // 50000, prior -23000.
  it("formats a positive thousands value with a k suffix and a leading plus", () => {
    expect(formatScheduleMagnitude("50000")).toBe("+50k");
  });

  it("formats a negative thousands value with a real minus sign and a k suffix", () => {
    expect(formatScheduleMagnitude("-23000")).toBe("−23k");
  });

  it("leaves a percentage untouched", () => {
    expect(formatScheduleMagnitude("4.1%")).toBe("4.1%");
  });

  it("leaves a non-numeric raw string untouched", () => {
    expect(formatScheduleMagnitude("n/a")).toBe("n/a");
  });

  it("formats a sub-thousand integer without a k suffix", () => {
    expect(formatScheduleMagnitude("205")).toBe("+205");
  });
});

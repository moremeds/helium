/**
 * The `design-spot` output gate.
 *
 * The failure it exists for: across 42 runs the design step emitted proposals
 * in 24 without ever calling `ow_spot`, and the strikes were 15-84% away from
 * the traded price. The renderer's strike-band check runs after review and
 * fails open when no spot exists, so nothing mechanical caught it.
 *
 * Fixtures use real spot prices, frozen as-of 2026-09-02 (17:00 ET close),
 * read from a collected option-wizard run's GEX step
 * (`results/local/run-b94a72aa-24c9-4fde-9e69-3f95013059ce/briefing.md`):
 * NVDA 224.41, AAPL 324.96. The gate itself reads a spot from `ow_spot`'s own
 * `quotes[].last` shape, so these values are wrapped in that shape below
 * rather than the GEX table's — same traded price, the tool's own envelope.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-design-spot
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/design-spot.js";

const ctx = { runId: "run-1", role: "structure-designer" };

/** NVDA spot 2026-09-02: 224.41. */
const NVDA_SPOT_OUTPUT = JSON.stringify({
  source: "tradingview",
  quotes: [{ ticker: "NVDA", source: "tradingview", last: 224.41 }],
});

/** AAPL spot 2026-09-02: 324.96. */
const AAPL_SPOT_OUTPUT = JSON.stringify({
  source: "tradingview",
  quotes: [{ ticker: "AAPL", source: "tradingview", last: 324.96 }],
});

/** A defined-risk put spread with strikes close to the real NVDA spot
 *  (224.41): 220 is 1.97% off, 210 is 6.41% off — both inside the 25% band. */
const NVDA_NEAR_SPOT = {
  proposals: [
    {
      ticker: "NVDA",
      strategy: "bull put spread",
      legs: [
        {
          right: "P",
          expiry: "2026-10-16",
          strike: 220,
          action: "SELL",
          ratio: 1,
          mid: 3.15,
        },
        {
          right: "P",
          expiry: "2026-10-16",
          strike: 210,
          action: "BUY",
          ratio: 1,
          mid: 1.9,
        },
      ],
    },
  ],
};

/** Same shape, strikes written far from the real NVDA spot (224.41): 165 is
 *  26.46% off, over the 25% band — the exact class of miss that shipped
 *  15-84% off in the runs this gate exists for. */
const NVDA_FAR_FROM_SPOT = {
  proposals: [
    {
      ticker: "NVDA",
      strategy: "bull put spread",
      legs: [
        {
          right: "P",
          expiry: "2026-10-16",
          strike: 165,
          action: "SELL",
          ratio: 1,
          mid: 3.15,
        },
        {
          right: "P",
          expiry: "2026-10-16",
          strike: 160,
          action: "BUY",
          ratio: 1,
          mid: 1.9,
        },
      ],
    },
  ],
};

// The SPY `ow_argon_levels` row, exactly as the tool assembles it (see
// `tests/tools.spec.ts`'s "ow_argon_levels" describe block) from argon's real
// FastAPI response on the mac mini, frozen 2026-09-03 (technicals/live,
// dealer, gex) and 2026-09-02 (magnets). Reused verbatim rather than
// re-invented, so this gate's fixture and the tool's own frozen fixture can
// never quietly drift apart.
const SPY_LEVELS_ROW = {
  ticker: "SPY",
  spot: { value: 768.72, source: "technicals/live" },
  technical: {
    support: 725.43,
    resistance: 759.57,
    pivot_a: 759.57,
    pivot_b: 725.43,
    sma20: 768.976,
  },
  technicalAsOf: "2026-09-02",
  gamma: {
    gex_flip: 770.0,
    call_wall: 770.0,
    put_wall: 765.0,
    max_magnet: 770.0,
  },
  gammaAsOf: "2026-09-03",
  closest_levels: [
    {
      label: "Call Wall",
      role: "resistance",
      strike: 770.0,
      distance_pct: 0.0014827146684701848,
    },
    {
      label: "Gamma Flip",
      role: "flip",
      strike: 766.0,
      distance_pct: -0.0037197929401971926,
    },
  ],
  expected_range: { low: 762.99, high: 774.81 },
  as_of: "2026-09-03",
};

const SPY_LEVELS_OUTPUT = JSON.stringify({
  source: "argon",
  levels: [SPY_LEVELS_ROW],
});

describe("design-spot", () => {
  it("passes proposals whose strikes sit within 25% of the tool's own spot", async () => {
    const result = await gate.check(
      { text: JSON.stringify(NVDA_NEAR_SPOT) },
      {
        ...ctx,
        toolCalls: ["ow_uw_chain", "ow_spot"],
        stepToolOutputs: [NVDA_SPOT_OUTPUT],
      },
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("NVDA");
  });

  it("refuses a strike more than 25% from the tool's own spot, naming ticker/strike/spot/pct", async () => {
    const result = await gate.check(
      { text: JSON.stringify(NVDA_FAR_FROM_SPOT) },
      {
        ...ctx,
        toolCalls: ["ow_uw_chain", "ow_spot"],
        stepToolOutputs: [NVDA_SPOT_OUTPUT],
      },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("NVDA");
    expect(result.reason).toContain("165");
    expect(result.reason).toContain("224.41");
    expect(result.reason).toContain("26.5%");
  });

  it("refuses proposals written without a spot at all, naming the missing call", async () => {
    const result = await gate.check(
      { text: JSON.stringify(NVDA_NEAR_SPOT) },
      { ...ctx, toolCalls: ["ow_uw_chain"], stepToolOutputs: [] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("ow_spot");
    expect(result.reason).toContain("ow_uw_chain");
  });

  it("fails closed on a proposal whose ticker never appears in this step's ow_spot output", async () => {
    // ow_spot WAS called this step, but only for AAPL — the proposal is for
    // NVDA, so there is still no spot for the ticker actually being priced.
    // This is the case the renderer's downstream STRIKE_BAND check fails OPEN
    // on today: no spot found reads as "unchecked", not "refused".
    const result = await gate.check(
      { text: JSON.stringify(NVDA_NEAR_SPOT) },
      { ...ctx, toolCalls: ["ow_spot"], stepToolOutputs: [AAPL_SPOT_OUTPUT] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("NVDA");
    expect(result.reason).toContain("no spot");
  });

  it("passes the honest empty answer, which carries no strike at all", async () => {
    // `{"proposals":[],"reason":...}` is how the tenant says "no trade today".
    // Refusing it would turn a correct abstention into a risk violation.
    const result = await gate.check(
      {
        text: JSON.stringify({ proposals: [], reason: "no regime edge today" }),
      },
      { ...ctx, toolCalls: [], stepToolOutputs: [] },
    );
    expect(result.pass).toBe(true);
  });

  it("passes a short strike that sits on an ow_argon_levels level (SPY call_wall 770)", async () => {
    // Short leg on call_wall (770.0) exactly; the long (protective) leg at
    // 780 is off every level, but it is a LONG leg, so it does not hard-fail
    // the step — the level is what the short strike is meant to sit on.
    const proposal = {
      proposals: [
        {
          ticker: "SPY",
          strategy: "call credit spread",
          legs: [
            {
              right: "C",
              expiry: "2026-10-16",
              strike: 770,
              action: "sell",
              ratio: 1,
              mid: 2.1,
            },
            {
              right: "C",
              expiry: "2026-10-16",
              strike: 780,
              action: "buy",
              ratio: 1,
              mid: 0.9,
            },
          ],
        },
      ],
    };
    const result = await gate.check(
      { text: JSON.stringify(proposal) },
      {
        ...ctx,
        toolCalls: ["ow_argon_levels"],
        stepToolOutputs: [SPY_LEVELS_OUTPUT],
      },
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("SPY");
    expect(result.reason).toContain("770");
  });

  it("refuses a short strike off every level, naming ticker/strike/nearest level", async () => {
    // 700 sits nowhere near any SPY level in the frozen row: nearest is
    // technical.support at 725.43, 25.43 away — nowhere near the 0.5% band.
    const proposal = {
      proposals: [
        {
          ticker: "SPY",
          strategy: "put credit spread",
          legs: [
            {
              right: "P",
              expiry: "2026-10-16",
              strike: 700,
              action: "sell",
              ratio: 1,
              mid: 1.5,
            },
            {
              right: "P",
              expiry: "2026-10-16",
              strike: 690,
              action: "buy",
              ratio: 1,
              mid: 0.8,
            },
          ],
        },
      ],
    };
    const result = await gate.check(
      { text: JSON.stringify(proposal) },
      {
        ...ctx,
        toolCalls: ["ow_argon_levels"],
        stepToolOutputs: [SPY_LEVELS_OUTPUT],
      },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("SPY");
    expect(result.reason).toContain("700");
    expect(result.reason).toContain("725.43");
  });

  it("refuses a fabricated anchor that names no number ow_argon_levels returned", async () => {
    // Short strike 765 IS put_wall — a real, grounded strike — but the
    // proposal's own `anchor` names 750, a number the SPY row never returned
    // anywhere (nearest real level is put_wall/765, 15 away — well past the
    // 0.5% band). A grounded strike does not excuse a fabricated anchor.
    const proposal = {
      proposals: [
        {
          ticker: "SPY",
          strategy: "put credit spread",
          legs: [
            {
              right: "P",
              expiry: "2026-10-16",
              strike: 765,
              action: "sell",
              ratio: 1,
              mid: 1.8,
            },
            {
              right: "P",
              expiry: "2026-10-16",
              strike: 755,
              action: "buy",
              ratio: 1,
              mid: 1.0,
            },
          ],
          anchor: "made-up support near 750",
        },
      ],
    };
    const result = await gate.check(
      { text: JSON.stringify(proposal) },
      {
        ...ctx,
        toolCalls: ["ow_argon_levels"],
        stepToolOutputs: [SPY_LEVELS_OUTPUT],
      },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("anchor");
    expect(result.reason).toContain("750");
  });
});

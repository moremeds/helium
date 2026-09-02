/**
 * The preflight gate. `defined_risk` gets the weight here because it is the
 * only sub-gate that is fully computable without a network — and the fatal one.
 *
 * Fixture: AAPL, close 325.13, the last completed session as of 2026-09-02
 * (that day's Unusual Whales daily OHLC row is still `market_time: premarket`
 * and carries the 2026-09-01 close). Verified against the UW daily OHLC row on
 * 2026-09-02: open 324.66, high 325.36, low 324.05, close 325.13. Strikes sit
 * either side of that real close and 2026-10-16 is the real third-Friday
 * October monthly. `limitPrice` is a proposal parameter — what the order would
 * be sent at — and is deliberately NOT presented as an observed quote.
 */
import { describe, expect, it } from "vitest";
import gate, {
  canonicalJson,
  checkDefinedRisk,
  contentHash,
  evaluateProposal,
  extractProposals,
  type Proposal,
} from "../gates/ib-preflight.js";

const EXPIRY = "2026-10-16";
const LATER = "2026-11-20";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ticker: "AAPL",
    strategy: "put-credit-spread",
    legs: [
      { right: "P", expiry: EXPIRY, strike: 320, action: "SELL", ratio: 1 },
      { right: "P", expiry: EXPIRY, strike: 315, action: "BUY", ratio: 1 },
    ],
    quantity: 2,
    limitPrice: -1.35,
    rationale: "spot 325.13, last close as of 2026-09-02; short strike below spot",
    ...overrides,
  };
}

const CONFIGURED = {
  buying_power: { maxMarginFractionOfNetLiq: 0.1, minBuyingPowerUsd: 25000 },
  liquidity: { maxSpreadFractionOfMid: 0.08, minOpenInterest: 250 },
  event_window: { minDte: 21, maxDte: 60 },
  position_conflict: {
    maxPerUnderlyingFractionOfNetLiq: 0.05,
    maxPortfolioFractionOfNetLiq: 0.3,
  },
};

describe("defined_risk", () => {
  it("passes a vertical credit spread and reports max loss = width - credit", () => {
    const verdict = checkDefinedRisk(proposal());
    expect(verdict.pass).toBe(true);
    // (320 - 315 width - 1.35 credit) * 100 * 2 spreads
    expect(verdict.detail).toContain("730.00");
  });

  it("fails a naked short call", () => {
    const verdict = checkDefinedRisk(
      proposal({
        strategy: "short-call",
        legs: [{ right: "C", expiry: EXPIRY, strike: 340, action: "SELL", ratio: 1 }],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("uncovered short call");
  });

  it("fails a short put with no long put", () => {
    const verdict = checkDefinedRisk(
      proposal({
        strategy: "cash-secured-put",
        legs: [{ right: "P", expiry: EXPIRY, strike: 320, action: "SELL", ratio: 1 }],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("uncovered short put");
  });

  it("fails a ratio spread whose short ratio exceeds its long ratio", () => {
    const verdict = checkDefinedRisk(
      proposal({
        strategy: "put-ratio-spread",
        legs: [
          { right: "P", expiry: EXPIRY, strike: 320, action: "SELL", ratio: 2 },
          { right: "P", expiry: EXPIRY, strike: 315, action: "BUY", ratio: 1 },
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("short ratio 2 exceeds long ratio 1");
  });

  it("does not treat a long leg at a different expiry as cover", () => {
    const verdict = checkDefinedRisk(
      proposal({
        legs: [
          { right: "P", expiry: EXPIRY, strike: 320, action: "SELL", ratio: 1 },
          { right: "P", expiry: LATER, strike: 315, action: "BUY", ratio: 1 },
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain(EXPIRY);
  });

  it("fails a calendar spread, because its max loss needs a vol model not arithmetic", () => {
    const verdict = checkDefinedRisk(
      proposal({
        strategy: "call-calendar",
        legs: [
          { right: "C", expiry: EXPIRY, strike: 325, action: "SELL", ratio: 1 },
          { right: "C", expiry: LATER, strike: 325, action: "BUY", ratio: 1 },
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("uncovered short call");
  });

  it("fails an empty legs array", () => {
    const verdict = checkDefinedRisk(proposal({ legs: [] }));
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("no legs");
  });

  it("passes an iron condor: two covered verticals at the same expiry", () => {
    const verdict = checkDefinedRisk(
      proposal({
        strategy: "iron-condor",
        quantity: 1,
        limitPrice: -2.1,
        legs: [
          { right: "P", expiry: EXPIRY, strike: 310, action: "BUY", ratio: 1 },
          { right: "P", expiry: EXPIRY, strike: 315, action: "SELL", ratio: 1 },
          { right: "C", expiry: EXPIRY, strike: 340, action: "SELL", ratio: 1 },
          { right: "C", expiry: EXPIRY, strike: 345, action: "BUY", ratio: 1 },
        ],
      }),
    );
    expect(verdict.pass).toBe(true);
    // The payoff is minimised over the whole expiry group at once, so only the
    // one wing that can finish in the money counts: (5 width - 2.10 credit) * 100.
    // Loss is only summed ACROSS expiries, where no single price exists.
    expect(verdict.detail).toContain("290.00");
  });
});

describe("contentHash", () => {
  it("is stable under key reordering", () => {
    const a = proposal();
    const reordered = {
      rationale: a.rationale,
      limitPrice: a.limitPrice,
      quantity: a.quantity,
      legs: a.legs.map((leg) => ({
        ratio: leg.ratio,
        action: leg.action,
        strike: leg.strike,
        expiry: leg.expiry,
        right: leg.right,
      })),
      strategy: a.strategy,
      ticker: a.ticker,
    };
    expect(contentHash(reordered)).toBe(contentHash(a));
  });

  it("changes when a strike changes", () => {
    const moved = proposal();
    moved.legs[0] = { ...moved.legs[0]!, strike: 322.5 };
    expect(contentHash(moved)).not.toBe(contentHash(proposal()));
  });

  it("canonicalises without whitespace and with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});

describe("unconfigured thresholds", () => {
  it("refuses each live sub-gate by name when its limits are absent", () => {
    const result = evaluateProposal(proposal(), {});
    expect(result.pass).toBe(false);
    expect(result.gates.defined_risk.pass).toBe(true);
    expect(result.gates.buying_power.detail).toContain(
      "extensions.gates.buying_power.maxMarginFractionOfNetLiq",
    );
    expect(result.gates.liquidity.detail).toContain("extensions.gates.liquidity.minOpenInterest");
    expect(result.gates.event_window.detail).toContain("extensions.gates.event_window.minDte");
    expect(result.gates.position_conflict.detail).toContain(
      "extensions.gates.position_conflict.maxPortfolioFractionOfNetLiq",
    );
  });

  it("still refuses once configured, naming the missing IB data rather than passing", () => {
    const result = evaluateProposal(proposal(), CONFIGURED);
    expect(result.pass).toBe(false);
    for (const id of ["buying_power", "liquidity", "event_window", "position_conflict"] as const) {
      expect(result.gates[id].pass).toBe(false);
      expect(result.gates[id].detail).toContain("TWS wire protocol is not implemented");
      expect(result.gates[id].detail).not.toContain("unconfigured");
    }
  });
});

describe("the gate itself", () => {
  it("is an output gate on the two proposal-emitting roles", () => {
    expect(gate.id).toBe("ib-preflight");
    expect(gate.phase).toBe("output");
    expect(gate.appliesTo).toEqual(["structure-designer", "risk-reviewer"]);
  });

  it("refuses output it cannot parse a proposal out of", async () => {
    await expect(gate.check({ text: "no JSON here" }, { runId: "r", role: "risk-reviewer" }))
      .resolves.toMatchObject({ pass: false });
    expect(extractProposals({ text: "{}" }).error).toBe("no proposal found in role output");
  });

  it("names the content hash and the failing sub-gate in its reason", async () => {
    const verdict = await gate.check(
      { structured: { proposals: [proposal({ legs: [] })] } },
      { runId: "r", role: "structure-designer" },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain(contentHash(proposal({ legs: [] })));
    expect(verdict.reason).toContain("defined_risk: no legs");
  });
});

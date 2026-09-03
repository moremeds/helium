/**
 * The preflight gate. `defined_risk` gets the weight here because it is the
 * only sub-gate that is fully computable without a network — and the fatal one.
 *
 * Fixture: AAPL, close 325.13, the last completed session as of 2026-09-02
 * (that day's Unusual Whales daily OHLC row is still `market_time: premarket`
 * and carries the 2026-09-01 close). Verified against the UW daily OHLC row on
 * 2026-09-02: open 324.66, high 325.36, low 324.05, close 325.13. Strikes sit
 * either side of that real close and 2026-10-16 is the real third-Friday
 * October monthly. The AAPL fixture carries NO `mid`, which is the structural
 * case: coverage is decided from the legs alone and needs no quote.
 *
 * The priced cases use SPY 2026-09-30 750/720 puts at the NBBO mids 4.92 and
 * 2.02 that ow_uw_chain returned on 2026-09-02 (run-ec962c3e). Those two mids
 * are observed; which way round the test buys and sells them is the test's own
 * construction.
 */
import { describe, expect, it } from "vitest";
import gate, {
  canonicalJson,
  checkDefinedRisk,
  contentHash,
  evaluateProposal,
  ProposalSchema,
  extractProposals,
  unfence,
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
  it("passes an unpriced vertical on structure alone, and says the loss is unpriced", () => {
    // The regression this pins: the gate used to REQUIRE quantity and
    // limitPrice, so once the designer stopped emitting them every proposal was
    // refused as malformed and the reader got an empty brief with a gate error
    // where the trades belonged (run-ec962c3e, 2026-09-02).
    const verdict = checkDefinedRisk(proposal());
    expect(verdict.pass).toBe(true);
    expect(verdict.detail).toContain("unpriced");
  });

  it("prices max loss per contract from the leg mids — debit spread", () => {
    const verdict = checkDefinedRisk(
      proposal({
        ticker: "SPY",
        strategy: "put-debit-spread",
        legs: [
          { right: "P", expiry: EXPIRY, strike: 750, action: "BUY", ratio: 1, mid: 4.92 },
          { right: "P", expiry: EXPIRY, strike: 720, action: "SELL", ratio: 1, mid: 2.02 },
        ],
      }),
    );
    expect(verdict.pass).toBe(true);
    // A debit spread can lose only the debit: (4.92 - 2.02) * 100.
    expect(verdict.detail).toContain("290.00 USD per contract");
  });

  it("prices max loss per contract from the leg mids — credit spread", () => {
    const verdict = checkDefinedRisk(
      proposal({
        ticker: "SPY",
        strategy: "put-credit-spread",
        legs: [
          { right: "P", expiry: EXPIRY, strike: 750, action: "SELL", ratio: 1, mid: 4.92 },
          { right: "P", expiry: EXPIRY, strike: 720, action: "BUY", ratio: 1, mid: 2.02 },
        ],
      }),
    );
    expect(verdict.pass).toBe(true);
    // Width 30 less the 2.90 credit, per contract — and never per position:
    // nothing here knows the account, so there is no quantity to multiply by.
    expect(verdict.detail).toContain("2710.00 USD per contract");
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
        legs: [
          { right: "P", expiry: EXPIRY, strike: 310, action: "BUY", ratio: 1 },
          { right: "P", expiry: EXPIRY, strike: 315, action: "SELL", ratio: 1 },
          { right: "C", expiry: EXPIRY, strike: 340, action: "SELL", ratio: 1 },
          { right: "C", expiry: EXPIRY, strike: 345, action: "BUY", ratio: 1 },
        ],
      }),
    );
    expect(verdict.pass).toBe(true);
    // Both wings are covered, so the structure passes; unpriced because the
    // fixture quotes no mids. Loss is only summed ACROSS expiries, where no
    // single price exists.
    expect(verdict.detail).toContain("unpriced");
  });
});

describe("contentHash", () => {
  it("is stable under key reordering", () => {
    const a = proposal();
    const reordered = {
      rationale: a.rationale,
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
  it("reports each live sub-gate by name when its limits are absent, without sinking the proposal", () => {
    // Unchecked is not failed. Nothing here can place an order — the tenant
    // registers no such tool and the IB credential is refused on every write
    // path — so refusing a daily READ on limits nobody has set would refuse
    // every proposal for the same four reasons every morning.
    const result = evaluateProposal(proposal(), {});
    expect(result.pass).toBe(true);
    expect(result.unchecked).toEqual([
      "buying_power",
      "liquidity",
      "event_window",
      "position_conflict",
    ]);
    expect(result.gates.buying_power.state).toBe("unchecked");
    expect(result.gates.defined_risk.state).toBe("pass");
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

  it("stays unchecked once configured, naming the missing IB data rather than claiming a pass", () => {
    const result = evaluateProposal(proposal(), CONFIGURED);
    for (const id of ["buying_power", "liquidity", "event_window", "position_conflict"] as const) {
      expect(result.gates[id].state).toBe("unchecked");
      expect(result.gates[id].pass).toBe(false);
      expect(result.gates[id].detail).toContain("TWS wire protocol is not implemented");
      expect(result.gates[id].detail).not.toContain("no limit configured");
    }
  });

  it("still fails hard on a naked short, configured or not", () => {
    // The one invariant that needs neither a threshold nor a network, and the
    // one the three-state change must not have loosened.
    const naked = proposal({
      legs: [{ right: "C", expiry: "2026-10-16", strike: 330, action: "SELL", ratio: 1 }],
    });
    for (const thresholds of [{}, CONFIGURED]) {
      const result = evaluateProposal(naked, thresholds);
      expect(result.pass).toBe(false);
      expect(result.gates.defined_risk.state).toBe("fail");
    }
  });
});

describe("the gate itself", () => {
  it("is an output gate on the two proposal-emitting roles", () => {
    expect(gate.id).toBe("ib-preflight");
    expect(gate.phase).toBe("output");
    expect(gate.appliesTo).toEqual(["structure-designer", "risk-reviewer"]);
  });

  it("reports output it cannot parse a proposal out of, without refusing it", async () => {
    // The gate has no verdict to give when nothing was read out of the output.
    // The "formatting is not a safety verdict" block below makes the argument.
    const verdict = await gate.check(
      { text: "no JSON here" },
      { runId: "r", role: "risk-reviewer" },
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toContain("UNCHECKED");
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

describe("unfence", () => {
  it("leaves bare JSON alone", () => {
    expect(unfence('{"proposals":[]}')).toBe('{"proposals":[]}');
  });

  it("strips the fence a model adds despite being told not to", () => {
    expect(unfence('```json\n{"proposals":[]}\n```')).toBe('{"proposals":[]}');
    expect(unfence('```\n{"proposals":[]}\n```')).toBe('{"proposals":[]}');
  });

  it("takes a fenced block that a preamble sits in front of", () => {
    // A whole live run failed `role output is not JSON` because the designer
    // wrote two sentences before the exact object it was asked for. The fence
    // is the model marking its answer; the prose beside it is commentary.
    expect(
      unfence('IB is unavailable. Given that:\n\n```json\n{"proposals":[]}\n```'),
    ).toBe('{"proposals":[]}');
  });

  it("does not scrape bare JSON out of prose", () => {
    // With no fence there is no mark saying which braces are the answer, and a
    // worked EXAMPLE of a trade would get lifted and gated as a real one.
    expect(() => JSON.parse(unfence('Here you go:\n{"proposals":[]}'))).toThrow();
  });
});

describe("leg vocabulary", () => {
  it("accepts the words a model actually writes and normalises them", () => {
    // Refusing "call"/"buy" is refusing on vocabulary. A whole live run's
    // proposals were rejected for it while the structures themselves were fine.
    const parsed = ProposalSchema.parse({
      ...proposal(),
      legs: [
        { right: "put", expiry: "2026-10-16", strike: 320, action: "buy", ratio: 1 },
        { right: "Put", expiry: "2026-10-16", strike: 330, action: "SELL", ratio: 1 },
      ],
    });
    expect(parsed.legs.map((leg) => [leg.right, leg.action])).toEqual([
      ["P", "BUY"],
      ["P", "SELL"],
    ]);
  });

  it("still refuses a right that is neither", () => {
    expect(
      ProposalSchema.safeParse({
        ...proposal(),
        legs: [{ right: "future", expiry: "2026-10-16", strike: 1, action: "buy", ratio: 1 }],
      }).success,
    ).toBe(false);
  });
});

/**
 * Formatting defects and safety defects are different things, and only one of
 * them is this gate's business.
 *
 * Two live runs on 2026-09-02 died on the first kind: `legs.1.mid: expected
 * number, received string` (six sibling proposals were fine) and `role output is
 * not JSON` (the role wrote prose, so nothing was ever checked). A gate can only
 * answer pass/fail — it cannot drop a proposal from the report — so refusing on
 * a formatting defect withholds nothing and costs the whole briefing. What it
 * CAN do is say plainly which proposals it never judged.
 *
 * Fixtures are the ones the rest of this file uses: the AAPL 320/315 puts around
 * the real 325.13 close, and the SPY 750/720 puts at the NBBO mids 4.92 and 2.02
 * that ow_uw_chain returned on 2026-09-02 (run-ec962c3e) — here written the way
 * a model actually wrote them, in quotes.
 */
describe("formatting is not a safety verdict", () => {
  const SPY_STRING_MIDS = {
    ticker: "SPY",
    strategy: "put-debit-spread",
    legs: [
      { right: "P", expiry: EXPIRY, strike: 750, action: "BUY", ratio: 1, mid: "4.92" },
      { right: "P", expiry: EXPIRY, strike: 720, action: "SELL", ratio: 1, mid: "2.02" },
    ],
    rationale: "debit spread; max loss is the debit",
  };

  const UNPARSEABLE = {
    ...proposal(),
    ticker: "NVDA",
    legs: [{ ...proposal().legs[0], strike: "three-twenty" }],
  };

  const NAKED_CALL = proposal({
    strategy: "short-call",
    legs: [{ right: "C", expiry: EXPIRY, strike: 340, action: "SELL", ratio: 1 }],
  });

  it("parses a mid the model quoted as a string, and prices the spread from it", () => {
    const parsed = ProposalSchema.parse(SPY_STRING_MIDS);
    expect(parsed.legs.map((leg) => leg.mid)).toEqual([4.92, 2.02]);
    // Parsing is the point: a proposal that parses is one whose defined-risk
    // maths actually runs, instead of one nobody ever looked at.
    const verdict = checkDefinedRisk(parsed);
    expect(verdict.pass).toBe(true);
    expect(verdict.detail).toContain("290.00 USD per contract");
  });

  it("does not silently default a mid that is not a number in disguise", () => {
    // Coercion is typography only. "n/a" is not 0 and must never become it.
    const result = ProposalSchema.safeParse({
      ...SPY_STRING_MIDS,
      legs: [{ ...SPY_STRING_MIDS.legs[0], mid: "n/a" }, SPY_STRING_MIDS.legs[1]],
    });
    expect(result.success).toBe(false);
  });

  it("parses a proposal with no rationale, and evaluates it", () => {
    const { rationale: _dropped, ...withoutRationale } = proposal();
    const parsed = ProposalSchema.safeParse(withoutRationale);
    expect(parsed.success).toBe(true);
    // No sub-gate reads the prose, so its absence must not stop the maths.
    expect(evaluateProposal(ProposalSchema.parse(withoutRationale), {}).pass).toBe(true);
  });

  it("does not fail the step for a proposal it could not parse, and names it unchecked", async () => {
    const verdict = await gate.check(
      { structured: { proposals: [proposal(), UNPARSEABLE] } },
      { runId: "r", role: "structure-designer" },
    );
    expect(verdict.pass).toBe(true);
    // The reader must not be able to read this pass as "NVDA is safe".
    expect(verdict.reason).toContain("UNCHECKED");
    expect(verdict.reason).toContain("(NVDA)");
    expect(verdict.reason).toContain("does not cover it");
    // And the sibling that WAS readable still got its verdict.
    expect(verdict.reason).toContain("AAPL put-credit-spread");
    expect(verdict.reason).toContain("PASS");
  });

  it("does not fail the step when the role wrote prose instead of JSON", async () => {
    const verdict = await gate.check(
      {
        text:
          "IB Gateway was unreachable this morning, so I could not price the AAPL " +
          "2026-10-16 320/315 put spread. No proposals today.",
      },
      { runId: "r", role: "structure-designer" },
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toContain("role output is not JSON");
    expect(verdict.reason).toContain("NONE was checked");
  });

  it("STILL fails the step on an uncovered short call", async () => {
    // The test that proves the gate was not hollowed out. This is the refusal a
    // live run produced, and it stays a refusal: no naked shorts, ever.
    const verdict = await gate.check(
      { structured: { proposals: [NAKED_CALL] } },
      { runId: "r", role: "structure-designer" },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain(
      `defined_risk: uncovered short call at ${EXPIRY}: short ratio 1 exceeds long ratio 0`,
    );
  });

  it("fails the step on an unsafe proposal even when a sibling was unparseable", async () => {
    // A formatting defect never masks a safety defect: one unchecked proposal
    // beside one that genuinely failed is still a failed step.
    const verdict = await gate.check(
      { structured: { proposals: [UNPARSEABLE, NAKED_CALL] } },
      { runId: "r", role: "structure-designer" },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("UNCHECKED");
    expect(verdict.reason).toContain("uncovered short call");
  });
});

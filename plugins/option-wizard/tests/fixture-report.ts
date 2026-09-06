/**
 * `invalidation` is the fixture's own addition — the field did not exist on
 * 2026-09-02. The SPY and TLT `strategy` strings are corrected from the run's
 * own `put_debit_spread_hedge` to `put_credit_spread_hedge`: both are long the
 * LOWER put and short the higher one, which is a credit spread, and the
 * renderer had already been computing SPY's net as a +1.28 credit while the
 * name said debit. QQQ keeps the debit name because QQQ's legs really are one.
 * The legs themselves are untouched. Each level is one of the proposal's OWN strikes, already in this
 * file and unchanged from the run; no market value is invented or implied.
 *
 * Fixture built from the real successful run of 2026-09-02 (`run-84a83ad2`):
 * the review step's JSON, verbatim except for the `mid` fields, which that run
 * did not yet carry and which are taken from the same proposals' own quoted
 * bid/ask. Prose trimmed; tickers, strikes and expiries untouched.
 *
 * `quantity` and `limitPrice` are kept here on purpose even though Task 6 takes
 * them out of the designer's schema: this fixture is the proof that a proposal
 * in the OLD shape still renders, with those fields ignored rather than
 * rejected. Do not tidy them away.
 *
 * Extracted from `render.spec.ts` so that more than one suite can render the
 * SAME real run: `brief-view-fixture.spec.ts` regenerates the committed
 * `contracts/brief-view-v2.fixture.json` from it, and a fixture argon tests
 * against must come out of the real producer rather than out of a second
 * hand-written copy of the shape.
 * @module dsh-plugin-tenant-option-wizard/tests/fixture-report
 */
import type { RunReport, TenantSpec } from "@helium/core";

export const REVIEW_JSON = {
  proposals: [
    {
      ticker: "SPY",
      invalidation: [{ level: 750, side: "above" }],
      // `target` and `thesis` are this fixture's own additions, on the same
      // terms as `invalidation` above: the level is one of THIS proposal's own
      // strikes and the sentence is its own `rationale`, so no market value is
      // invented. Only SPY carries them — QQQ and TLT are left as the run wrote
      // them, which is what keeps a candidate with no typed target in the
      // fixture argon renders against.
      target: { level: 740, side: "below" },
      thesis: "Defensive hedge aligned with bearish-tilt regime.",
      strategy: "put_credit_spread_hedge",
      legs: [
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 740,
          action: "buy",
          ratio: 1,
          mid: 5.14,
        },
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 750,
          action: "sell",
          ratio: 1,
          mid: 6.42,
        },
      ],
      quantity: 5,
      limitPrice: 3.8,
      rationale: "Defensive hedge aligned with bearish-tilt regime.",
    },
    {
      ticker: "QQQ",
      invalidation: [{ level: 695, side: "above" }],
      strategy: "put_debit_spread_hedge",
      legs: [
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 695,
          action: "buy",
          ratio: 1,
          mid: 9.57,
        },
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 680,
          action: "sell",
          ratio: 1,
          mid: 6.26,
        },
      ],
      quantity: 4,
      limitPrice: 5.75,
      rationale:
        "Tech hedge: elevated IV rank (24%), sensitive to yield moves.",
    },
    {
      ticker: "TLT",
      invalidation: [{ level: 81, side: "above" }],
      strategy: "put_credit_spread_hedge",
      legs: [
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 80,
          action: "buy",
          ratio: 1,
        },
        {
          right: "put",
          expiry: "2026-09-30",
          strike: 81,
          action: "sell",
          ratio: 1,
          mid: 0.56,
        },
      ],
      quantity: 2,
      limitPrice: 0.22,
      rationale: "Bond duration hedge: minimal cost insurance.",
    },
  ],
  riskList: [
    {
      ticker: "GLD",
      reason:
        "Call spread income overlay creates portfolio concentration in GLD.",
    },
  ],
};

export const REGIME_TEXT = `# Regime Verdict — as of 2026-09-02

**Direction bias: cautiously risk-off / defensive.** The whole Treasury curve is live-bid today — 2y at **4.371%**, 10y **4.772%**.

**Volatility stance: neutral-to-firming, cheap but rising.** VIX is live **16.02** today.

**Hedge posture: keep hedges on, modest.** Credit is still calm.`;

/** The reviewer answers with prose first and a fenced JSON object after; that is
 *  what the live run produced and what the parser has to survive. */
export const REVIEW_TEXT = `Now I'll evaluate each proposal against the spot prices:

**SPY (spot 761.78):** Both strikes are 2.9-3.8% below spot.

Actually, let me simplify the selection.

\`\`\`json
${JSON.stringify(REVIEW_JSON, null, 2)}
\`\`\``;

export const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

export function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run-84a83ad2-a5cd-49d9-b41d-1fbc55236128",
    tenant: "option-wizard",
    // The run label the runner started this run with. It reaches the renderer
    // for exactly one purpose: the id segment that keeps the close run's
    // proposals from being confused with the morning's.
    phase: "premarket",
    // The day the RUNNER resolved, in the tenant's reportTimezone
    // (America/New_York). A run fired 2026-09-03T02:40+08:00 is 14:40 on the
    // 2nd in ET, and the brief is about the 2nd.
    day: "2026-09-02",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: ["ow_macro_rates (OW_ARGON_PG_URL unset)"],
    steps: [
      {
        task: "universe",
        role: "universe-builder",
        mode: "deterministic",
        text: "SPY QQQ TLT",
      },
      {
        task: "regime",
        role: "regime-analyst",
        mode: "model",
        text: REGIME_TEXT,
      },
      { task: "design", role: "structure-designer", mode: "model", text: "{}" },
      {
        task: "review",
        role: "risk-reviewer",
        mode: "model",
        text: REVIEW_TEXT,
      },
    ],
    ...overrides,
  } as RunReport;
}

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
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import renderReport, { buildView } from "../render/index.js";
import { renderText } from "../render/text.js";
import { renderHtml } from "../render/html.js";
import type { BriefView } from "../render/index.js";

const REVIEW_JSON = {
  proposals: [
    {
      ticker: "SPY",
      invalidation: [{ level: 750, side: "above" }],
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

const REGIME_TEXT = `# Regime Verdict — as of 2026-09-02

**Direction bias: cautiously risk-off / defensive.** The whole Treasury curve is live-bid today — 2y at **4.371%**, 10y **4.772%**.

**Volatility stance: neutral-to-firming, cheap but rising.** VIX is live **16.02** today.

**Hedge posture: keep hedges on, modest.** Credit is still calm.`;

/** The reviewer answers with prose first and a fenced JSON object after; that is
 *  what the live run produced and what the parser has to survive. */
const REVIEW_TEXT = `Now I'll evaluate each proposal against the spot prices:

**SPY (spot 761.78):** Both strikes are 2.9-3.8% below spot.

Actually, let me simplify the selection.

\`\`\`json
${JSON.stringify(REVIEW_JSON, null, 2)}
\`\`\``;

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run-84a83ad2-a5cd-49d9-b41d-1fbc55236128",
    tenant: "option-wizard",
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

describe("buildView", () => {
  it("parses the fenced JSON out of the reviewer's prose", () => {
    const view = buildView(report(), SPEC);
    expect(view.candidates.map((c) => c.ticker)).toEqual(["SPY", "QQQ", "TLT"]);
    expect(view.riskList).toEqual([
      {
        ticker: "GLD",
        reason:
          "Call spread income overlay creates portfolio concentration in GLD.",
      },
    ]);
  });

  it("prices the SPY spread from the mids, not from the role's limitPrice", () => {
    // sell 750P @6.42 / buy 740P @5.14 -> net +1.28 credit, width 10.
    // max gain 128, max loss (10 - 1.28) x 100 = 872, breakeven 748.72.
    // The role called this a debit spread and wrote limitPrice 3.80; both are
    // wrong, and neither reaches the reader.
    const spy = buildView(report(), SPEC).candidates[0]!;
    expect(spy.pricing).toMatchObject({
      kind: "priced",
      net: 1.28,
      maxGain: 128,
      maxLoss: 872,
      breakevens: [748.72],
    });
  });

  it("marks a leg with no mid as unpriced instead of estimating it", () => {
    const tlt = buildView(report(), SPEC).candidates[2]!;
    expect(tlt.pricing).toEqual({
      kind: "unpriced",
      reason: "Unpriced: put 80 has no mid",
    });
  });

  it("takes the regime verdict paragraph and the three stances", () => {
    const view = buildView(report(), SPEC).regime;
    expect(view.paragraph).toContain("Direction bias: cautiously risk-off");
    expect(view.direction).toBe("cautiously risk-off / defensive");
    expect(view.volatility).toBe("neutral-to-firming, cheap but rising");
    expect(view.hedge).toBe("keep hedges on, modest");
  });

  it("dates the brief with the run's report day, one date in one zone", () => {
    // Two dates in two zones was the reader doing a conversion the harness had
    // already done, and it is the same conversion the model got wrong in prose.
    const view = buildView(report(), SPEC);
    expect(view.date).toBe("2026-09-02");
  });

  it("computes DTE from the expiry against the ET date", () => {
    expect(buildView(report(), SPEC).candidates[0]!.dte).toBe(28);
  });

  it("measures the payoff row in % only where a TOOL quoted the spot", () => {
    // ow_spot priced SPY and nothing else. A "-20%" on QQQ would have been 20%
    // below its own lowest STRIKE — arithmetic off a price nobody stated, and
    // in the first live brief every sampled point then fell outside the spread,
    // printing max-gain three times and max-loss three times. Without a spot
    // the columns are the strikes themselves.
    //
    // The anchor is the TOOL's number, never the reviewer's prose: the prose
    // "(spot 761.78)" is the model's transcription of this same quote, and 8 of
    // 11 model-written numbers audited on 09-02/09-03 were wrong.
    const view = buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: REVIEW_TEXT,
            toolOutputs: [
              JSON.stringify({
                quotes: [
                  { ticker: "SPY", source: "tradingview", last: 761.78 },
                ],
              }),
            ],
          },
        ],
      } as never),
      SPEC,
    );
    const spy = view.candidates[0]!.pricing;
    const qqq = view.candidates[1]!.pricing;
    if (spy.kind !== "priced" || qqq.kind !== "priced")
      throw new Error("priced");
    expect(spy.pnlAt.map((point) => point.pct)).toEqual([
      -20, -10, -5, 5, 10, 20,
    ]);
    expect(spy.pnlAt[0]!.spot).toBe(609.42);
    expect(qqq.pnlAt.every((point) => point.pct === null)).toBe(true);
    expect(qqq.pnlAt.map((point) => point.spot)).toEqual([680, 695]);
  });

  it("never shows toolsUnconfigured, which is a known false positive", () => {
    expect(buildView(report(), SPEC).degradation).toBeUndefined();
  });

  it("says so in one line when a gate or a provider actually failed", () => {
    const view = buildView(
      report({
        providersSkipped: [{ id: "local-llm", reason: "no credential" }],
        gatesSkipped: [{ id: "ib-preflight", reason: "module threw" }],
      }),
      SPEC,
    );
    expect(view.degradation).toBe(
      "Data degraded: provider local-llm unavailable (no credential); gate ib-preflight not loaded (module threw)",
    );
  });

  it("a failed run still carries the steps that finished, under a banner", () => {
    // Voiding the whole brief over one refused step is the same single-point
    // failure the tenant is forbidden to have. 2026-09-02 intraday: a stale
    // IB timestamp refused the regime gate and emptied a brief whose drift
    // step had already answered the only question that brief exists for.
    const view = buildView(
      report({
        outcome: "failed",
        failure: { class: "budget-exhausted", detail: "no room" },
      }),
      SPEC,
    );
    expect(view.outcome).toBe("FAILED");
    expect(view.empty).toBeUndefined();
    expect(view.sections[0]).toEqual({
      title: "This run did not finish",
      body: "budget-exhausted — no room",
    });
    expect(view.sections.length).toBeGreaterThan(1);
  });

  it("falls back to 今日无候选 only when the failed run produced nothing", () => {
    const view = buildView(
      report({
        outcome: "failed",
        failure: { class: "budget-exhausted", detail: "no room" },
        steps: [],
      } as never),
      SPEC,
    );
    expect(view.empty).toBe("No candidates today: budget-exhausted — no room");
  });

  it("returns 今日无候选 when no model ran", () => {
    const view = buildView(
      report({ mode: "tool-only", providersLive: [] }),
      SPEC,
    );
    expect(view.outcome).toBe("DEGRADED");
    expect(view.empty).toBe(
      "No candidates today: no provider available, no model reasoning ran",
    );
  });

  it("keeps the narrative when the review step's JSON cannot be parsed", () => {
    const broken = report();
    broken.steps[3]!.text = "I could not produce proposals today.";
    const view = buildView(broken, SPEC);
    expect(view.empty).toBeUndefined();
    expect(view.candidates).toEqual([]);
    expect(view.sections.length).toBeGreaterThan(0);
  });

  it("says 今日无候选 only when the reviewer failed AND nothing else was written", () => {
    const bare = report({
      steps: [
        {
          task: "review",
          role: "risk-reviewer",
          mode: "model",
          text: "no proposals today",
        },
      ],
    } as never);
    expect(buildView(bare, SPEC).empty).toBe(
      "No candidates today: the review step had no parseable JSON",
    );
  });

  it("renders a phase that has no review step at all", () => {
    // intraday reports drift, weekly settles a week, frank compares two
    // documents. None of them propose anything, and treating "has candidates"
    // as a synonym for "has content" emptied three of the five briefs.
    const drift = report({
      steps: [
        {
          task: "drift",
          role: "drift-watcher",
          mode: "model",
          text: '{"sections":[{"title":"读数结论：无变化","body":"六个价格逐位一致。"}]}',
        },
      ],
    } as never);
    const view = buildView(drift, SPEC);
    expect(view.empty).toBeUndefined();
    expect(view.sections.map((s) => s.title)).toEqual(["读数结论：无变化"]);
    expect(renderText(view)).toContain("【读数结论：无变化】");
  });

  it("names the real reason when a run with no review step produced nothing", () => {
    const nothing = report({
      steps: [
        {
          task: "frank",
          role: "frank-comparator",
          mode: "model",
          text: "I cannot complete this task.",
        },
      ],
    } as never);
    // "review 步骤没有可解析的 JSON" would be a lie: the frank phase has no
    // review step to fail.
    expect(buildView(nothing, SPEC).empty).toBe("This run produced no blocks");
  });
});

describe("deterministic gates over what the tools answered", () => {
  /** One NVDA leg, so the fixtures below differ only in expiry. */
  const leg = (expiry: string) => ({
    right: "call",
    expiry,
    strike: 200,
    action: "sell",
    ratio: 1,
    mid: 4.2,
  });
  const nvda = (expiry: string) => ({
    ticker: "NVDA",
    invalidation: [{ level: 200, side: "above" }],
    strategy: "covered_call",
    legs: [leg(expiry)],
    rationale: "premium against a held position",
  });

  it("drops a candidate whose expiry spans the earnings date the tool returned", () => {
    // NVDA's next print, verified live 2026-09-03 against
    // GET /api/stock/NVDA/info: next_earnings_date "2026-11-18".
    const view = buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify({
              proposals: [nvda("2026-11-20"), nvda("2026-11-06")],
            }),
            toolOutputs: [
              JSON.stringify({
                rows: [{ ticker: "NVDA", nextEarningsDate: "2026-11-18" }],
              }),
            ],
          },
        ],
      } as never),
      SPEC,
    );
    // The 11-20 expiry lives through the print; the 11-06 one does not reach it.
    expect(view.candidates.map((c) => c.expiry)).toEqual(["2026-11-06"]);
    expect(view.riskList).toContainEqual({
      ticker: "NVDA",
      reason: "earnings 2026-11-18 is before expiry 2026-11-20",
    });
  });

  it("drops a settlement whose id was never in the ledger the run read, and names it", () => {
    const view = buildView(
      report({
        steps: [
          {
            task: "markout",
            role: "markout-clerk",
            mode: "model",
            text: JSON.stringify({
              settlements: [
                {
                  id: "SPY-2026-09-02-1",
                  ticker: "SPY",
                  state: "不变",
                  note: "748.72",
                },
                {
                  id: "NFLX-2026-09-02-1",
                  ticker: "NFLX",
                  state: "加强",
                  note: "凭空",
                },
              ],
              sections: [],
            }),
            toolOutputs: [
              JSON.stringify({
                dir: "/tmp/reports",
                reports: [
                  {
                    date: "2026-09-02",
                    phase: "premarket",
                    candidates: [{ id: "SPY-2026-09-02-1", ticker: "SPY" }],
                  },
                ],
              }),
            ],
          },
        ],
      } as never),
      SPEC,
    );
    const titles = view.sections.map((section) => section.title);
    expect(titles).toContain("Settlements");
    expect(titles).toContain("Settlements not in the ledger, dropped");
    const kept = view.sections.find(
      (section) => section.title === "Settlements",
    )!.body;
    expect(kept).toContain("SPY-2026-09-02-1");
    expect(kept).not.toContain("NFLX");
    const cut = view.sections.find(
      (section) => section.title === "Settlements not in the ledger, dropped",
    )!.body;
    expect(cut).toContain("NFLX-2026-09-02-1");
    expect(cut).toContain("NFLX");
  });
});

describe("renderReport (text part)", () => {
  it("carries every computed number and none of the transcript", () => {
    const { subject, text } = renderReport(report(), SPEC);
    // NO subject: the renderer cannot know the phase, so a subject minted here
    // buries the runner's `[TEST] intraday 2026-09-03` under one phaseless
    // line that all five of the day's mails share.
    expect(subject).toBeUndefined();
    expect(text).toContain("SPY");
    expect(text).toContain("748.72");
    expect(text).toContain("872");
    expect(text).toContain("Unpriced");
    // No ow_spot output in this report, so no ticker gets a % grid — not even
    // SPY, whose spot the reviewer typed into its own prose. That prose number
    // is exactly what the grid must not be anchored on.
    expect(text).toContain("Payoff at expiry (by strike, no ow_spot quote)");
    expect(text).not.toContain("Payoff at expiry (spot ±%)");
    expect(REVIEW_TEXT).toContain("(spot 761.78)");
    // The reader never sees the model thinking out loud, its quantity guess, or
    // any run metadata.
    expect(text).not.toContain("Actually, let me");
    expect(text).not.toContain("quantity");
    expect(text).not.toContain("run-84a83ad2");
    expect(text).not.toContain("helium audit");
  });

  it("renders the empty brief as a short reason, not a transcript", () => {
    const { text } = renderReport(
      report({
        outcome: "failed",
        failure: { class: "budget-exhausted", detail: "no room" },
      }),
      SPEC,
    );
    expect(text).toContain("This run did not finish");
    expect(text).not.toContain("Actually, let me");
  });
});

describe("renderReport (html part)", () => {
  it("carries the computed numbers and none of the transcript", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).toContain("SPY");
    expect(html).toContain("748.72");
    expect(html).toContain("872");
    expect(html).toContain("Unpriced");
    expect(html).not.toContain("Actually, let me");
    expect(html).not.toContain("quantity");
    expect(html).not.toContain("run-84a83ad2");
    expect(html).not.toContain("helium audit");
  });

  it("obeys the email constraints: no images, no svg, no box-shadow, no rem", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("box-shadow");
    expect(html).not.toMatch(/[0-9]rem/);
  });

  it("ships all three dark-mode layers and the 359px breakpoint", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("[data-ogsc]");
    expect(html).toContain("max-width: 359px");
  });

  it("escapes a rationale that contains markup", () => {
    const withMarkup = report();
    withMarkup.steps[3]!.text = REVIEW_TEXT.replace(
      "Bond duration hedge: minimal cost insurance.",
      "Bond <script>alert(1)</script> hedge",
    );
    const html = renderReport(withMarkup, SPEC).html ?? "";
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("a failed run shows what finished, but withholds tradable structures", () => {
    const html =
      renderReport(
        report({
          outcome: "failed",
          failure: { class: "budget-exhausted", detail: "no room" },
        }),
        SPEC,
      ).html ?? "";
    expect(html).toContain("This run did not finish");
    // The narrative is information; a structure is a recommendation, and a run
    // whose gate refused a step has not earned one.
    expect(html).not.toContain("【候选结构】");
  });
});

describe("tape", () => {
  const view = (tape: BriefView["tape"]): BriefView => ({
    date: "2026-09-02",
    tenant: "option-wizard",
    outcome: "completed",
    headline: "",
    tape,
    schedule: [],
    overnight: [],
    sections: [],
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
    // No tool payloads behind this fixture, so no chart is drawable. An empty
    // `gex` and an absent curve is exactly what a run with no argon answer
    // produces, and the assertion below (no <span> anywhere) is what proves
    // the charts stay omitted rather than rendering an empty axis.
    charts: { gex: [] },
  });

  it("omits the trailing <span> entirely when change is an empty string", () => {
    const html = renderHtml(
      view([{ label: "SPY", value: "765.16", change: "" }]),
    );
    expect(html).not.toContain("<span");
    expect(html).toContain("765.16");
  });

  it("omits the parenthesised change in text when change is an empty string", () => {
    const text = renderText(
      view([{ label: "SPY", value: "765.16", change: "" }]),
    );
    expect(text).toContain("SPY 765.16");
    expect(text).not.toContain("()");
  });

  it("still prints the <span> for a real change value", () => {
    const html = renderHtml(
      view([{ label: "VIX", value: "15.41", change: "+0.22", positive: true }]),
    );
    expect(html).toContain("<span");
    expect(html).toContain("+0.22");
  });
});

describe("sections", () => {
  const view = (sections: BriefView["sections"]): BriefView => ({
    date: "2026-09-02",
    tenant: "option-wizard",
    outcome: "completed",
    headline: "",
    tape: [],
    schedule: [],
    overnight: [],
    sections,
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
  });

  it("renders whatever sections the run produced, in task order", () => {
    const text = renderText(
      view([
        { title: "利率是第一因", body: "10y 4.21%，曲线 bear-flatten。" },
        { title: "Path B — In-line CPI", body: "base case。" },
      ]),
    );
    expect(text).toContain("【利率是第一因】");
    expect(text).toContain("【Path B — In-line CPI】");
    expect(text.indexOf("利率是第一因")).toBeLessThan(text.indexOf("Path B"));
  });

  it("renders a run with no narrative sections at all", () => {
    expect(renderText(view([])).includes("【今日 regime】")).toBe(false);
  });

  it("collects sections from every step, in step order", () => {
    const built = buildView(
      report({
        steps: [
          {
            task: "regime",
            role: "regime-analyst",
            mode: "model",
            text: '{"sections":[{"title":"利率","body":"10y 4.21%"}]}',
          },
          {
            task: "scenarios",
            role: "scenario-analyst",
            mode: "model",
            text: '{"sections":[{"title":"Path A","body":"hot CPI"},{"title":"Path B","body":"in line"}]}',
          },
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: REVIEW_TEXT,
          },
        ],
      } as never),
      SPEC,
    );
    expect(built.sections.map((s) => s.title)).toEqual([
      "利率",
      "Path A",
      "Path B",
    ]);
  });

  it("recovers the regime paragraph when the model answered in prose", () => {
    // One disobedient model must not empty the mail.
    expect(buildView(report(), SPEC).sections[0]?.title).toBe("今日 regime");
  });

  it("drops a section whose body is empty — a bare title reads as lost content", () => {
    const built = buildView(
      report({
        steps: [
          {
            task: "regime",
            role: "regime-analyst",
            mode: "model",
            text: '{"sections":[{"title":"利率","body":"   "},{"title":"分化","body":"real"}]}',
          },
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: REVIEW_TEXT,
          },
        ],
      } as never),
      SPEC,
    );
    expect(built.sections.map((s) => s.title)).toEqual(["分化"]);
  });
});

it("the renderer never branches on phase", () => {
  // The load-bearing claim of this design: which blocks a brief contains is
  // the team manifest's business, decided by which tasks ran. The moment the
  // renderer learns the word, five phases become five layouts to maintain.
  // Comments are exempt — the one in index.ts exists to say exactly this.
  const dir = new URL("../render/", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts")))
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/^\s*(\*|\/\/).*$/, "");
        if (code.includes("phase")) offenders.push(`${name}:${String(i + 1)}`);
      });
  expect(offenders).toEqual([]);
});

describe("invalidation", () => {
  const rebuilt = (text: string) =>
    buildView(
      report({
        steps: [{ task: "review", role: "risk-reviewer", mode: "model", text }],
      } as never),
      SPEC,
    ).candidates;

  it("mints the id here and carries the levels the thesis dies at", () => {
    const spy = buildView(report(), SPEC).candidates[0]!;
    expect(spy.id).toBe("SPY-2026-09-02-1");
    expect(spy.invalidation).toEqual([{ level: 750, side: "above" }]);
    expect(buildView(report(), SPEC).candidates[1]!.id).toBe(
      "QQQ-2026-09-02-2",
    );
  });

  it("says which thesis it dropped instead of an unexplained empty brief", () => {
    // The failure this guards is 2026-09-02's, one layer down: an empty brief
    // that looks the same whether the gate worked or the pipeline broke.
    const prose = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/g,
      '"invalidation": "SPY breaks below 560"',
    );
    const built = buildView(
      report({
        steps: [
          { task: "review", role: "risk-reviewer", mode: "model", text: prose },
        ],
      } as never),
      SPEC,
    );
    // GLD is the reviewer's own rejection; the gate's three land beside it, in
    // one list, so the reader sees every proposal that did not make it and why.
    expect(built.riskList.map((row) => row.ticker)).toEqual([
      "GLD",
      "SPY",
      "QQQ",
      "TLT",
    ]);
    expect(built.riskList[3]!.reason).toContain("invalidation");
  });

  it("drops a thesis whose 失效价 is prose — nobody can ever settle it", () => {
    // The shape the 2026-09-02 premarket designer actually emitted, verbatim.
    // It reads well and it is unsettleable: no run can compare a spot to a
    // sentence, so the thesis would stay open forever.
    const prose = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/g,
      '"invalidation": "SPY breaks below 560; broad market reprices off rate fears"',
    );
    expect(rebuilt(prose)).toEqual([]);
  });

  it("drops a thesis with no invalidation at all", () => {
    expect(
      rebuilt(REVIEW_TEXT.replace(/\s*"invalidation": \[[^\]]*\],\n/g, "")),
    ).toEqual([]);
  });

  it("keeps two levels for a two-sided structure", () => {
    const condor = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/,
      '"invalidation": [{"level":750,"side":"above"},{"level":720,"side":"below"}]',
    );
    expect(rebuilt(condor)[0]!.invalidation).toHaveLength(2);
  });

  it("refuses a third level — a thesis with three exits has no shape", () => {
    const three = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/,
      '"invalidation": [{"level":750,"side":"above"},{"level":720,"side":"below"},{"level":700,"side":"below"}]',
    );
    expect(rebuilt(three).map((c) => c.ticker)).not.toContain("SPY");
  });

  it("shows a declared earnings date, and shows nothing when there is none", () => {
    // Display only: the reviewer gates the declaration, the renderer just
    // repeats the date. The fixture expires 2026-09-30, so the declared date
    // sits inside the window; NVDA's real next print (2026-11-18, as-of
    // 2026-09-03) is the after-expiry case, checked below.
    const declared = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/,
      '"invalidation": [{"level":750,"side":"above"}], "earnings": {"date":"2026-09-24","risk":"A gap through 740 prints the full width as a loss."}',
    );
    const withEarnings = buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: declared,
          },
        ],
      } as never),
      SPEC,
    );
    expect(withEarnings.candidates[0]!.earnings).toBe("2026-09-24");
    expect(renderText(withEarnings)).toContain("earnings 2026-09-24");
    // The unmodified fixture declares no earnings at all.
    expect(buildView(report(), SPEC).candidates[0]!.earnings).toBeUndefined();
    expect(renderText(buildView(report(), SPEC))).not.toContain("earnings ");
  });

  it("drops a declared earnings date the structure expires before", () => {
    // 2026-09-03 premarket: META's 2026-11-04 print declared on a 2026-09-11
    // spread. Here: NVDA's real 2026-11-18 print on the 2026-09-30 fixture.
    const late = REVIEW_TEXT.replace(
      /"invalidation": \[[^\]]*\]/,
      '"invalidation": [{"level":750,"side":"above"}], "earnings": {"date":"2026-11-18","risk":"A gap through 740 prints the full width as a loss."}',
    );
    const view = buildView(
      report({
        steps: [
          { task: "review", role: "risk-reviewer", mode: "model", text: late },
        ],
      } as never),
      SPEC,
    );
    expect(view.candidates[0]!.earnings).toBeUndefined();
    expect(renderText(view)).not.toContain("earnings ");
  });

  it("prints the id and the levels where a reader can quote them back", () => {
    const text = renderText(buildView(report(), SPEC));
    expect(text).toContain("[SPY-2026-09-02-1]");
    expect(text).toContain("stop 750↑");
  });
});

describe("decision block", () => {
  /** The eight English keys team.yaml now asks the reviewer for (the
   *  2026-09-03 newsletter redesign moved the block to "Bottom line", near
   *  the top, and translated its keys out of Chinese along with the rest of
   *  the mail). Values are drawn from the fixture's own numbers (its 750
   *  strike, the regime step's 4.772% and 16.02) so nothing here is a price
   *  this file invented. */
  const DECISION = {
    Call: "Cautiously defensive, direction unclear",
    Action: "Hedges only, no directional long added",
    Aggression: "2/5",
    WhyNow: "10y at 4.772%, the whole curve is still being bought",
    MaxRisk: "A short squeeze on a rates pullback",
    Invalidation: "SPY closes above 750",
    NextTrigger: "VIX clears 20 from 16.02",
    Confidence: "IB layer skipped, everything else covered",
  };

  const built = (json: unknown) =>
    buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify(json),
          },
        ],
      } as never),
      SPEC,
    );

  it("carries all eight lines into both parts of the mail", () => {
    const view = built({ ...REVIEW_JSON, decision: DECISION });
    const text = renderText(view);
    const html = renderReport(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify({ ...REVIEW_JSON, decision: DECISION }),
          },
        ],
      } as never),
      SPEC,
    ).html;
    expect(text).toContain("【Bottom line】");
    expect(html).toContain("Bottom line");
    for (const [label, value] of Object.entries(DECISION)) {
      expect(text).toContain(`${label}: ${value}`);
      // The html spaces a camelCase label ("WhyNow" -> "Why Now") for
      // readability; the text part keeps the raw key, checked above.
      expect(html).toContain(label.replace(/([a-z0-9])([A-Z])/gu, "$1 $2"));
      expect(html).toContain(value);
    }
  });

  it("survives the day nothing survived — that is when it matters most", () => {
    // No proposals, no risk list: the brief is one "no candidates today"
    // line, and the block is the only thing in it that says what to do.
    const view = built({
      proposals: [],
      riskList: [],
      reason: "no tradeable structure",
      decision: DECISION,
    });
    expect(view.empty).toBeDefined();
    expect(renderText(view)).toContain(
      "MaxRisk: A short squeeze on a rates pullback",
    );
  });

  it("prints no heading when the reviewer wrote no block, and skips a blank line", () => {
    expect(renderText(built(REVIEW_JSON))).not.toContain("【Bottom line】");
    const partial = built({
      ...REVIEW_JSON,
      decision: { Call: "Cautiously defensive", MaxRisk: "  " },
    });
    expect(partial.decision).toEqual([
      { label: "Call", value: "Cautiously defensive" },
    ]);
    expect(renderText(partial)).not.toContain("MaxRisk");
  });
});

describe("arithmetic gate", () => {
  // 761.78 is SPY's real spot on the 2026-09-02 run this file's fixture comes
  // from — the same number that run's reviewer quoted in its own prose. Here it
  // is fed the way the gate is only allowed to read it: as the JSON `ow_spot`
  // returned. The STRIKES below are moved; a strike is model output, not a
  // market value, and moving one is how the ITM case is built without inventing
  // a price.
  const SPOT_TOOL = JSON.stringify({
    quotes: [{ ticker: "SPY", source: "tradingview", last: 761.78 }],
  });

  const withSpot = (proposals: unknown[]) =>
    buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify({ proposals, riskList: [] }),
            toolOutputs: [SPOT_TOOL],
          },
        ],
      } as never),
      SPEC,
    );

  const spy = (over: Record<string, unknown>) => ({
    ticker: "SPY",
    invalidation: [{ level: 750, side: "above" }],
    strategy: "vertical",
    legs: [],
    rationale: "…",
    ...over,
  });

  it("rejects a short put already in the money, and prints the spot it used", () => {
    const view = withSpot([
      spy({
        legs: [
          {
            right: "put",
            expiry: "2026-09-30",
            strike: 765,
            action: "sell",
            mid: 12.1,
          },
          {
            right: "put",
            expiry: "2026-09-30",
            strike: 755,
            action: "buy",
            mid: 7.4,
          },
        ],
      }),
    ]);
    expect(view.candidates).toEqual([]);
    expect(view.riskList[0]!.reason).toContain("short put 765 is already ITM");
    expect(view.riskList[0]!.reason).toContain("761.78");
  });

  it("passes a bull call spread whose legs are in the right order", () => {
    const view = withSpot([
      spy({
        strategy: "bull_call_spread",
        legs: [
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 770,
            action: "buy",
            mid: 8.2,
          },
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 780,
            action: "sell",
            mid: 4.6,
          },
        ],
      }),
    ]);
    expect(view.candidates.map((c) => c.ticker)).toEqual(["SPY"]);
    expect(view.candidates[0]!.unchecked).toBeUndefined();
    // …and refuses the same structure with its legs the wrong way round.
    const inverted = withSpot([
      spy({
        strategy: "bull_call_spread",
        legs: [
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 780,
            action: "buy",
            mid: 4.6,
          },
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 770,
            action: "sell",
            mid: 8.2,
          },
        ],
      }),
    ]);
    expect(inverted.candidates).toEqual([]);
    expect(inverted.riskList[0]!.reason).toContain("bull call spread");
  });

  it("neither drops nor silently passes a ticker no tool priced", () => {
    // The base fixture carries no ow_spot output at all. A silent pass and a
    // real pass read identically, and the run that shipped a QQQ 420/410 spread
    // with QQQ at 707 looked exactly like a pass.
    const view = buildView(report(), SPEC);
    expect(view.candidates.map((c) => c.ticker)).toEqual(["SPY", "QQQ", "TLT"]);
    expect(view.candidates[0]!.unchecked).toContain(
      "no tool spot; not verified",
    );
    expect(renderText(view)).toContain("no tool spot; not verified");
  });

  it("takes the spot from ow_strike_check too, not only from ow_spot", () => {
    // run-87284561: the reviewer priced SHY through ow_strike_check and never
    // through ow_spot, so a ticker with a perfectly good tool spot rendered
    // 未校验 and lost its ±% grid. Same 761.78 SPY quote, delivered in
    // ow_strike_check's shape — a top-level ticker and spot.
    const view = buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify({
              proposals: [
                spy({
                  legs: [
                    {
                      right: "put",
                      expiry: "2026-09-30",
                      strike: 765,
                      action: "sell",
                      mid: 12.1,
                    },
                    {
                      right: "put",
                      expiry: "2026-09-30",
                      strike: 755,
                      action: "buy",
                      mid: 7.4,
                    },
                  ],
                }),
              ],
              riskList: [],
            }),
            toolOutputs: [
              JSON.stringify({
                ticker: "SPY",
                spot: 761.78,
                spotSource: "tradingview",
                rows: [
                  {
                    strike: 765,
                    right: "put",
                    spot: 761.78,
                    distPct: 0.42,
                    moneyness: "ITM",
                  },
                ],
              }),
            ],
          },
        ],
      } as never),
      SPEC,
    );
    expect(view.candidates).toEqual([]);
    expect(view.riskList[0]!.reason).toContain(
      "short put 765 is already ITM: spot 761.78",
    );
  });

  it("reads direction out of a debit/credit structure name, not only bull/bear", () => {
    // The real names on run-87284561 were "Short 30Y duration via put debit
    // spread" and "Long short-duration bonds via call debit spread". A debit is
    // paid for the leg you are long, so a put debit spread is long the HIGHER
    // strike; these TLT legs are the other way round.
    const put = (strike: number, action: "buy" | "sell") => ({
      right: "put",
      expiry: "2026-09-30",
      strike,
      action,
      mid: 2.0,
    });
    // No ow_spot output here on purpose: geometry needs no spot, so the leg
    // order is the only thing that can decide either verdict.
    const built = (legs: unknown[]) =>
      buildView(
        report({
          steps: [
            {
              task: "review",
              role: "risk-reviewer",
              mode: "model",
              text: JSON.stringify({
                proposals: [
                  {
                    ticker: "TLT",
                    invalidation: [{ level: 82, side: "below" }],
                    strategy: "Short 30Y duration via put debit spread",
                    legs,
                    rationale: "…",
                  },
                ],
                riskList: [],
              }),
            },
          ],
        } as never),
        SPEC,
      );
    const inverted = built([put(85, "sell"), put(80, "buy")]);
    expect(inverted.candidates).toEqual([]);
    expect(inverted.riskList[0]!.reason).toContain(
      "bear put spread: long 80 is not above short 85",
    );
    const correct = built([put(85, "buy"), put(80, "sell")]);
    expect(correct.candidates.map((c) => c.ticker)).toEqual(["TLT"]);
    // Recognised, so no 未识别 note either — the whole point of the widening.
    expect(correct.candidates[0]!.unchecked).not.toContain("未识别");
  });

  it("normalises the underscored spelling a real run actually wrote", () => {
    // `put_debit_spread_hedge` was the name on all three of this file's fixture
    // proposals, and two of the three were credit spreads wearing it. The
    // separator is not a licence to skip the check: with SPY's own legs — buy
    // 740 / sell 750, long BELOW short — the debit name is refused.
    const mislabelled = buildView(
      report({
        steps: [
          {
            task: "review",
            role: "risk-reviewer",
            mode: "model",
            text: JSON.stringify({
              proposals: [
                {
                  ...REVIEW_JSON.proposals[0],
                  strategy: "put_debit_spread_hedge",
                },
              ],
              riskList: [],
            }),
          },
        ],
      } as never),
      SPEC,
    );
    expect(mislabelled.candidates).toEqual([]);
    expect(mislabelled.riskList[0]!.reason).toContain(
      "bear put spread: long 740 is not above short 750",
    );
  });

  it("refuses an entry trigger that only fires past the short strike", () => {
    const view = withSpot([
      spy({
        strategy: "bull_call_spread",
        entry: { level: 790, side: "above" },
        legs: [
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 770,
            action: "buy",
            mid: 8.2,
          },
          {
            right: "call",
            expiry: "2026-09-30",
            strike: 780,
            action: "sell",
            mid: 4.6,
          },
        ],
      }),
    ]);
    expect(view.candidates).toEqual([]);
    expect(view.riskList[0]!.reason).toContain("is past short call 780");
  });
});

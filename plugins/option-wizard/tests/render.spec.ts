/**
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
import type { BriefView } from "../render/index.js";

const REVIEW_JSON = {
  proposals: [
    {
      ticker: "SPY",
      horizon: "multiday",
      strategy: "put_debit_spread_hedge",
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
      horizon: "day",
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
      rationale: "Tech hedge: elevated IV rank (24%), sensitive to yield moves.",
    },
    {
      ticker: "TLT",
      horizon: "multiday",
      strategy: "put_debit_spread_hedge",
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
      { task: "regime", role: "regime-analyst", mode: "model", text: REGIME_TEXT },
      { task: "design", role: "structure-designer", mode: "model", text: "{}" },
      { task: "review", role: "risk-reviewer", mode: "model", text: REVIEW_TEXT },
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
      reason: "未定价：put 80 缺少 mid",
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

  it("measures the payoff row in % only where a spot was quoted", () => {
    // The reviewer quoted a spot for SPY and for nothing else. A "-20%" on QQQ
    // would have been 20% below its own lowest STRIKE — arithmetic off a price
    // nobody stated, and in the first live brief every sampled point then fell
    // outside the spread, printing max-gain three times and max-loss three
    // times. Without a spot the columns are the strikes themselves.
    const view = buildView(report(), SPEC);
    const spy = view.candidates[0]!.pricing;
    const qqq = view.candidates[1]!.pricing;
    if (spy.kind !== "priced" || qqq.kind !== "priced") throw new Error("priced");
    expect(spy.pnlAt.map((point) => point.pct)).toEqual([-20, -10, -5, 5, 10, 20]);
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
      "数据降级：provider local-llm 不可用（no credential）；gate ib-preflight 未加载（module threw）",
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
      title: "本次运行未完成",
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
    expect(view.empty).toBe("今日无候选：budget-exhausted — no room");
  });

  it("returns 今日无候选 when no model ran", () => {
    const view = buildView(
      report({ mode: "tool-only", providersLive: [] }),
      SPEC,
    );
    expect(view.outcome).toBe("DEGRADED");
    expect(view.empty).toBe("今日无候选：无可用 provider，本次没有任何模型推理");
  });

  it("returns 今日无候选 when the review step's JSON cannot be parsed", () => {
    const broken = report();
    broken.steps[3]!.text = "I could not produce proposals today.";
    expect(buildView(broken, SPEC).empty).toBe(
      "今日无候选：review 步骤没有可解析的 JSON",
    );
  });
});

describe("renderReport (text part)", () => {
  it("carries every computed number and none of the transcript", () => {
    const { subject, text } = renderReport(report(), SPEC);
    expect(subject).toContain("option-wizard");
    expect(text).toContain("SPY");
    expect(text).toContain("748.72");
    expect(text).toContain("872");
    expect(text).toContain("未定价");
    expect(text).toContain("到期损益（spot ±%）");
    expect(text).toContain("到期损益（按行权价，reviewer 未报 spot）");
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
    expect(text).toContain("本次运行未完成");
    expect(text).not.toContain("Actually, let me");
  });
});

describe("renderReport (html part)", () => {
  it("carries the computed numbers and none of the transcript", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).toContain("SPY");
    expect(html).toContain("748.72");
    expect(html).toContain("872");
    expect(html).toContain("未定价");
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
    expect(html).toContain("本次运行未完成");
    // The narrative is information; a structure is a recommendation, and a run
    // whose gate refused a step has not earned one.
    expect(html).not.toContain("【候选结构】");
  });
});

describe("sections", () => {
  const view = (sections: BriefView["sections"]): BriefView => ({
    date: "2026-09-02",
    tenant: "option-wizard",
    outcome: "completed",
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
          { task: "review", role: "risk-reviewer", mode: "model", text: REVIEW_TEXT },
        ],
      } as never),
      SPEC,
    );
    expect(built.sections.map((s) => s.title)).toEqual(["利率", "Path A", "Path B"]);
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
          { task: "review", role: "risk-reviewer", mode: "model", text: REVIEW_TEXT },
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

describe("horizon", () => {
  it("mints the id here and carries the model's horizon", () => {
    const spy = buildView(report(), SPEC).candidates[0]!;
    expect(spy.id).toBe("SPY-2026-09-02-1");
    expect(spy.horizon).toBe("multiday");
    expect(buildView(report(), SPEC).candidates[1]!.id).toBe("QQQ-2026-09-02-2");
  });

  it("drops a proposal with no horizon — a thesis that never comes due cannot be settled", () => {
    const stripped = REVIEW_TEXT.replace(/\s*"horizon": "[a-z]+",\n/g, "");
    const built = buildView(
      report({
        steps: [
          { task: "review", role: "risk-reviewer", mode: "model", text: stripped },
        ],
      } as never),
      SPEC,
    );
    expect(built.candidates).toEqual([]);
  });

  it("refuses a horizon the close run would not know how to settle", () => {
    const bogus = REVIEW_TEXT.replace(/"horizon": "[a-z]+"/g, '"horizon": "soon"');
    const built = buildView(
      report({
        steps: [
          { task: "review", role: "risk-reviewer", mode: "model", text: bogus },
        ],
      } as never),
      SPEC,
    );
    expect(built.candidates).toEqual([]);
  });

  it("prints the id and horizon where a reader can quote them back", () => {
    const text = renderText(buildView(report(), SPEC));
    expect(text).toContain("[SPY-2026-09-02-1]");
    expect(text).toContain("horizon multiday");
  });
});

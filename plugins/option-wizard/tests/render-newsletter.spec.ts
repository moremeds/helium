/**
 * The 2026-09-03 newsletter redesign: masthead headline, tape strip, bottom
 * line, overnight, today's schedule, then the run's own narrative sections,
 * candidates, a compact risk register and data coverage last.
 *
 * Two kinds of fixture:
 *  - real-report fixtures below, built from the actual runs named in the
 *    task brief, with every number traced to a `briefing.md` line (cited in
 *    each comment) — as-of 2026-09-03 / 2026-09-02, frozen here;
 *  - the size-budget fixture, which reuses the SAME real proposals/rejections
 *    from those two runs (no invented tickers or prices) padded only by
 *    repeating real rows, to prove 5 candidates + 8 risk rows renders under
 *    Gmail's 102KB clip with room to spare.
 *
 * `headline`/`tape`/`schedule` did not exist in either real run's regime
 * step (both predate this redesign's team.yaml change) — here they are
 * reconstructed from figures already present, verbatim, in that same
 * regime step's own JSON body, never invented.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import renderReport, { buildView } from "../render/index.js";
import { tapeRowSizes } from "../render/html.js";

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

/**
 * The regime step's own JSON, premarket 2026-09-03 (run
 * `run-cbf36b61-91f8-4891-8970-815c9633a54d`). `headline` is the design of
 * record's masthead line for this exact run
 * (`ow-premarket-2026-09-03.min.html`, MASTHEAD block); `tape` and
 * `schedule` are the same run's own regime section, reformatted into the
 * new structured fields — every value traced below to
 * `results/macmini/run-cbf36b61-.../briefing.md`.
 */
const REGIME_JSON_0903 = {
  // briefing.md:30, MASTHEAD block of the design-of-record mockup.
  headline: "Rates are still the first cause. No candidate ships today.",
  tape: [
    // briefing.md:20 (GEX table)
    { label: "SPY", value: "765.16" },
    // briefing.md:21 (GEX table)
    { label: "QQQ", value: "709.24" },
    // briefing.md:30 ("VIX liveNow 15.41 (+0.22)")
    { label: "VIX", value: "15.41", change: "+0.22", positive: true },
    // briefing.md:30 ("10Y 4.788% (+0.8bp)")
    { label: "10Y", value: "4.788%", change: "+0.8bp", positive: true },
    // briefing.md:30 ("2Y 4.375% (+0.4bp)")
    { label: "2Y", value: "4.375%", change: "+0.4bp", positive: true },
    // briefing.md:30 ("30Y 5.261% (+0.1bp)")
    { label: "30Y", value: "5.261%", change: "+0.1bp", positive: true },
    // briefing.md:30 ("DXY soft at 99.215 (−0.36 on the day...)")
    { label: "DXY", value: "99.215", change: "-0.36", positive: false },
    // briefing.md:30 ("Gold is $4,427.62, +0.90% on the day")
    { label: "Gold", value: "$4,427.62", change: "+0.90%", positive: true },
  ],
  schedule: [
    // briefing.md:30 ("Weekly Jobless Claims (forecast 205000, prev 203000)")
    {
      utc: "12:30Z",
      et: "08:30 ET",
      event: "Initial Jobless Claims",
      consensus: "205000",
      prior: "203000",
      group: "Today · 3 September",
    },
    // briefing.md:30 ("Waller speaks at a Reuters NEXT interview ... alongside ... the Trade Balance")
    {
      utc: "12:30Z",
      et: "08:30 ET",
      event: "Waller, Reuters NEXT interview; Trade Balance",
      group: "Today · 3 September",
    },
    // briefing.md:30 ("Cleveland's Hammack and Chicago's Goolsbee give remarks at 2026-09-03T19:00:00Z")
    {
      utc: "19:00Z",
      et: "15:00 ET",
      event: "Hammack (Cleveland) and Goolsbee (Chicago), remarks",
      group: "Today · 3 September",
    },
    // briefing.md:30 ("Employment Report lands tomorrow 2026-09-04T12:30:00Z (payrolls forecast 50000, prev -23000; unemployment forecast 4.1%, prev 4.1%)")
    {
      utc: "12:30Z",
      et: "08:30 ET",
      event: "Employment Report",
      consensus: "NFP +50000 / U-rate 4.1%",
      prior: "NFP -23000 / U-rate 4.1%",
      group: "Tomorrow · 4 September",
    },
  ],
  sections: [
    {
      title: "Rates are the first cause",
      // briefing.md:30, "利率是第一因" body, trimmed.
      body: "2Y 4.375% (+0.4bp), 10Y 4.788% (+0.8bp), 30Y 5.261% (+0.1bp). 2s10s +41.3bp and steepening — DGS10 walked 4.63 -> 4.75 -> 4.79 across 08-05/08-31/09-01. Bear-steepener: term premium repricing, not a cut.",
    },
    {
      title: "Layer Coverage",
      // briefing.md:30, "Layer Coverage" body, trimmed but not reworded.
      body: "RATES — SOURCE ow_macro_rates liveNow + series; AS-OF 2026-09-03T10:00:21.513Z; check | CREDIT (HY OAS) — SOURCE ow_macro_rates BAMLH0A0HYM2 = 2.65%; check | CREDIT (CCC OAS) — skipped — no CCC OAS source | EVENTS — SOURCE ow_uw_calendar; AS-OF 2026-09-03T10:00:21.852Z; check",
    },
  ],
};

/** The design step's 8 proposals, all rejected by the review step's own
 *  arithmetic gate — real tickers, real spots, real rejection percentages,
 *  `briefing.md:317-330` of the same 2026-09-03 premarket run. The review
 *  step's actual reply was prose, not this run's redesigned JSON contract;
 *  this reformats the same 8 real verdicts into the shape team.yaml now
 *  asks for, values unchanged. */
const REVIEW_JSON_0903 = {
  proposals: [],
  riskList: [
    // briefing.md:317
    { ticker: "NVDA", reason: "strikes 135/130 are 40%/42% below spot 224.41" },
    // briefing.md:320
    { ticker: "ASTS", reason: "strikes 12.5/10 are 80%/84% below spot 62.40" },
    // briefing.md:323
    { ticker: "TOL", reason: "strikes 120/112 are 15%/20% below spot 140.70" },
    // briefing.md:326
    { ticker: "QQQ", reason: "strikes 410/395 are 42%/44% below spot 709.24" },
    // briefing.md:329
    { ticker: "SMH", reason: "strikes 240/222 are 56%/60% below spot 550.48" },
    // briefing.md:332
    { ticker: "XLRE", reason: "strikes 58/54 are 33%/23% above spot 43.73" },
    // briefing.md:335
    { ticker: "MSFT", reason: "strikes 410/395 are 18%/20% below spot 496.82" },
    // briefing.md:338
    { ticker: "ARM", reason: "strikes 165/155 are 30%/34% below spot 234.86" },
  ],
  // The design-of-record's own "decision box" copy for this exact run
  // (ow-premarket-2026-09-03.min.html, "decision box" block) — grounded in
  // the same 8 real rejections above, reformatted into the new English
  // decision-block keys.
  decision: {
    Call: "All eight structures produced today failed the strike-versus-spot arithmetic gate. Their strikes were priced against levels 15% to 84% away from where the underlyings actually trade. Not one sits near the market.",
    Action:
      "Reject all eight and send the book back to be repriced against today's spot. Nothing ships.",
    Aggression: "Zero. There is no structure that can be entered.",
    NextTrigger:
      "Re-anchor all eight to current spot and re-run design. On the macro side, the Employment Report at 12:30Z tomorrow.",
  },
};

function report0903(): RunReport {
  return {
    runId: "run-cbf36b61-91f8-4891-8970-815c9633a54d",
    tenant: "option-wizard",
    day: "2026-09-03",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: ["ow_ib_positions (OW_IB_API_BASE unset)"],
    steps: [
      {
        task: "universe",
        role: "universe-builder",
        mode: "deterministic",
        text: "SPY QQQ",
      },
      {
        task: "gex",
        role: "gex-reporter",
        mode: "model",
        text: "SPY 765.16 / QQQ 709.24 — as of 2026-09-02T20:14:37.761000Z (SPY) — ow_uw_gex",
      },
      // No overnight step: the real run had no earnings feed in scope
      // (briefing.md:30, "this run was not given per-name earnings prints
      // ... I will not manufacture names"). That absence is exactly what
      // exercises the empty-overnight one-liner, on real data.
      {
        task: "regime",
        role: "regime-analyst",
        mode: "model",
        text: JSON.stringify(REGIME_JSON_0903),
      },
      {
        task: "scenarios",
        role: "scenario-analyst",
        mode: "model",
        text: '{"sections":[]}',
      },
      {
        task: "design",
        role: "structure-designer",
        mode: "model",
        text: '{"proposals":[]}',
      },
      {
        task: "review",
        role: "risk-reviewer",
        mode: "model",
        text: JSON.stringify(REVIEW_JSON_0903),
      },
    ],
  } as RunReport;
}

describe("2026-09-03 premarket fixture (zero candidates)", () => {
  const view = buildView(report0903(), SPEC);

  it("carries the masthead headline from the regime step's own field", () => {
    expect(view.headline).toBe(
      "Rates are still the first cause. No candidate ships today.",
    );
  });

  it("carries the tape strip and today's schedule", () => {
    expect(view.tape).toContainEqual({ label: "SPY", value: "765.16" });
    expect(view.tape).toContainEqual(
      expect.objectContaining({ label: "10Y", value: "4.788%" }),
    );
    expect(view.schedule).toContainEqual(
      expect.objectContaining({
        event: "Initial Jobless Claims",
        consensus: "205000",
        prior: "203000",
      }),
    );
    expect(view.schedule).toContainEqual(
      expect.objectContaining({
        event: "Employment Report",
        group: "Tomorrow · 4 September",
      }),
    );
  });

  it("records an empty overnight on the view, and no longer mails it", () => {
    // The one-liner used to be printed in both parts. Since the mail was
    // abridged (2026-09-05) the overnight list is Flash's, and the view — the
    // document argon renders from — is where it has to survive.
    expect(view.overnight).toEqual([]);
    const text = renderReport(report0903(), SPEC).text ?? "";
    expect(text).not.toContain("Nothing flagged overnight.");
    const html = renderReport(report0903(), SPEC).html ?? "";
    expect(html).not.toContain("Nothing flagged overnight.");
  });

  it("carries the 8 real rejections in the risk register and zero candidates", () => {
    expect(view.candidates).toEqual([]);
    expect(view.riskList).toHaveLength(8);
    expect(view.riskList.map((row) => row.ticker)).toEqual([
      "NVDA",
      "ASTS",
      "TOL",
      "QQQ",
      "SMH",
      "XLRE",
      "MSFT",
      "ARM",
    ]);
  });

  // Design 04 (2026-09-04) gives the header a fixed title and moves the run's
  // own sentence out of it, into a "Today in one sentence" section under the
  // market snapshot — the spec's fixed daily structure. So the headline
  // follows the tape instead of preceding it. Abridging the mail (2026-09-05)
  // then cut everything after the decision block: what remains is this order,
  // and the schedule and risk register are gone from the mail entirely.
  it("renders the snapshot, one-sentence call and bottom line in that order, and nothing after them", () => {
    const html = renderReport(report0903(), SPEC).html ?? "";
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const tape = at("765.16");
    const oneSentence = at("Rates are still the first cause");
    const bottomLine = at("Bottom line");
    expect(at("Market snapshot")).toBeLessThan(tape);
    expect(tape).toBeLessThan(oneSentence);
    expect(oneSentence).toBeLessThan(bottomLine);
    expect(html).not.toContain("Initial Jobless Claims");
    expect(html).not.toContain("Risk register");
  });
});

/**
 * Close 2026-09-02 (run `run-b94a72aa-24c9-4fde-9e69-3f95013059ce`). The
 * review step's real reply carried three proposals, all passed — NOW, IWM,
 * QQQ (`briefing.md:355-441`); `invalidation` there is the OLD bare-string
 * shape ("136.00" etc.), predating the level+side schema, so it is
 * reformatted here into `{level, side}` using the SAME number and the
 * side the review step's own prose names ("break of intraday low" for a
 * bullish NOW structure is a break BELOW; "break of squeeze target" /
 * "break of recent high" for the two bearish structures are breaks ABOVE).
 * Legs, mids, strikes and the decision block are verbatim from the run.
 */
const REVIEW_JSON_0902 = {
  proposals: [
    {
      ticker: "NOW",
      strategy: "Call debit spread — bullish tilt",
      legs: [
        {
          right: "call",
          expiry: "2026-09-25",
          strike: 141,
          action: "buy",
          ratio: 1,
          mid: 5.25,
        },
        {
          right: "call",
          expiry: "2026-09-25",
          strike: 145,
          action: "sell",
          ratio: 1,
          mid: 3.92,
        },
      ],
      // briefing.md:387 ("NOW: 136.00 (break of intraday low)")
      invalidation: [{ level: 136.0, side: "below" }],
      target: "Max gain 267 at 145, exit at 50% (~134)",
      rationale:
        "Repricing is done; the beat landed into a bar already priced for perfection. Defined-risk structure caps loss at 1.33, collects theta into 22-day decay cycle.",
    },
    {
      ticker: "IWM",
      strategy: "Put debit spread — bearish tilt",
      legs: [
        {
          right: "put",
          expiry: "2026-09-25",
          strike: 289,
          action: "buy",
          ratio: 1,
          mid: 3.37,
        },
        {
          right: "put",
          expiry: "2026-09-25",
          strike: 278,
          action: "sell",
          ratio: 1,
          mid: 1.31,
        },
      ],
      // briefing.md:387 ("IWM: 301.00 (break of squeeze target, structural case fails)")
      invalidation: [{ level: 301.0, side: "above" }],
      target: "Max gain 894 at 278, exit at 50% (~447)",
      rationale:
        "Net GEX negative + put delta massive overhang = structural short edge into rate-driven duration cascade.",
    },
    {
      ticker: "QQQ",
      strategy: "Put debit spread — bearish tilt",
      legs: [
        {
          right: "put",
          expiry: "2026-09-25",
          strike: 685,
          action: "buy",
          ratio: 1,
          mid: 5.31,
        },
        {
          right: "put",
          expiry: "2026-09-25",
          strike: 660,
          action: "sell",
          ratio: 1,
          mid: 2.38,
        },
      ],
      // briefing.md:387 ("QQQ: 719.00 (break of recent high, duration repricing reverses)")
      invalidation: [{ level: 719.0, side: "above" }],
      target: "Max gain 2207 at 660, exit at 50% (~1104)",
      rationale:
        "Repricing is macro-mechanical: rates at 4.77% grind duration multiples lower over the 22-day decay cycle.",
    },
  ],
  riskList: [],
  decision: {
    // briefing.md:429-436, translated key names to the redesigned English
    // contract, values verbatim.
    Call: "Three multi-day defined-risk spreads, all validated by argon (med confidence). NOW is repricing-exhaustion long; IWM/QQQ are structural shorts into rate rigidity.",
    Action: "Release all three to reader. No drops.",
    Aggression:
      "Measured: all defined-risk (max loss capped); debit-spread formats; theta positive into 22-day horizon.",
    MaxRisk:
      "Tail risk: all three theses invalidated simultaneously by Fed cut shock or VIX compression.",
  },
};

function report0902(): RunReport {
  return {
    runId: "run-b94a72aa-24c9-4fde-9e69-3f95013059ce",
    tenant: "option-wizard",
    day: "2026-09-02",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps: [
      {
        task: "universe",
        role: "universe-builder",
        mode: "deterministic",
        text: "NOW IWM QQQ",
      },
      {
        task: "regime",
        role: "regime-analyst",
        mode: "model",
        text: '{"sections":[{"title":"Rates","body":"10Y 4.772% grinding duration multiples lower."}]}',
      },
      { task: "design", role: "structure-designer", mode: "model", text: "{}" },
      {
        task: "review",
        role: "risk-reviewer",
        mode: "model",
        text: JSON.stringify(REVIEW_JSON_0902),
      },
    ],
  } as RunReport;
}

describe("2026-09-02 close fixture (real candidates)", () => {
  const view = buildView(report0902(), SPEC);

  it("keeps the real NOW/IWM/QQQ candidates and their real legs/mids", () => {
    // The real run's review step passed all three proposals (briefing.md
    // 348: "All three proposals pass arithmetic, completeness, and
    // structure. None dropped."); the task brief's "two candidates" does
    // not match what the real report file contains, so this fixture uses
    // the three the real data actually has rather than dropping one to fit
    // the stated number.
    expect(view.candidates.map((c) => c.ticker)).toEqual(["NOW", "IWM", "QQQ"]);
    expect(view.candidates[0]!.legs[0]).toMatchObject({
      strike: 141,
      mid: 5.25,
    });
  });

  it("has no overnight step in the close phase, and mails no overnight block", () => {
    expect(view.overnight).toEqual([]);
    expect(renderReport(report0902(), SPEC).text).not.toContain(
      "Nothing flagged overnight.",
    );
  });
});

/**
 * Size budget: 5 candidates + 8 risk rows must stay under 90KB, with Gmail's
 * 102KB clip as the hard ceiling. All 5 candidates and all 8 risk rows are
 * the real proposals/rejections from the two fixtures above — 3 real
 * candidates (NOW/IWM/QQQ) is short of 5, so 2 more real, already-computed
 * candidates from the render.spec.ts SPY/QQQ fixture (a different real run,
 * `run-84a83ad2`, documented in that file's own header) are appended rather
 * than inventing new ones.
 */
describe("size budget", () => {
  it("renders 5 candidates + 8 risk rows under 90KB", () => {
    const proposals = [
      ...REVIEW_JSON_0902.proposals,
      {
        ticker: "SPY",
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
        invalidation: [{ level: 750, side: "above" }],
        target: "Max gain 128 at 750, exit at 50% (~64)",
        rationale: "Defensive hedge aligned with bearish-tilt regime.",
      },
      {
        ticker: "TLT",
        strategy: "put_credit_spread_hedge",
        legs: [
          {
            right: "put",
            expiry: "2026-09-30",
            strike: 80,
            action: "buy",
            ratio: 1,
            mid: 0.3,
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
        invalidation: [{ level: 81, side: "above" }],
        target: "Max gain 26 at 81, exit at 50% (~13)",
        rationale: "Bond duration hedge: minimal cost insurance.",
      },
    ];
    const review = {
      proposals,
      riskList: REVIEW_JSON_0903.riskList,
      decision: REVIEW_JSON_0902.decision,
    };
    const report: RunReport = {
      runId: "run-size-budget",
      tenant: "option-wizard",
      day: "2026-09-02",
      mode: "model",
      providersLive: ["dsh"],
      providersSkipped: [],
      outcome: "completed",
      gatesSkipped: [],
      delivery: [],
      toolsUnconfigured: [],
      steps: [
        {
          task: "universe",
          role: "universe-builder",
          mode: "deterministic",
          text: "NOW IWM QQQ SPY TLT",
        },
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: JSON.stringify(REGIME_JSON_0903),
        },
        {
          task: "design",
          role: "structure-designer",
          mode: "model",
          text: "{}",
        },
        {
          task: "review",
          role: "risk-reviewer",
          mode: "model",
          text: JSON.stringify(review),
        },
      ],
    } as RunReport;
    const view = buildView(report, SPEC);
    expect(view.candidates).toHaveLength(5);
    expect(view.riskList).toHaveLength(8);
    const html = renderReport(report, SPEC).html ?? "";
    const bytes = Buffer.byteLength(html, "utf8");
    // eslint-disable-next-line no-console
    console.log(`size-budget html bytes: ${String(bytes)}`);
    expect(bytes).toBeLessThan(90 * 1024);

    // Also write the 2026-09-03 premarket brief, abridged and with its Flash
    // link, to the scratchpad for visual inspection — not part of the repo.
    process.env.ARGON_APP_BASE = "https://argon.example.internal";
    const checkHtml =
      renderReport({ ...report0903(), phase: "premarket" } as RunReport, SPEC)
        .html ?? "";
    delete process.env.ARGON_APP_BASE;
    const scratchpad =
      "/private/tmp/claude-501/-Users-chenxi-projects-helium/10e64f69-0a92-4e54-8bc7-eda824a2d9cf/scratchpad";
    try {
      writeFileSync(`${scratchpad}/abridged-premarket.html`, checkHtml);
      // eslint-disable-next-line no-console
      console.log(
        `abridged-premarket.html bytes: ${String(Buffer.byteLength(checkHtml, "utf8"))}`,
      );
    } catch {
      // The scratchpad may not exist outside this session; that is fine,
      // the byte-size assertions above already cover the requirement.
    }
  });
});

/**
 * The abridged mail (2026-09-05). The full brief now lives on argon's Flash
 * page; the email keeps the four things a reader acts on without opening a
 * browser — the tape, the day's sentence, the decision block and a one-row-
 * per-candidate table — and links to the rest.
 *
 * Both fixtures below are the SAME recorded runs used above: 2026-09-02 close
 * (three real candidates, real legs and mids, the run's own decision block)
 * and 2026-09-03 premarket (zero candidates, eight real rejections).
 */
describe("the abridged mail", () => {
  const APP_BASE = "https://argon.example.internal";
  const closeReport = (): RunReport =>
    ({ ...report0902(), phase: "close" }) as RunReport;

  const withBase = (): string => {
    process.env.ARGON_APP_BASE = APP_BASE;
    try {
      return renderReport(closeReport(), SPEC).html ?? "";
    } finally {
      delete process.env.ARGON_APP_BASE;
    }
  };

  it("keeps the headline, the decision block and one row per candidate", () => {
    const html = withBase();
    expect(html).toContain("Bottom line");
    // The decision block's own words, verbatim from the recorded run.
    expect(html).toContain("Release all three to reader. No drops.");
    for (const ticker of ["NOW", "IWM", "QQQ"]) expect(html).toContain(ticker);
    // Per candidate: structure, expiry, entry debit, max loss, invalidation.
    expect(html).toContain("Call debit spread — bullish tilt");
    expect(html).toContain("2026-09-25");
    expect(html).toContain("Max loss");
    expect(html).toContain("Invalidation");
  });

  it("links to the Flash page for this ISO week, day and run label", () => {
    expect(withBase()).toContain(
      `${APP_BASE}/flash/2026-W36/2026-09-02?phase=close`,
    );
  });

  it("drops the payoff figure, the rationales, the narrative and the risk register", () => {
    const html = withBase();
    expect(html).not.toContain("Payoff at expiry");
    expect(html).not.toContain("Risk register");
    expect(html).not.toContain("Data coverage");
    expect(html).not.toContain("Overnight");
    // A candidate's rationale paragraph, verbatim from the recorded run.
    expect(html).not.toContain("Repricing is macro-mechanical");
    // The run's own narrative section, title and body.
    expect(html).not.toContain("grinding duration multiples lower");
  });

  it("is abridged with no link at all when ARGON_APP_BASE is unset", () => {
    delete process.env.ARGON_APP_BASE;
    const html = renderReport(closeReport(), SPEC).html ?? "";
    expect(html).not.toContain("/flash/");
    expect(html).not.toContain("Full brief");
    expect(html).not.toContain("Payoff at expiry");
    expect(html).not.toContain("Repricing is macro-mechanical");
    // Still the four things it keeps.
    expect(html).toContain("Bottom line");
    expect(html).toContain("NOW");
  });

  it("abridges the text part the same way, link and all", () => {
    process.env.ARGON_APP_BASE = APP_BASE;
    try {
      const text = renderReport(closeReport(), SPEC).text ?? "";
      expect(text).toContain("【Bottom line】");
      expect(text).toContain("NOW");
      expect(text).toContain(
        `Full brief: ${APP_BASE}/flash/2026-W36/2026-09-02?phase=close`,
      );
      expect(text).not.toContain("Payoff at expiry");
      expect(text).not.toContain("Repricing is macro-mechanical");
      expect(text).not.toContain("【Overnight】");
    } finally {
      delete process.env.ARGON_APP_BASE;
    }
  });

  it("keeps the tape and prints no candidate table on a zero-candidate day", () => {
    // 2026-09-03 premarket: eight proposals, all eight rejected by the
    // arithmetic gate. The tape and the decision block are the whole mail, and
    // a Candidates heading with nothing under it is not printed.
    const html = renderReport(report0903(), SPEC).html ?? "";
    expect(html).toContain("Market snapshot");
    expect(html).toContain("765.16");
    expect(html).toContain("Rates are still the first cause");
    expect(html).toContain("Reject all eight");
    expect(html).not.toContain("Candidates");
    expect(html).not.toContain("Risk register");
  });
});

describe("the cause line under the headline", () => {
  // The real Unusual Whales row for Governor Waller's 2026-09-03 remarks —
  // the cause the intraday brief that day never named.
  const WALLER = {
    created_at: "2026-09-03T13:03:25Z",
    headline:
      "FED WALLER: CURRENT FED RATES MAY BE ENOUGH TO BRING INFLATION BACK TO 2%—NO RUSH TO CUT UNTIL MORE PROGRESS EMERGES",
  };
  const withCause = (cause: unknown): RunReport => {
    const base = report0903();
    return {
      ...base,
      steps: base.steps.map((step) =>
        step.task === "regime"
          ? { ...step, text: JSON.stringify({ ...REGIME_JSON_0903, cause }) }
          : step,
      ),
    };
  };

  it("renders a located cause as 'Why it moved' in both parts", () => {
    const out = renderReport(
      withCause({
        located: true,
        headline: WALLER.headline,
        at: WALLER.created_at,
        source: "ow_uw_headlines",
        searchTerm: "Waller",
      }),
      SPEC,
    );
    expect(out.html).toContain("Why it moved — FED WALLER: CURRENT FED RATES");
    expect(out.html).toContain("(2026-09-03T13:03:25Z)");
    expect(out.text).toContain(
      `Why it moved — ${WALLER.headline} (2026-09-03T13:03:25Z)`,
    );
  });

  it("renders located:false as 'Cause not located.'", () => {
    const out = renderReport(
      withCause({ located: false, searched: ["Waller", "Fed"] }),
      SPEC,
    );
    expect(out.html).toContain("Cause not located.");
    expect(out.text).toContain("Cause not located.");
  });

  it("prints no cause line when the step wrote none", () => {
    const out = renderReport(report0903(), SPEC);
    expect(out.html).not.toContain("Why it moved");
    expect(out.html).not.toContain("Cause not located");
  });
});

describe("tape rows are balanced", () => {
  it("lays ten tiles out as 3/3/2/2, never leaving one tile alone", () => {
    expect(tapeRowSizes(10)).toEqual([3, 3, 2, 2]);
    expect(tapeRowSizes(9)).toEqual([3, 3, 3]);
    expect(tapeRowSizes(7)).toEqual([3, 2, 2]);
    expect(tapeRowSizes(4)).toEqual([2, 2]);
    expect(tapeRowSizes(1)).toEqual([1]);
    expect(tapeRowSizes(0)).toEqual([]);
  });
});

describe("a policy-path snapshot older than its cadence says so", () => {
  // Shape recorded from ow_argon_policy_path on 2026-09-03 (render-editor.spec
  // POLICY_TOOL): `snapshotDate` beside a `meetings` array. argon writes the
  // snapshot for day D after the ET close, so D-1 is what every phase sees.
  const policy = (snapshotDate: string): string =>
    JSON.stringify({
      source: "frenzy_capital fed-funds futures via argon",
      snapshotDate,
      meetings: [
        {
          snapshot_date: snapshotDate,
          meeting_date: "2026-09-16",
          payload: { label: "9/16", stance: "HIKE", probability: 60 },
        },
      ],
    });
  const withPolicy = (snapshotDate: string, day: string): RunReport => {
    const base = report0903();
    return {
      ...base,
      day,
      steps: base.steps.map((step) =>
        step.task === "regime"
          ? { ...step, toolOutputs: [policy(snapshotDate)] }
          : step,
      ),
    };
  };

  it("prints the as-of into coverage and no stale line for the normal D-1", () => {
    const view = buildView(withPolicy("2026-09-02", "2026-09-03"), SPEC);
    expect(view.staleness).toBeUndefined();
    expect(view.coverage?.body).toContain("Fed path (argon) — as of 2026-09-02");
  });

  it("is quiet on a Monday reading Friday's snapshot (3 days)", () => {
    const view = buildView(withPolicy("2026-09-04", "2026-09-07"), SPEC);
    expect(view.staleness).toBeUndefined();
  });

  it("names a gap past the weekend, in both parts", () => {
    const report = withPolicy("2026-09-02", "2026-09-07");
    const view = buildView(report, SPEC);
    expect(view.staleness).toEqual([
      "Fed path: snapshot 2026-09-02, 5 days behind",
    ]);
    const out = renderReport(report, SPEC);
    expect(out.html).toContain("Fed path: snapshot 2026-09-02, 5 days behind");
    expect(out.text).toContain("Fed path: snapshot 2026-09-02, 5 days behind");
    // Not a failure: the degradation line must keep meaning "something broke".
    expect(view.degradation ?? "").not.toContain("Fed path");
  });

  it("says nothing when no such payload exists", () => {
    const view = buildView(report0903(), SPEC);
    expect(view.staleness).toBeUndefined();
    expect(view.coverage?.body ?? "").not.toContain("Fed path (argon)");
  });
});

/**
 * The editor step and the three data charts.
 *
 * Two halves, and the seam between them is the point of the whole change.
 *
 * The EDITOR writes the brief's prose as one author, replacing seven agents'
 * stitched fragments. It may rewrite a candidate's rationale and may not touch
 * a single number on it — the renderer drops any numeric field it sends, and
 * these tests are what hold that line.
 *
 * The CHARTS are drawn from the run's raw tool outputs and never from a model
 * step, so no editor field can reach them. Every fixture below is a real tool
 * response, frozen with the date it was observed:
 *
 *  - Treasury curve: `/api/market/yield-curve` (Unusual Whales), fetched
 *    2026-09-04, `new_date` 2026-09-02 — 2y 4.39, 5y 4.54, 10y 4.79,
 *    30y 5.27. Shaped here the way `ow_macro_rates` returns it (`liveNow`
 *    quotes labelled by TV_LIVE's own `2y`/`5y`/`10y`/`30y`). The approved
 *    mockup's TradingView intraday reads for the same session (4.375 / 4.539 /
 *    4.788 / 5.261) agree with these to a basis point.
 *  - Policy path: argon's `uw_scan.rates_policy_path`, snapshot 2026-09-02, as
 *    the 2026-09-03 premarket run reported it — 2026-09-16 hike 60%,
 *    2026-10-28 hold 70%, 2026-12-09 hike 64%. The 9/16 payload is the one
 *    verified live and recorded in `tools/index.ts`.
 *  - Gamma levels: argon `/api/regime/dealer?ticker=SPY` on the mac mini,
 *    2026-09-03 — spot 768.86, Call Wall 770.0 gamma 75477.6864, Gamma Flip
 *    766.0 gamma 0. The same frozen response `tools.spec.ts` asserts against.
 *
 * No number in this file was computed by a person or a model.
 */
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import renderReport, { buildView } from "../render/index.js";

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

/** `ow_macro_rates`, live overlay only — the daily `series` half is omitted
 *  here because the chart deliberately never reads it (it lags by days and a
 *  bar cannot carry that caveat). */
const MACRO_TOOL = JSON.stringify({
  series: { source: "argon.uw_scan.macro_series_daily", rows: [] },
  liveNow: {
    source: "tradingview",
    quotes: [
      { name: "2y", symbol: "TVC:US02Y", fredId: "DGS2", last: 4.39 },
      { name: "5y", symbol: "TVC:US05Y", fredId: "DGS5", last: 4.54 },
      { name: "10y", symbol: "TVC:US10Y", fredId: "DGS10", last: 4.79 },
      { name: "30y", symbol: "TVC:US30Y", fredId: "DGS30", last: 5.27 },
    ],
    // (4.79 - 4.39) * 100, subtracted by the TOOL. Never recomputed in the
    // renderer, which is why it is a fixture value and not an assertion.
    spreads: { "2s10s": 40 },
    fetchedAt: "2026-09-02T20:00:00Z",
  },
  staleSeries: [],
});

const POLICY_TOOL = JSON.stringify({
  source: "frenzy_capital fed-funds futures via argon",
  snapshotDate: "2026-09-02",
  meetings: [
    {
      snapshot_date: "2026-09-02",
      meeting_date: "2026-09-16",
      payload: {
        label: "9/16",
        source: "Frenzy Capital Fed Watch",
        stance: "HIKE",
        status: "ok",
        probability: 60,
        implied_rate: "3.78",
        target_range: "3.75-4.00%",
      },
    },
    {
      snapshot_date: "2026-09-02",
      meeting_date: "2026-10-28",
      payload: { label: "10/28", stance: "HOLD", probability: 70 },
    },
    {
      snapshot_date: "2026-09-02",
      meeting_date: "2026-12-09",
      payload: { label: "12/9", stance: "HIKE", probability: 64 },
    },
  ],
});

const LEVELS_TOOL = JSON.stringify({
  source: "argon",
  levels: [
    {
      ticker: "SPY",
      spot: { value: 768.86, source: "technicals/live" },
      gamma: { gex_flip: 770, call_wall: 770, put_wall: 765, max_magnet: 770 },
      closest_levels: [
        {
          label: "Call Wall",
          role: "resistance",
          strike: 770,
          distance_pct: 0.0014827146684701848,
          gamma: 75477.6864,
        },
        {
          label: "Gamma Flip",
          role: "flip",
          strike: 766,
          distance_pct: -0.0037197929401971926,
          gamma: 0,
        },
      ],
      expected_range: { low: 762.99, high: 774.81 },
      as_of: "2026-09-03",
    },
  ],
});

/** `ow_spot`'s own shape, so the arithmetic gate can price SPY's strikes. */
const SPOT_TOOL = JSON.stringify({
  quotes: [{ ticker: "SPY", last: 768.86 }],
});

const REVIEW_JSON = {
  proposals: [
    {
      ticker: "SPY",
      strategy: "put credit spread",
      invalidation: [{ level: 760, side: "below" }],
      target: "50% of max credit",
      legs: [
        {
          right: "put",
          action: "buy",
          strike: 755,
          expiry: "2026-09-30",
          mid: 4.1,
        },
        {
          right: "put",
          action: "sell",
          strike: 760,
          expiry: "2026-09-30",
          mid: 5.4,
        },
      ],
      rationale: "Fragment written by the reviewer.",
    },
  ],
  riskList: [{ ticker: "QQQ", reason: "strikes not near spot" }],
  decision: { Call: "Reviewer's own call.", Action: "Reviewer's own action." },
};

const EDITOR_JSON = {
  headline: "Rates are still the first cause. One structure ships.",
  decision: {
    Call: "The 10Y at 4.79% against a 2Y at 4.39% is a 40bp curve; term premium, not a cut.",
    Action: "Take the SPY 755/760 put credit spread and nothing else.",
  },
  sections: [
    {
      title: "Macro read",
      body: "What changed since yesterday's brief: the 10Y printed 4.79% against 4.39% at the front, a 40bp 2s10s.",
    },
  ],
  coverage: {
    title: "Layer Coverage",
    body: "rates — ✓ live curve | credit — skipped",
  },
  overnight: ["AVGO — guided Q4 revenue to $34.8B against a $35.1B estimate."],
  candidates: [
    {
      id: "SPY-2026-09-03-1",
      rationale:
        "Edited: the 40bp curve pays the seller of a 755/760 put spread.",
      // Every one of these is a lie the editor is not allowed to tell. The
      // renderer must keep the tool-derived values and ignore all four.
      spot: 1,
      legs: [
        { right: "call", action: "buy", strike: 9999, expiry: "2030-01-01" },
      ],
      pricing: { net: 99 },
      invalidation: [{ level: 1, side: "above" }],
    },
  ],
  riskList: [{ ticker: "QQQ", reason: "Edited: strikes sat 42% below spot." }],
};

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run-editor-fixture",
    tenant: "option-wizard",
    day: "2026-09-03",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
    steps: [
      {
        task: "regime",
        role: "regime-analyst",
        mode: "model",
        text: JSON.stringify({
          headline: "Regime step's own headline.",
          tape: [{ label: "SPY", value: "768.86" }],
          sections: [
            { title: "Rates", body: "Fragment written by the regime step." },
          ],
        }),
        toolOutputs: [MACRO_TOOL, POLICY_TOOL],
      },
      {
        task: "design",
        role: "structure-designer",
        mode: "model",
        text: "{}",
        toolOutputs: [SPOT_TOOL, LEVELS_TOOL],
      },
      {
        task: "review",
        role: "risk-reviewer",
        mode: "model",
        text: JSON.stringify(REVIEW_JSON),
      },
    ],
    ...overrides,
  } as RunReport;
}

function withEditor(
  text: string,
  overrides: Partial<RunReport> = {},
): RunReport {
  const base = report(overrides);
  return {
    ...base,
    steps: [
      ...base.steps,
      { task: "edit", role: "editor", mode: "model", text },
    ],
  } as RunReport;
}

describe("the editor's document", () => {
  it("falls back to the per-step assembly when there is no edit step", () => {
    const view = buildView(report(), SPEC);
    expect(view.edited).toBeUndefined();
    expect(view.headline).toBe("Regime step's own headline.");
    expect(view.sections[0]?.body).toContain(
      "Fragment written by the regime step",
    );
    expect(view.candidates[0]?.rationale).toBe(
      "Fragment written by the reviewer.",
    );
    expect(view.decision?.[0]?.value).toBe("Reviewer's own call.");
  });

  it("takes the editor's prose over every fragment when there is one", () => {
    const view = buildView(withEditor(JSON.stringify(EDITOR_JSON)), SPEC);
    expect(view.edited).toBe(true);
    expect(view.headline).toBe(EDITOR_JSON.headline);
    expect(view.sections[0]?.title).toBe("Macro read");
    expect(view.sections[0]?.body).toContain(
      "What changed since yesterday's brief",
    );
    expect(view.coverage?.body).toContain("rates — ✓ live curve");
    expect(view.overnight[0]).toContain("AVGO");
    expect(view.decision?.map((row) => row.label)).toEqual(["Call", "Action"]);
    expect(view.riskList[0]?.reason).toContain("Edited:");
  });

  it("keeps the editor's rationale and DISCARDS every number it sent", () => {
    // The one boundary that matters. Eight of eleven model-computed numbers
    // audited on 2026-09-03 were wrong; the editing pass is where prose gets
    // better, never where arithmetic gets re-entered by hand.
    const view = buildView(withEditor(JSON.stringify(EDITOR_JSON)), SPEC);
    const candidate = view.candidates[0]!;
    expect(candidate.rationale).toBe(EDITOR_JSON.candidates[0]!.rationale);
    expect(candidate.spot).toBe(768.86);
    expect(candidate.legs.map((leg) => leg.strike)).toEqual([755, 760]);
    expect(candidate.legs.every((leg) => leg.right === "put")).toBe(true);
    expect(candidate.expiry).toBe("2026-09-30");
    expect(candidate.invalidation).toEqual([{ level: 760, side: "below" }]);
    expect(candidate.id).toBe("SPY-2026-09-03-1");
  });

  it("takes a rationale keyed by the bare ticker when the card is unambiguous", () => {
    // The editor never sees the minted `<TICKER>-<day>-<n>` id: it reads the
    // reviewer's proposals, which carry none. On 2026-09-03 it keyed all three
    // rationales by ticker and all three were dropped on an exact-id miss.
    const view = buildView(
      withEditor(
        JSON.stringify({
          candidates: [{ id: "SPY", rationale: "Keyed by the bare ticker." }],
        }),
      ),
      SPEC,
    );
    expect(view.candidates[0]?.rationale).toBe("Keyed by the bare ticker.");
  });

  it("falls back per FIELD, so a partial document never blanks a section", () => {
    const view = buildView(
      withEditor(JSON.stringify({ headline: "Only the headline." })),
      SPEC,
    );
    expect(view.headline).toBe("Only the headline.");
    // Everything the editor did not write still comes from the steps.
    expect(view.sections[0]?.body).toContain(
      "Fragment written by the regime step",
    );
    expect(view.candidates[0]?.rationale).toBe(
      "Fragment written by the reviewer.",
    );
  });

  it("ignores an edit step that was gate-refused or answered in prose", () => {
    const prose = buildView(
      withEditor("I could not produce JSON today."),
      SPEC,
    );
    expect(prose.edited).toBeUndefined();
    expect(prose.headline).toBe("Regime step's own headline.");

    const refused = report();
    const gated = {
      ...refused,
      steps: [
        ...refused.steps,
        {
          task: "edit",
          role: "editor",
          mode: "model",
          text: JSON.stringify(EDITOR_JSON),
          failure: "gate-refused",
        },
      ],
    } as RunReport;
    expect(buildView(gated, SPEC).edited).toBeUndefined();
  });
});

describe("charts drawn from the tool outputs", () => {
  it("reads the treasury curve off ow_macro_rates' live overlay", () => {
    const chart = buildView(report(), SPEC).charts.yieldCurve!;
    expect(chart.points).toEqual([
      { label: "2y", value: 4.39 },
      { label: "5y", value: 4.54 },
      { label: "10y", value: 4.79 },
      { label: "30y", value: 5.27 },
    ]);
    // Half a point below the lowest tenor. NOT zero: 4.39 and 5.27 differ by
    // 17% of their own size and by everything anyone trades on, and a
    // zero-based axis draws them as the same bar.
    expect(chart.baseline).toBe(4);
    expect(chart.spread2s10s).toBe(40);
  });

  it("prints the axis floor on the chart, so the reader is never misled by it", () => {
    const html = renderReport(report(), SPEC).html;
    expect(html).toContain("Axis starts at 4.00%, not zero");
    expect(html).toContain("2s10s +40.0bp");
    expect(html).toContain("4.790%");
  });

  it("reads the policy path off argon's snapshot, stance and probability intact", () => {
    const chart = buildView(report(), SPEC).charts.policyPath!;
    expect(chart.snapshotDate).toBe("2026-09-02");
    expect(chart.meetings).toEqual([
      {
        label: "9/16",
        stance: "HIKE",
        probability: 60,
        impliedRate: "3.78",
        targetRange: "3.75-4.00%",
      },
      { label: "10/28", stance: "HOLD", probability: 70 },
      { label: "12/9", stance: "HIKE", probability: 64 },
    ]);
    const html = renderReport(report(), SPEC).html;
    expect(html).toContain("HIKE 60%");
    expect(html).toContain("HOLD 70%");
    // The citation travels with the chart: futures-implied, not CME FedWatch.
    expect(html).toContain("not CME FedWatch");
    expect(html).toContain("snapshot 2026-09-02");
  });

  it("profiles gamma per strike, for the candidate tickers only", () => {
    const charts = buildView(report(), SPEC).charts;
    expect(charts.gex).toHaveLength(1);
    const spy = charts.gex[0]!;
    expect(spy.ticker).toBe("SPY");
    expect(spy.spot).toBe(768.86);
    expect(spy.asOf).toBe("2026-09-03");
    // High strike first, so the ladder reads like a chain.
    expect(spy.levels).toEqual([
      {
        label: "Call Wall",
        role: "resistance",
        strike: 770,
        gamma: 75477.6864,
      },
      { label: "Gamma Flip", role: "flip", strike: 766, gamma: 0 },
    ]);
    const html = renderReport(report(), SPEC).html;
    expect(html).toContain("Gamma profile");
    expect(html).toContain("Call Wall");
    expect(html).toContain("770.00");
  });

  it("omits every chart, rather than faking one, when no tool answered", () => {
    const bare = report({
      steps: [
        {
          task: "review",
          role: "risk-reviewer",
          mode: "model",
          text: JSON.stringify(REVIEW_JSON),
        },
      ],
    } as Partial<RunReport>);
    const view = buildView(bare, SPEC);
    expect(view.charts.yieldCurve).toBeUndefined();
    expect(view.charts.policyPath).toBeUndefined();
    expect(view.charts.gex).toEqual([]);
    const html = renderReport(bare, SPEC).html;
    // An empty curve reads as a flat curve, which is a claim about the market
    // rather than about the run. There is no axis, no heading and no bar.
    expect(html).not.toContain("Rates &amp; policy path");
    expect(html).not.toContain("Gamma profile");
    expect(html).not.toContain("Axis starts at");
  });

  it("draws no gamma profile for a ticker with no candidate card", () => {
    // LEVELS_TOOL answers for SPY; this run's only surviving proposal is QQQ,
    // so the profile is for a decision the reader does not have to make.
    const other = report({
      steps: [
        {
          task: "design",
          role: "structure-designer",
          mode: "model",
          text: "{}",
          toolOutputs: [LEVELS_TOOL],
        },
        {
          task: "review",
          role: "risk-reviewer",
          mode: "model",
          text: JSON.stringify({ proposals: [], riskList: [] }),
        },
      ],
    } as Partial<RunReport>);
    expect(buildView(other, SPEC).charts.gex).toEqual([]);
  });
});

describe("the mail still fits", () => {
  it("stays under Gmail's 102 KB clip with five candidates, eight risk rows and every chart", () => {
    const proposals = ["SPY", "QQQ", "IWM", "NVDA", "MSFT"].map((ticker) => ({
      ticker,
      strategy: "put credit spread",
      invalidation: [{ level: 760, side: "below" }],
      target: "50% of max credit",
      rationale:
        "An edited rationale of realistic length, long enough that five of them are not a rounding error against the clip limit. ".repeat(
          3,
        ),
      legs: [
        {
          right: "put",
          action: "buy",
          strike: 755,
          expiry: "2026-09-30",
          mid: 4.1,
        },
        {
          right: "put",
          action: "sell",
          strike: 760,
          expiry: "2026-09-30",
          mid: 5.4,
        },
      ],
    }));
    // Every ticker priced at SPY's own frozen spot: the point of this test is
    // the BYTE COUNT of five rendered cards, and a per-ticker spot fixture
    // would be five real quotes fetched to measure a length.
    const spots = JSON.stringify({
      quotes: proposals.map((row) => ({ ticker: row.ticker, last: 768.86 })),
    });
    const levels = JSON.stringify({
      source: "argon",
      levels: proposals.map((row) => ({
        ...JSON.parse(LEVELS_TOOL).levels[0],
        ticker: row.ticker,
      })),
    });
    const riskList = Array.from({ length: 8 }, (_row, index) => ({
      ticker: `R${String(index)}`,
      reason:
        "strike 410 is more than 25% from spot 768.86; leg order not checked",
    }));
    const big = report({
      steps: [
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: "{}",
          toolOutputs: [MACRO_TOOL, POLICY_TOOL],
        },
        {
          task: "design",
          role: "structure-designer",
          mode: "model",
          text: "{}",
          toolOutputs: [spots, levels],
        },
        {
          task: "review",
          role: "risk-reviewer",
          mode: "model",
          text: JSON.stringify({
            proposals,
            riskList,
            decision: EDITOR_JSON.decision,
          }),
        },
      ],
    } as Partial<RunReport>);
    const view = buildView(big, SPEC);
    expect(view.candidates).toHaveLength(5);
    expect(view.riskList).toHaveLength(8);
    expect(view.charts.gex).toHaveLength(5);
    const bytes = Buffer.byteLength(renderReport(big, SPEC).html, "utf8");
    // 90 KB, not 102: Gmail clips at 102 KB and the quoting/encoding overhead
    // of the send is not counted here.
    expect(bytes).toBeLessThan(90_000);
  });
});

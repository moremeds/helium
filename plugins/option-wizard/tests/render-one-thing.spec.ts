/**
 * The One Thing and review document schemas, and the per-field budgets.
 *
 * Every cap here is a declared number, not market data. The one real figure is
 * SPY's 2026-09-03 close, used so the sample document reads like the thing it
 * models rather than like a lorem paragraph.
 */
import { describe, expect, it } from "vitest";
import {
  ONE_THING_BUDGET,
  PERSISTENCE_BUDGET,
  REVIEW_BUDGET,
  measureOneThing,
  measureReview,
  trim,
  words,
} from "../render/budget.js";
import { channelMetrics, parseOneThingDoc } from "../render/one-thing.js";
import { parseReviewDoc } from "../render/review.js";
import { buildView } from "../render/index.js";
import { LEVEL_METRIC, MOVE_METRIC } from "../quality/history.js";
import { SPEC, report } from "./fixture-report.js";

const doc = (over: Record<string, unknown> = {}) => ({
  headline: "Duration led the tape into the meeting",
  oneThing:
    "The 10Y fell 0.8 bp to 4.772 %. It is the largest normalised move of the session. Dealers hedging a short gamma book buy into strength. Anyone short duration into the print pays for it.",
  changeMyMind: {
    text: "a 10Y above 4.85 kills the duration read",
    series: "DGS10",
    threshold: ">4.85",
    horizon: "5 sessions",
  },
  checks: [
    { series: "DGS10", level: "4.772", text: "10Y holds under 4.80" },
    { series: "DGS2", level: "4.34", text: "front end does not lead" },
    { series: "VIXCLS", level: "14.32", text: "vol stays bid" },
  ],
  everythingElse: ["Gold +1.89 % to 4,471.34", "DXY 98.977, down 0.599"],
  rationales: [{ id: "SPY-2026-09-03-2", text: "SPY closed 773.17" }],
  ...over,
});

describe("parseOneThingDoc", () => {
  it("parses all six fields with no problems", () => {
    const parsed = parseOneThingDoc(doc());
    expect(parsed.problems).toEqual([]);
    expect(parsed.doc?.checks.length).toBe(3);
    expect(parsed.doc?.changeMyMind?.horizon).toBe("5 sessions");
    expect(parsed.doc?.everythingElse.length).toBe(2);
    expect(parsed.doc?.rationales[0]?.id).toBe("SPY-2026-09-03-2");
  });

  it("drops an incomplete invalidation whole and names the missing field", () => {
    const parsed = parseOneThingDoc(
      doc({
        changeMyMind: {
          text: "a 10Y above 4.85 kills it",
          series: "DGS10",
          threshold: ">4.85",
        },
      }),
    );
    expect(parsed.doc?.changeMyMind).toBeUndefined();
    expect(parsed.problems).toContain("changeMyMind: missing horizon");
    // The rest still parses.
    expect(parsed.doc?.checks.length).toBe(3);
  });

  it("keeps two checks and says two of three", () => {
    const parsed = parseOneThingDoc(doc({ checks: doc().checks.slice(0, 2) }));
    expect(parsed.doc?.checks.length).toBe(2);
    expect(parsed.problems).toContain("checks: 2 of 3");
  });

  it("returns null for something that is not a document", () => {
    expect(parseOneThingDoc("nope").doc).toBeNull();
  });
});

describe("measureOneThing", () => {
  const long = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it("flags a 260-word lead item against 180", () => {
    const { overages } = measureOneThing(doc({ oneThing: long(260) }));
    expect(overages).toContainEqual({
      what: "oneThing",
      words: 260,
      limit: ONE_THING_BUDGET.oneThingWords,
      firstSentenceOver: true,
    });
  });

  it("halves the lead item under the persistence mode", () => {
    const { overages } = measureOneThing(
      doc({ oneThing: long(120) }),
      "persistence",
    );
    expect(overages.find((row) => row.what === "oneThing")?.limit).toBe(
      PERSISTENCE_BUDGET.oneThingWords,
    );
  });

  it("counts the checks and the else lines", () => {
    const measured = measureOneThing(
      doc({
        everythingElse: Array.from(
          { length: 7 },
          (_, i) => `line ${String(i)}`,
        ),
      }),
    );
    expect(measured.checkCount).toBe(3);
    expect(measured.elseCount).toBe(7);
  });
});

describe("trim", () => {
  it("cuts a four-beat paragraph at the last full stop and appends nothing", () => {
    const cut = trim(doc().oneThing, 24);
    expect(cut.cut).toBe("sentence");
    expect(cut.text.endsWith("…")).toBe(false);
    expect(cut.text.endsWith("session.")).toBe(true);
  });
});

describe("parseReviewDoc", () => {
  const review = (over: Record<string, unknown> = {}) => ({
    review: "The duration call held; the front-end call did not.",
    outlook: "Duration continues unless the 10Y takes out 4.85.",
    catalysts: "9/16 FOMC.",
    coverage: [
      {
        id: "rates.long",
        token: "continue",
        p: 0.65,
        why: "the long end led again",
        observable: "DGS10 next print",
      },
    ],
    focus: [{ ticker: "NVDA", why: "earnings 2026-11-18" }],
    themes: [
      { id: "el-nino-ag-2026", leadership: "mixed", why: "DBA led, DE lagged" },
    ],
    ...over,
  });

  it("parses the seven fields it owns", () => {
    const parsed = parseReviewDoc(review());
    expect(parsed.problems).toEqual([]);
    expect(parsed.doc?.coverage[0]?.scorable).toBe(true);
    expect(parsed.doc?.focus[0]?.ticker).toBe("NVDA");
    expect(parsed.doc?.themes[0]?.leadership).toBe("mixed");
  });

  it("keeps a row with an unusable probability but never scores it", () => {
    const parsed = parseReviewDoc(
      review({
        coverage: [{ ...review().coverage[0], p: 0.99 }],
      }),
    );
    expect(parsed.doc?.coverage.length).toBe(1);
    expect(parsed.doc?.coverage[0]?.scorable).toBe(false);
    expect(parsed.doc?.coverage[0]?.p).toBeUndefined();
    expect(parsed.problems.join(" ")).toContain("mints no commitment");
  });

  it("refuses a token and a leadership word it does not know", () => {
    const parsed = parseReviewDoc(
      review({
        coverage: [{ ...review().coverage[0], token: "moon" }],
        themes: [{ id: "el-nino-ag-2026", leadership: "great", why: "x" }],
      }),
    );
    expect(parsed.doc?.coverage).toEqual([]);
    expect(parsed.doc?.themes).toEqual([]);
    expect(parsed.problems.length).toBe(2);
  });
});

describe("measureReview", () => {
  const long = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  it("flags the same prose at 300 weekly and 120 daily", () => {
    const body = { review: long(380) };
    expect(measureReview(body, REVIEW_BUDGET.weekly).overages[0]?.limit).toBe(
      300,
    );
    expect(measureReview(body, REVIEW_BUDGET.daily).overages[0]?.limit).toBe(
      120,
    );
  });

  it("flags an over-long row, focus and theme clause", () => {
    const measured = measureReview(
      {
        coverage: [{ id: "rates.long", why: long(22), observable: "ok" }],
        focus: [{ ticker: "NVDA", why: long(44) }],
        themes: [{ id: "el-nino-ag-2026", why: long(30) }],
      },
      REVIEW_BUDGET.weekly,
    );
    expect(measured.rowCount).toBe(1);
    expect(measured.focusCount).toBe(1);
    const what = measured.overages.map((row) => row.what);
    expect(what.some((row) => row.startsWith("rowWords"))).toBe(true);
    expect(what.some((row) => row.startsWith("focusWords"))).toBe(true);
    expect(what.some((row) => row.startsWith("themeWords"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the rendering half
// ---------------------------------------------------------------------------

describe("buildView over a frame and an edit step", () => {
  const frame = (over: Record<string, unknown> = {}) => ({
    kind: "session-frame/1",
    day: "2026-09-02",
    mode: "ratio",
    why: "largest normalised move of the session, 3.3x its 20-session median",
    ranked: [
      {
        id: "rates",
        series: "DGS10",
        level: "4.772",
        prior: "4.78",
        move: "-0.8 bp",
        delta: -0.8,
        score: 3.3,
        medianSource: 1,
        asOf: "2026-09-03T20:15:31Z",
      },
      {
        id: "vol",
        series: "VIXCLS",
        score: null,
        medianSource: null,
        excluded: "VIXCLS not ingested",
      },
    ],
    rows: [],
    focus: {
      weekly: [],
      daily: [],
      churn: 0,
      carried: [],
      dropped: [],
      notes: [],
      weightsNote: "weights: declared prior 2026-09-06",
    },
    checks: {
      line: "Yesterday: 2 hit, 1 not observed.",
      scored: [
        { series: "DGS10", level: "4.78", text: "a", verdict: "hit" },
        { series: "DGS2", level: "4.34", text: "b", verdict: "hit" },
        { series: "X", level: "1", text: "c", verdict: "not-observed" },
      ],
    },
    ledger: { settledToday: [], open: [], totalCommitments: 0 },
    caps: { weekly: REVIEW_BUDGET.weekly, daily: REVIEW_BUDGET.daily },
    declared: { coverage: [], sectors: [], themes: [] },
    coverage: [
      {
        layer: "macro",
        source: "ow_macro_rates",
        asOf: "2026-09-03T20:15:31Z",
        state: "ok",
      },
      {
        layer: "gex",
        source: "ow_uw_gex",
        state: "skipped",
        reason: "the Unusual Whales exposure endpoints as used here has no history",
      },
    ],
    ...over,
  });

  const run = (args: { frame?: Record<string, unknown>; doc?: Record<string, unknown> }) =>
    buildView(
      report({
        steps: [
          {
            task: "frame",
            role: "frame-clerk",
            mode: "deterministic",
            text: "",
            toolOutputs: [JSON.stringify(args.frame ?? frame())],
          },
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(args.doc ?? doc()),
          },
        ],
      } as never),
      SPEC,
    );

  it("trims the lead item and copies the frame's why character for character", () => {
    const long = Array.from({ length: 260 }, () => "word").join(" ");
    const view = run({ doc: doc({ oneThing: `${long}.` }) });
    expect(view.oneThing?.title).toBe("The one thing");
    expect(words(view.oneThing!.body)).toBeLessThanOrEqual(
      ONE_THING_BUDGET.oneThingWords,
    );
    expect(view.oneThing?.why).toBe(frame().why);
    expect(view.oneThing?.checksLine).toBe(frame().checks.line);
  });

  it("drops an incomplete invalidation and flags it", () => {
    const view = run({
      doc: doc({
        changeMyMind: {
          text: "a 10Y above 4.85 kills it",
          series: "DGS10",
          horizon: "5 sessions",
        },
      }),
    });
    expect(view.changeMyMind).toBeUndefined();
    expect(view.faults?.join(" ")).toContain("invalidation incomplete");
  });

  it("halves the lead item and the else list under the persistence mode", () => {
    const long = Array.from({ length: 200 }, () => "word").join(" ");
    const view = run({
      frame: frame({ mode: "persistence", streak: 4 }),
      doc: doc({
        oneThing: `${long}.`,
        everythingElse: Array.from({ length: 6 }, (_, i) => `line ${String(i)}`),
      }),
    });
    expect(words(view.oneThing!.body)).toBeLessThanOrEqual(
      PERSISTENCE_BUDGET.oneThingWords,
    );
    expect(view.everythingElse?.length).toBe(PERSISTENCE_BUDGET.elseLines);
  });

  it("keeps an editor lead on a day nothing could be ranked", () => {
    const view = run({ frame: frame({ mode: "no-data" }) });
    expect(view.oneThing?.body).toContain("10Y fell");
    expect(view.footer?.notes.join(" ")).toContain("ow_uw_gex");
  });

  it("copies each source's own as-of verbatim into the footer", () => {
    const view = run({});
    expect(view.footer?.asOf).toContain(
      "ow_macro_rates — 2026-09-03T20:15:31Z",
    );
    expect(view.footer?.coverage.some((row) => row.startsWith("gex —"))).toBe(
      true,
    );
  });

  it("renders exactly as before when there is no frame", () => {
    const view = buildView(
      report({
        steps: [
          {
            task: "edit",
            role: "editor",
            mode: "model",
            text: JSON.stringify(doc()),
          },
        ],
      } as never),
      SPEC,
    );
    expect(view.footer).toBeUndefined();
    expect(view.oneThing?.why).toBe("");
  });
});

describe("channel metric rows", () => {
  it("writes one row per channel, null for the excluded ones", () => {
    const rows = channelMetrics({
      frame: {
        mode: "ratio",
        why: "",
        ranked: [
          {
            id: "rates",
            series: "DGS10",
            delta: -0.8,
            score: 3.3,
            medianSource: 1,
          },
          {
            id: "vol",
            series: "VIXCLS",
            score: null,
            medianSource: null,
            excluded: "VIXCLS not ingested",
          },
        ],
        checks: {
          line: "",
          scored: [{ verdict: "hit" }, { verdict: "miss" }],
        },
        coverage: [],
      },
      moveMetric: MOVE_METRIC,
      order: ["rates", "vol"],
      proseWords: 123,
      invalidationComplete: true,
    });
    const by = new Map(rows.map((row) => [row.name, row.value]));
    // The MOVE row names ARE quality/history.ts's, because those are the names
    // channelHistory reads back as next session's denominator.
    expect(by.get(MOVE_METRIC.rates)).toBe(-0.8);
    expect(by.get(MOVE_METRIC.vol)).toBeNull();
    expect(by.get("channel.rates.score")).toBe(3.3);
    expect(by.get("channel.vol.medianSource")).toBeNull();
    expect(by.get("select.top.score")).toBe(3.3);
    expect(by.get("select.mode")).toBe(0);
    expect(by.get("select.streak.sessions")).toBeNull();
    expect(by.get("checks.scored")).toBe(2);
    expect(by.get("checks.hit")).toBe(1);
    expect(by.get("checks.miss")).toBe(1);
    expect(by.get("checks.notObserved")).toBe(0);
    expect(by.get("brief.proseWords")).toBe(123);
    expect(by.get("brief.invalidationComplete")).toBe(1);
  });

  // Nothing wrote these three rows until 2026-09-06, so `policy.path`, `flow`
  // and `curve.shape` had no prior to difference against — on any run, ever.
  // The level is stored EVEN for an excluded channel: "no prior observation
  // for the policy path" is exactly the state the row exists to end.
  it("stores the level of the three channels whose payload carries no prior", () => {
    const rows = channelMetrics({
      frame: {
        mode: "ratio",
        why: "",
        ranked: [
          {
            id: "policy",
            series: "9/16 hike probability",
            level: "60",
            score: null,
            medianSource: null,
            excluded: "no prior observation for the policy path",
          },
          {
            id: "flow",
            series: "market tide net premium",
            level: "39758465",
            score: 1,
            medianSource: 0,
          },
          { id: "rates", series: "DGS10", level: "4.77", score: 1, medianSource: 0 },
        ],
        checks: { line: "", scored: [] },
        coverage: [],
      },
      moveMetric: MOVE_METRIC,
      levelMetric: LEVEL_METRIC,
      order: ["policy", "flow", "rates"],
      proseWords: 0,
      invalidationComplete: false,
    });
    const by = new Map(rows.map((row) => [row.name, row.value]));
    expect(by.get(LEVEL_METRIC.policy!)).toBe(60);
    expect(by.get(LEVEL_METRIC.flow!)).toBe(39758465);
    // A FRED series carries yesterday inside its own payload, so it needs no
    // stored level and gets no row.
    expect(by.has("channel.rates.level")).toBe(false);
    expect(LEVEL_METRIC.rates).toBeUndefined();
  });
});

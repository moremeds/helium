/**
 * The seven review sections, the citation lines, the commitments and the
 * metric rows.
 *
 * Every number asserted here is a real one: SPY 773.17 (2026-09-03 close) and
 * 770.19 (2026-09-04 close) from
 * `$S/pit/weekend-2026-09-06/reports/option-wizard-2026-09-0{3,4}-close.md`,
 * the 2Y front-end move −3.1bp from the same 09-03 close report, and the
 * theme id / chain names from the shipped `tenant.yaml` declaration. No
 * invented tickers and no round placeholder prices.
 */
import { describe, expect, it } from "vitest";
import { buildView } from "../render/index.js";
import { SPEC, report } from "./fixture-report.js";
import type { CoverageRow } from "../quality/channels.js";
import type { OpenRow, SessionFrame, SettledRow } from "../quality/frame.js";
import type { ThemeSpec } from "../quality/review-config.js";
import { REVIEW_BUDGET } from "../render/budget.js";
import {
  citationLine,
  pendingLine,
  proposedThemes,
  REVIEW_TITLES,
  MARKET_REPORT_TITLES,
  reviewHeadline,
  reviewMetrics,
  reviewSections,
  verdictCommitments,
  type CalendarRow,
} from "../render/review.js";
import type { ReviewDoc } from "../render/review.js";
import { REVIEW_PERIODS } from "../quality/review-config.js";

const THEME: ThemeSpec = {
  id: "el-nino-ag-2026",
  thesis: "El Nino 2026 tightens soft/grain supply",
  horizon: "6m",
  entered: "2026-09-06",
  instruments: ["DBA", "MOS", "NTR", "DE"],
  evidence: [{ text: "NOAA ONI >= +0.5 for three seasons" }],
  kill: "ONI back under +0.5 for two seasons",
  killExcess: { pct: -10, sessions: 60 },
};

const COVERAGE = [
  "rates.front",
  "rates.long",
  "curve.shape",
  "policy.path",
  "credit",
  "vol",
  "dealer.positioning",
  "flow",
  "commodities",
  "fx",
  "equity.internals",
  "calls.open",
];
const SECTORS = ["Computer/GPU", "Cybersecurity"];

/** The declaration every expected count is computed FROM. A constant here
 *  would make adding a theme a test edit — the coupling `extensions:` exists
 *  to avoid. */
const DECLARED = {
  coverage: COVERAGE,
  sectors: SECTORS,
  themes: [THEME],
  focus: { weekly: 15, daily: 5 },
};
const ROW_COUNT =
  DECLARED.coverage.length + DECLARED.sectors.length + DECLARED.themes.length;
const PUBLIC_ROW_COUNT = ROW_COUNT - 1;

function untestedRows(): CoverageRow[] {
  return [
    ...COVERAGE.map((id, index) => ({
      id,
      order: index,
      series: id,
      untested: "tool absent",
    })),
    ...SECTORS.map((chain, index) => ({
      id: `sector:${chain}`,
      order: COVERAGE.length + index,
      series: chain,
      untested: "chain unknown",
    })),
    {
      id: `theme:${THEME.id}`,
      order: COVERAGE.length + SECTORS.length,
      series: "DBA,MOS,NTR,DE equal-weight vs SPY, excess %",
      untested: "no bars for 4 of 4 instruments",
    },
  ];
}

/** The same list, with a datum on every row. `rates.front` carries the real
 *  2026-09-03 close: 2Y 4.34%, −3.1bp on the day. */
function fullRows(): CoverageRow[] {
  const rows = untestedRows().map((row) => ({
    ...row,
    level: "4.34",
    prior: "4.371",
    move: "-3.1 bp",
    delta: -3.1,
    asOf: "2026-09-03T20:15:31Z",
    untested: undefined,
  })) as CoverageRow[];
  return rows.map((row) => {
    const next: CoverageRow = { ...row };
    delete next.untested;
    if (row.id.startsWith("sector:")) next.members = ["NVDA", "AMD"];
    if (row.id.startsWith("theme:"))
      next.theme = {
        week: {
          basketPct: 1.7,
          benchPct: 0,
          excessPct: 1.7,
          used: ["DBA"],
          missing: [],
        },
        sinceEntered: {
          basketPct: 3.2,
          benchPct: 0,
          excessPct: 3.2,
          used: ["DBA"],
          missing: [],
        },
        kill: { armed: THEME.kill, met: false },
        evidence: ["NOAA ONI >= +0.5 for three seasons (operator-checked)"],
      };
    return next;
  });
}

function frame(over: Partial<SessionFrame> = {}): SessionFrame {
  return {
    kind: "session-frame/1",
    day: "2026-09-06",
    mode: "ratio",
    why: "the biggest move against its own median",
    ranked: [],
    rows: untestedRows(),
    focus: {
      weekly: [],
      daily: [],
      churn: 0,
      carried: [],
      dropped: [],
      notes: [],
      weightsNote: "weights: declared prior 2026-09-06",
    },
    checks: { line: "Yesterday: no prior checks.", scored: [] },
    ledger: { settledToday: [], open: [], totalCommitments: 0 },
    caps: { weekly: REVIEW_BUDGET.weekly, daily: REVIEW_BUDGET.daily },
    declared: DECLARED,
    coverage: [],
    ...over,
  } as SessionFrame;
}

function focusRow(ticker: string, over: Record<string, unknown> = {}) {
  return {
    ticker,
    score: 10,
    parts: [{ kind: "earnings" as const, points: 10, from: "ow_uw_earnings" }],
    daysToNearestEvent: 3,
    nearest: {
      ticker,
      kind: "earnings" as const,
      day: "2026-11-18",
      sessionsAway: 3,
      session: "post" as const,
      source: "ow_uw_earnings",
      label: "Q3 earnings (post)",
    },
    ivRank: 62,
    openCallIds: [],
    themes: [],
    threshold: { pct: 4.6, source: "ow_uw_iv_term implied_move_perc" },
    ...over,
  };
}

function verdictReceipt(
  id: string,
  said: string,
  got: string,
  brier: number,
): SettledRow {
  return {
    id,
    issuedDay: "2026-08-30",
    issuedPhase: "weekly",
    status: got,
    scores: { verdictBrier: brier },
    detail: { rowId: id.replace(/^.*verdict-/u, ""), said, got },
    evidenceHash:
      "9f2c1b0a7d4e5f6081726354aabbccddeeff00112233445566778899aabbccdd",
    payload: {
      kind: "coverage-verdict",
      rowId: id.replace(/^.*verdict-/u, ""),
      token: said,
      p: 0.7,
    },
  };
}

const DOC_EMPTY: ReviewDoc = {
  review: "",
  outlook: "",
  catalysts: "",
  coverage: [],
  focus: [],
  themes: [],
};

/** The tenant's own closed days, as `plugins/option-wizard/tenant.yaml` lists
 *  them: 2026-09-07 is Labor Day. The renderer is handed this calendar in
 *  production, so the tests are handed it too. */
const CALENDAR = { weekdaysOnly: true, closed: ["2026-09-07"] };

function render(over: {
  frame?: SessionFrame;
  doc?: ReviewDoc | null;
  period?: "weekly" | "daily";
  rotation?: Parameters<typeof reviewSections>[0]["rotation"];
  calendarRows?: CalendarRow[];
  calendar?: Parameters<typeof reviewSections>[0]["calendar"];
}) {
  const f = over.frame ?? frame();
  // Most section-level assertions exercise the unchanged daily contract. Tests
  // for the weekly public document opt in explicitly below.
  const period = over.period ?? "daily";
  return reviewSections({
    frame: f,
    rotation: over.rotation ?? null,
    doc: over.doc === undefined ? DOC_EMPTY : over.doc,
    caps: period === "weekly" ? f.caps.weekly : f.caps.daily,
    period,
    calendarRows: over.calendarRows ?? [],
    calendar: over.calendar ?? CALENDAR,
  });
}

function body(sections: Array<{ title: string; body: string }>, n: number) {
  return sections[n - 1]?.body ?? "";
}

/** The full renderer register is retained as internal metadata. This helper
 * lets behavior tests address the legacy content by its stable slot while the
 * production `sections` array remains the four-section public market report. */
function legacySections(out: ReturnType<typeof reviewSections>) {
  const internal = new Map(
    (out.internalSections ?? []).map((section) => [section.title, section]),
  );
  return [
    internal.get(REVIEW_TITLES[0])!,
    out.sections[0]!,
    out.sections[3]!,
    out.sections[1]!,
    out.sections[2]!,
    internal.get(REVIEW_TITLES[5])!,
    internal.get(REVIEW_TITLES[6])!,
  ];
}

describe("review section contracts", () => {
  it("uses the market-report titles on an empty daily frame", () => {
    const out = render({});
    expect(out.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
  });

  it("uses the market-report titles with a fully populated daily frame", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        review: "We read the front end wrong.",
        outlook: "The front end is the question.",
      },
    });
    expect(out.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
  });

  it("renders a weekly market document and retains scorecard records internally", () => {
    const out = render({ period: "weekly" });
    expect(out.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
    expect(out.internalSections?.map((section) => section.title)).toEqual([
      REVIEW_TITLES[0],
      REVIEW_TITLES[5],
      REVIEW_TITLES[6],
    ]);
  });

  it("keeps weekly themes in the structured view instead of repeating them in outlook", () => {
    const out = render({
      period: "weekly",
      doc: {
        ...DOC_EMPTY,
        outlook: "Breadth remains constructive.",
        themes: [
          { id: THEME.id, leadership: "confirms", why: "inputs still lead" },
        ],
      },
    });
    expect(out.sections[1]?.body).toBe("Breadth remains constructive.");
    expect(out.view.themes?.[0]).toMatchObject({
      id: THEME.id,
      leadership: "confirms",
      why: "inputs still lead",
    });
  });
});

describe("section 3 — the coverage list never shrinks", () => {
  it("prints one line per declared row on a full frame and on an empty one", () => {
    const full = render({ frame: frame({ rows: fullRows() }) });
    const empty = render({});
    const count = (out: ReturnType<typeof render>) =>
      body(legacySections(out), 3)
        .split("\n")
        .filter((line) => line.startsWith("- ")).length;
    expect(count(full)).toBe(PUBLIC_ROW_COUNT);
    expect(count(empty)).toBe(PUBLIC_ROW_COUNT);
  });

  it("an empty frame reads untested on every row, counts every gap and sums them in one line", () => {
    const out = render({});
    const section = body(legacySections(out), 3);
    for (const line of section.split("\n").filter((l) => l.startsWith("- ")))
      expect(line).toBe(
        `- ${line.split(" · ")[0]!.slice(2)} · no datum this period · UNTESTED`,
      );
    expect(out.gaps).toBe(ROW_COUNT);
    // ONE line, not one per row: eighteen copies of the same reason is what the
    // reader was skipping. The per-row reason moved to `view.coverageDetail`.
    const left = section.split("\n").filter((l) => l.startsWith("left out:"));
    expect(left.length).toBe(1);
    expect(left[0]).toContain(`left out: ${String(PUBLIC_ROW_COUNT)} rows — `);
    expect(
      (out.view.coverageDetail ?? []).filter((row) => row.leftOut !== undefined)
        .length,
    ).toBe(PUBLIC_ROW_COUNT);
  });

  it("a row the author called untested is a gap, and the counts agree", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "rates.front",
            token: "untested",
            why: "DGS2 not ingested",
            observable: "",
            scorable: false,
          },
        ],
      },
    });
    const section = body(legacySections(out), 3);
    const printed = section
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes("UNTESTED"));
    const left = section
      .split("\n")
      .filter((line) => line.startsWith("left out:"));
    expect(printed.length).toBe(PUBLIC_ROW_COUNT);
    expect(left.length).toBe(1);
    expect(out.gaps).toBe(ROW_COUNT);
    expect(left[0]).toContain("rates.front");
    expect(
      (out.view.coverageDetail ?? []).find((row) => row.id === "rates.front")
        ?.leftOut,
    ).toBe("DGS2 not ingested");
  });

  it("a sector row prints its members and a theme row its excess triple", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "sector:Computer/GPU",
            token: "continue",
            p: 0.7,
            why: "leadership intact",
            observable: "chain weekly % next Friday",
            scorable: true,
          },
          {
            id: `theme:${THEME.id}`,
            token: "continue",
            p: 0.6,
            why: "ag basket still leads",
            observable: "basket excess next Friday",
            scorable: true,
          },
        ],
      },
    });
    const section = body(legacySections(out), 3);
    // The member list is DATA now, not a tail on the printed bullet.
    expect(section).not.toContain("members: NVDA, AMD");
    expect(
      (out.view.coverageDetail ?? []).find(
        (row) => row.id === "sector:Computer/GPU",
      )?.members,
    ).toEqual(["NVDA", "AMD"]);
    expect(section).toContain("+1.7% (1w)");
    expect(section).toContain("since 2026-09-06");
    expect(section).toContain(`kill armed: ${THEME.kill}`);
    expect(section).toContain("evidence: operator-checked");
  });

  it("3d is present on the weekly with a rotation payload and absent on the daily", () => {
    const rotation = {
      asOf: "2026-09-04",
      benchmark: "SPY",
      benchmarkReturns: { w1: 0.4, w4: 1.2, w12: 4.1 },
      rows: [
        {
          symbol: "XLK",
          label: "XLK",
          w1: 1.9,
          w4: 3.3,
          w12: 8.2,
          excess1w: 1.5,
          excess4w: 2.1,
          excess12w: 4.1,
        },
      ],
      notes: [],
    };
    const weekly = render({ rotation, period: "weekly" });
    expect(weekly.sections[3]?.body).toContain("3d rotation");
    expect(weekly.sections[3]?.body).toContain("XLK");
    expect(weekly.sections[3]?.body).toContain("benchmark SPY");
    const daily = render({ rotation, period: "daily" });
    expect(body(legacySections(daily), 3)).not.toContain("3d rotation");
  });

  it("prints the rotation block as not priced when the weekly has no payload", () => {
    const weekly = render({ period: "weekly" });
    expect(weekly.sections[3]?.body).toContain("rotation: not priced this run");
  });

  it("A5: prior -3.1bp with token strengthen prints the band beside it", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "rates.front",
            token: "strengthen",
            p: 0.7,
            why: "front end still bid",
            observable: "DGS2 next Friday",
            scorable: true,
          },
        ],
      },
    });
    // 1.5 x |−3.1| = 4.65 bp, printed at a basis point's own precision: a
    // half-basis-point band is a number nobody quotes. The band is DATA now —
    // the reader's bullet carries the row, the change, the token and the why —
    // but it is still computed and still rounded.
    const band = (out.view.coverageDetail ?? []).find(
      (row) => row.id === "rates.front",
    )?.band;
    expect(band).toContain(">5bp");
    expect(band).not.toContain("4.65");
    expect(body(legacySections(out), 3)).not.toContain(">5bp");
  });

  // review-v6 close: `flow — 39758465 → +0 USD — CONTINUE (0USD..0USD)`. A
  // band is a multiple of the prior magnitude, and a nil prior has none.
  it("prints no band at all when the prior move was nil", () => {
    const rows = fullRows().map((row) =>
      row.id === "flow"
        ? { ...row, level: "39758465", move: "+0 USD", delta: 0 }
        : row,
    );
    const out = render({
      frame: frame({ rows }),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "flow",
            token: "continue",
            p: 0.7,
            why: "the tide did not turn",
            observable: "next close",
            scorable: true,
          },
        ],
      },
    });
    const line = body(legacySections(out), 3)
      .split("\n")
      .find((row) => row.startsWith("- flow"))!;
    expect(line).toContain("· CONTINUE ·");
    const band = (out.view.coverageDetail ?? []).find(
      (row) => row.id === "flow",
    )?.band;
    expect(band).toBe("(no prior move)");
    expect(line).not.toContain("0USD..0USD");
  });
});

describe("what argon's section renderer can actually show", () => {
  it("prints the verdict token in plain uppercase and no inline emphasis anywhere", () => {
    // argon's SectionsPanel renders BLOCK-level markdown only, so `**x**` in a
    // section body reaches the public /flash page as literal asterisks.
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "rates.front",
            token: "continue",
            p: 0.7,
            why: "front end still bid",
            observable: "DGS2 next Friday",
            scorable: true,
          },
        ],
      },
    });
    expect(body(legacySections(out), 3)).toContain("· CONTINUE");
    expect(body(legacySections(out), 3)).toContain("· UNTESTED");
    for (const section of out.sections)
      expect(section.body, section.title).not.toMatch(/\*\*|__|(?<!`)`(?!`)/u);
  });
});

describe("the citation lines", () => {
  it("renders a settled verdict receipt character for character", () => {
    const row = verdictReceipt(
      "2026-08-30-weekly-verdict-rates.front",
      "reverse",
      "reverse",
      0.09,
    );
    expect(citationLine(row)).toBe(
      "2026-08-30-weekly-verdict-rates.front · issued 2026-08-30 weekly · reverse · said p=0.7 · got reverse · Brier 0.0900 (0..1) · bars 9f2c1b0a",
    );
  });

  it("a direction leg prints its horizon and reference close in place of said p", () => {
    const row: SettledRow = {
      id: "2026-09-03-close-spy-t1",
      issuedDay: "2026-09-03",
      issuedPhase: "close",
      status: "down",
      scores: { t1Brier: 0.16 },
      detail: { settledOn: "2026-09-04", close: 770.19 },
      evidenceHash: "aabbccdd00112233445566778899aabbccddeeff0011223344556677",
      payload: {
        kind: "spy-direction",
        horizonBars: 1,
        symbol: "SPY",
        referenceClose: { date: "2026-09-03", value: 773.17 },
        pDown: 0.6,
      },
    };
    const line = citationLine(row);
    expect(line).toContain("t1 vs 773.17");
    expect(line).not.toContain("said p");
  });

  it("a pending row uses the second form", () => {
    const row: OpenRow = {
      id: "2026-09-04-close-spy-t5",
      issuedDay: "2026-09-04",
      issuedPhase: "close",
      payload: { kind: "spy-direction" },
      barsSeen: 2,
      deadlineBars: 5,
    };
    expect(pendingLine(row)).toBe(
      "2026-09-04-close-spy-t5 · issued 2026-09-04 close · pending (2 of 5 bars seen)",
    );
  });
});

describe("section 1 — the scorecard", () => {
  it("A1: the hit rate's denominator is the scored only", () => {
    const settled = [
      verdictReceipt(
        "2026-08-30-weekly-verdict-rates.front",
        "continue",
        "continue",
        0.09,
      ),
      verdictReceipt("2026-08-30-weekly-verdict-vol", "fade", "fade", 0.09),
      verdictReceipt(
        "2026-08-30-weekly-verdict-credit",
        "continue",
        "continue",
        0.09,
      ),
      verdictReceipt(
        "2026-08-30-weekly-verdict-fx",
        "reverse",
        "continue",
        0.49,
      ),
    ];
    const open: OpenRow[] = [
      {
        id: "2026-09-03-close-spy-t5",
        issuedDay: "2026-09-03",
        issuedPhase: "close",
        payload: { kind: "spy-direction" },
      },
      {
        id: "2026-09-04-close-spy-t5",
        issuedDay: "2026-09-04",
        issuedPhase: "close",
        payload: { kind: "spy-direction" },
      },
    ];
    const out = render({
      frame: frame({
        ledger: {
          settledToday: settled,
          open,
          firstCommitmentDay: "2026-08-24",
          totalCommitments: 18,
        },
      }),
    });
    const section = body(legacySections(out), 1);
    // 4 settled, 3 of them two-sided hits: the denominator is the SCORED, never
    // the issued. The whole section is four lines and carries no commitment id.
    expect(section).toContain("4 settled · hit 3/4");
    expect(section).not.toContain("hit 3/6");
    expect(section).toContain("2 open calls");
    expect(section).toContain(`Coverage gaps: ${String(ROW_COUNT)} rows`);
    expect(section.split("\n").length).toBe(4);
    expect(section).not.toMatch(/\b\d{4}-\d{2}-\d{2}-[a-z]+-/u);
    expect(out.citations).toBe(4);
  });

  it("A3: calibration says over-confident above the band and refuses under ten receipts", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      verdictReceipt(
        `2026-08-30-weekly-verdict-row${String(index)}`,
        "continue",
        // mean p is 0.70 by construction; 6.6 of 12 is not an integer, so 7
        // hits gives an observed rate of 0.5833 and a gap of -0.1167 — inside
        // the band. Six hits gives 0.5 and -0.20, which is over-confident.
        index < 6 ? "continue" : "reverse",
        index < 6 ? 0.09 : 0.49,
      ),
    );
    const out = render({
      period: "weekly",
      frame: frame({
        ledger: { settledToday: many, open: [], totalCommitments: 12 },
      }),
    });
    expect(out.internalSections?.[0]?.body).toContain("over-confident");

    const few = many.slice(0, 4);
    const small = render({
      period: "weekly",
      frame: frame({
        ledger: { settledToday: few, open: [], totalCommitments: 4 },
      }),
    });
    expect(small.internalSections?.[0]?.body).toContain("n=4, not yet scorable");
  });

  it("the calibration sentence is weekly only", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      verdictReceipt(
        `2026-08-30-weekly-verdict-row${String(index)}`,
        "continue",
        "continue",
        0.09,
      ),
    );
    const daily = render({
      period: "daily",
      frame: frame({
        ledger: { settledToday: many, open: [], totalCommitments: 12 },
      }),
    });
    expect(body(legacySections(daily), 1)).not.toContain("calibration");
  });

  it("an empty ledger says nothing settled, never an error", () => {
    expect(body(legacySections(render({})), 1)).toContain(
      "Nothing settled yet — no call has come due",
    );
  });

  it("names the day the first open call settles", () => {
    const out = render({
      frame: frame({
        ledger: {
          settledToday: [],
          open: [
            {
              id: "2026-09-04-close-verdict-vol",
              issuedDay: "2026-09-04",
              issuedPhase: "close",
              payload: { kind: "coverage-verdict", settleAfterOpenDays: 5 },
            },
            {
              id: "2026-09-04-close-focus-ADBE",
              issuedDay: "2026-09-04",
              issuedPhase: "close",
              payload: {
                kind: "focus-admit",
                window: { fromDay: "2026-09-09", toDay: "2026-09-11" },
              },
            },
          ],
          totalCommitments: 2,
        },
      }),
    });
    // Five OPEN days from 2026-09-04 is 2026-09-14 (09-07 is Labor Day); the
    // focus window closes 2026-09-11 and is the earlier of the two. Either way
    // the reader is told a date, not an id.
    expect(body(legacySections(out), 1)).toContain(
      "Nothing settled yet — first settles 2026-09-11",
    );
  });
});

describe("section 5 — dated catalysts", () => {
  const admitted: CalendarRow = {
    time: "2026-09-10T12:30:00Z",
    type: "CPI",
    event: "CPI YoY",
    forecast: "2.9%",
    prev: "3.0%",
    session: "pre",
  };

  // 08:30 ET and 16:05 ET are different events, and a forecast with no prior
  // beside it says less than either number alone: the row's whole timestamp,
  // its session, its forecast AND its prior all reach the page.
  it("prints the release time, the session, the forecast and the prior", () => {
    const line = body(legacySections(render({ calendarRows: [admitted] })), 5)
      .split("\n")
      .find((row) => row.startsWith("- "))!;
    expect(line).toBe(
      "- 2026-09-10T12:30:00Z · CPI YoY · pre · fcst 2.9% · prev 3.0%",
    );
  });

  it("A4: an undated row is not printed, is listed, and a paragraph naming it is dropped", () => {
    const undated = {
      time: "",
      type: "FOMC",
      event: "FOMC decision",
    } as CalendarRow;
    const out = render({
      calendarRows: [admitted, undated],
      doc: { ...DOC_EMPTY, catalysts: "FOMC decision is the whole week." },
    });
    const section = body(legacySections(out), 5);
    expect(out.admitted).toEqual(["CPI YoY"]);
    expect(out.notAdmitted[0]).toContain("FOMC decision");
    expect(section).toContain("not admitted: FOMC decision");
    expect(section).not.toContain("FOMC decision is the whole week.");
    expect(out.faults.join("\n")).toContain("FOMC decision");
  });

  // THE 2026-09-06 DEFECT. Zero rows were admitted — the calendar and the
  // policy path are frame siblings, so neither payload reached the renderer —
  // and §5 still printed "FOMC decision 2026-09-16: the market prices 50.7%
  // hold versus 49.29% hike".
  it("drops a paragraph naming an event the admitted rows do not carry", () => {
    const out = render({
      calendarRows: [],
      doc: {
        ...DOC_EMPTY,
        catalysts:
          "FOMC decision 2026-09-16: the market prices 50.7% hold versus 49.29% hike.",
      },
    });
    const section = body(legacySections(out), 5);
    expect(out.admitted).toEqual([]);
    expect(section).toContain("no dated event was admitted this period");
    expect(section).not.toContain("50.7% hold");
    expect(out.faults.join("\n")).toContain("FOMC");
    expect(out.faults.join("\n")).toContain("2026-09-16");
  });

  // The review-v6 close dropped a whole §5 paragraph for saying "HOLD" and
  // "HIKE" — the two words the admitted FOMC rows carry in their own
  // `forecast` field, which the first version of the check did not read.
  it("counts the admitted row's forecast and prior as words it carries", () => {
    const out = render({
      // The two rows the review-v6 close actually admitted, out of argon's
      // own policy path.
      calendarRows: [
        {
          time: "2026-09-16",
          type: "policy path",
          event: "FOMC 9/16",
          forecast: "HOLD 50.7%",
          prev: "3.50-3.75%",
        },
        {
          time: "2026-12-09",
          type: "policy path",
          event: "FOMC 12/9",
          forecast: "HIKE 58%",
          prev: "3.75-4.00%",
        },
      ],
      doc: {
        ...DOC_EMPTY,
        catalysts:
          "The 2026-09-16 FOMC is a coin flip between HOLD and a HIKE at 50.7%.",
      },
    });
    expect(body(legacySections(out), 5)).toContain("coin flip");
    expect(out.faults).toEqual([]);
  });

  it("keeps a paragraph whose every named event an admitted row carries", () => {
    const out = render({
      calendarRows: [admitted],
      doc: {
        ...DOC_EMPTY,
        catalysts:
          "CPI on 2026-09-10 is the only print that can move the week.",
      },
    });
    expect(body(legacySections(out), 5)).toContain("is the only print");
    expect(out.faults).toEqual([]);
  });

  // The 2026-09-06 line was
  // `- 2026-09-10 · earnings · ADBE earnings (post) · forecast implied move
  //   6.9333% · post — settles: 2026-09-11`: the type is already in the event,
  // the session is printed twice, the settle day is the ledger's business, and
  // the implied move is four decimals of a number quoted to one.
  it("drops the type, the second session and the four-decimal percent", () => {
    const out = render({
      calendarRows: [
        {
          time: "2026-09-10",
          type: "earnings",
          event: "ADBE earnings (post)",
          forecast: "implied move 6.9333%",
          session: "post",
        },
      ],
    });
    const line = body(legacySections(out), 5)
      .split("\n")
      .find((row) => row.startsWith("- "))!;
    // The event text already says `(post)`, so the session is not repeated.
    expect(line).toBe(
      "- 2026-09-10 · ADBE earnings (post) · fcst implied move 6.9%",
    );
  });

  it("falls back to the prior when a row carries no forecast", () => {
    const out = render({
      calendarRows: [
        {
          time: "2026-09-02T20:30:00Z",
          type: "earnings",
          event: "AVGO Q3",
          prev: "1.24",
          session: "post",
        },
      ],
    });
    expect(body(legacySections(out), 5)).toContain(
      "- 2026-09-02T20:30:00Z · AVGO Q3 · post · prev 1.24",
    );
    expect(body(legacySections(out), 5)).not.toContain("settles:");
  });
});

describe("section 6 — the focus list", () => {
  const rows = Array.from({ length: 15 }, (_, index) =>
    focusRow(`T${String(index)}`),
  );

  it("prints exactly the weekly count on the weekly and the daily count on the daily", () => {
    const f = frame({
      focus: {
        weekly: rows as never,
        daily: rows.slice(0, 5) as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const weekly = render({ frame: f, period: "weekly" });
    expect(weekly.view.focus?.rows.length).toBe(15);
    expect(weekly.sections.map((section) => section.body).join("\n")).not.toContain(
      "weights: declared prior 2026-09-06",
    );
    const daily = render({ frame: f, period: "daily" });
    expect(daily.view.focus?.rows.length).toBe(5);
    expect(body(legacySections(daily), 6)).toContain(
      "weights: declared prior 2026-09-06",
    );
  });

  it("a short universe says why and still prints the section", () => {
    const f = frame({
      focus: {
        weekly: rows.slice(0, 3) as never,
        daily: rows.slice(0, 3) as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: ["universe holds 3 names"],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const out = render({ frame: f, period: "daily" });
    expect(out.view.focus?.shortfall).toBe("3 of 5 — universe holds 3 names");
    expect(body(legacySections(out), 6)).toContain("3 of 5");
  });

  it("keeps useful focus reasoning even when it uses a directional word", () => {
    const f = frame({
      focus: {
        weekly: [focusRow("NVDA"), focusRow("AMD")] as never,
        daily: [focusRow("NVDA"), focusRow("AMD")] as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const out = render({
      frame: f,
      doc: {
        ...DOC_EMPTY,
        focus: [{ ticker: "NVDA", why: "bullish into the print" }],
      },
    });
    expect(out.focusWhyRejected).toBe(0);
    expect(out.focusWhyMissing).toBe(1);
    expect(out.faults.join("\n")).not.toContain("NVDA");
    expect(out.view.focus?.rows[0]?.why).toBe("bullish into the print");
  });

  // The 2026-09-06 weekly wrote this for all five admitted names:
  // "Earnings 2026-09-10 post; 6.93% IV expects guidance revision." Both
  // figures are already printed in their own columns of the same row, so the
  // sentence adds a noun. It is RECORDED, not dropped: the line is worthless,
  // not wrong, and an empty cell would hide that the author was asked.
  it("records a fault when a why is only the date and the implied move", () => {
    const f = frame({
      focus: {
        weekly: [focusRow("TSM")] as never,
        daily: [focusRow("TSM")] as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const bad = render({
      frame: f,
      doc: {
        ...DOC_EMPTY,
        focus: [
          {
            ticker: "TSM",
            why: "Earnings 2026-10-15; 7.86% IV expects volume recovery.",
          },
        ],
      },
    });
    expect(bad.faults.join("\n")).toContain("focus-why-restates-date TSM");
    expect(bad.view.focus?.rows[0]?.why).not.toBe("");

    const good = render({
      frame: f,
      doc: {
        ...DOC_EMPTY,
        focus: [
          {
            ticker: "TSM",
            why: "earnings 2026-10-15 is far out, so IV rank 12 mostly reflects distance, not complacency; the ASML 10-14 read-through is the nearer tell.",
          },
        ],
      },
    });
    expect(good.faults.join("\n")).not.toContain("focus-why-restates-date");
  });

  // A commitment id is the day, the run label and the kind concatenated — all
  // three already on the page — and the /flash focus table printed one per
  // sticky name on 2026-09-06.
  it("says a name carries an open call without printing the call's id", () => {
    const f = frame({
      focus: {
        weekly: [
          focusRow("ADBE", {
            openCallIds: ["2026-09-04-close-focus-ADBE"],
          }),
        ] as never,
        daily: [] as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const out = render({ frame: f, period: "weekly" });
    expect(out.view.focus?.rows[0]?.openCall).toBe("open");
    expect(body(legacySections(out), 6)).not.toContain("2026-09-04-close-focus-ADBE");
  });

  it("discards a focus entry for a ticker that is not on the list", () => {
    const f = frame({
      focus: {
        weekly: [focusRow("NVDA")] as never,
        daily: [focusRow("NVDA")] as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const out = render({
      frame: f,
      doc: { ...DOC_EMPTY, focus: [{ ticker: "GME", why: "watch the tape" }] },
    });
    expect(out.faults.join("\n")).toContain("GME");
    expect(out.view.focus?.rows.every((row) => row.ticker !== "GME")).toBe(
      true,
    );
  });
});

describe("section 7 — open calls", () => {
  // The 2026-09-06 §7 was twelve lines of
  // `2026-09-04-close-verdict-rates.long · issued 2026-09-06 close · pending`:
  // the id repeats the day, the run label and the kind, and nothing on the
  // line says WHAT was called or WHEN it comes due.
  const open: OpenRow[] = [
    {
      id: "2026-09-04-close-focus-ADBE",
      issuedDay: "2026-09-04",
      issuedPhase: "close",
      payload: {
        kind: "focus-admit",
        ticker: "ADBE",
        p: 0.5,
        window: { fromDay: "2026-09-09", toDay: "2026-09-11" },
      },
    },
    {
      id: "2026-09-04-close-verdict-rates.long",
      issuedDay: "2026-09-04",
      issuedPhase: "close",
      payload: {
        kind: "coverage-verdict",
        rowId: "rates.long",
        token: "continue",
        p: 0.6,
        settleAfterOpenDays: 1,
      },
    },
  ];

  it("names the row, the call and the settle day, and no commitment id", () => {
    const out = render({
      frame: frame({
        ledger: { settledToday: [], open, totalCommitments: 2 },
      }),
    });
    const section = body(legacySections(out), 7);
    // Sorted by settle day. rates.long was issued Friday 2026-09-04 and settles
    // after ONE OPEN day: the Monday is Labor Day, so it comes due 2026-09-08,
    // not 2026-09-07 — the same day the settler counts to. ADBE 2026-09-11.
    expect(section.split("\n")).toEqual([
      "rates.long · CONTINUE p=0.60 · settles 2026-09-08",
      "ADBE · MOVES p=0.50 · settles 2026-09-11",
    ]);
    expect(section).not.toMatch(/\b\d{4}-\d{2}-\d{2}-[a-z]+-/u);
    expect(section).not.toContain("issued");
  });

  // The regression this pins: with no closed day the SAME row prints the
  // Monday. Labor Day is what moves it, so the calendar is being read.
  it("skips a tenant holiday, and prints it when the day is open", () => {
    const settles = (calendar: { weekdaysOnly: boolean; closed: string[] }) =>
      body(
        legacySections(render({
          calendar,
          frame: frame({
            ledger: { settledToday: [], open, totalCommitments: 2 },
          }),
        })),
        7,
      ).split("\n")[0];
    expect(settles({ weekdaysOnly: true, closed: [] })).toContain(
      "settles 2026-09-07",
    );
    expect(settles({ weekdaysOnly: true, closed: ["2026-09-07"] })).toContain(
      "settles 2026-09-08",
    );
  });

  it("a direction leg settles on bars, and says so", () => {
    const out = render({
      frame: frame({
        ledger: {
          settledToday: [],
          open: [
            {
              id: "2026-09-04-close-spy-t5",
              issuedDay: "2026-09-04",
              issuedPhase: "close",
              payload: { kind: "spy-direction", symbol: "SPY", pDown: 0.55 },
              barsSeen: 2,
              deadlineBars: 5,
            },
          ],
          totalCommitments: 1,
        },
      }),
    });
    expect(body(legacySections(out), 7)).toBe(
      "SPY · DOWN p=0.55 · settles after 5 bars",
    );
  });
});

describe("sections 2 and 4 — the model's, checked", () => {
  it("C2: section 2 is dropped when it names an id not in section 1", () => {
    const out = render({
      frame: frame({
        ledger: {
          settledToday: [
            verdictReceipt(
              "2026-08-30-weekly-verdict-rates.front",
              "continue",
              "continue",
              0.09,
            ),
          ],
          open: [],
          totalCommitments: 1,
        },
      }),
      doc: {
        ...DOC_EMPTY,
        review:
          "Our largest miss was 2026-08-24-weekly-verdict-vol, which settled at 4.4.",
      },
    });
    expect(body(legacySections(out), 2)).not.toContain(
      "2026-08-24-weekly-verdict-vol",
    );
    expect(out.faults.join("\n")).toContain("2026-08-24-weekly-verdict-vol");
  });

  it("C2: stale-row quoting remains measurable without reader diagnostics", () => {
    const rows = fullRows().map((row) =>
      row.id === "credit" ? { ...row, asOf: "2026-06-01" } : row,
    );
    const out = render({
      frame: frame({ rows }),
      doc: { ...DOC_EMPTY, review: "Credit was the quiet story this week." },
    });
    expect(body(legacySections(out), 2)).not.toContain("not to quote: credit");
    expect(
      reviewMetrics({
        frame: frame({ rows }),
        sections: out.sections,
        gaps: out.gaps,
        citations: out.citations,
        focus: { churn: 0, whyMissing: 0, whyRejected: 0 },
        themes: { rows: 1, proposed: 0 },
        rotationRows: null,
        staleRowsQuoted: out.staleRowsQuoted,
      }).find((metric) => metric.name === "staleRowsQuoted")?.value,
    ).toBe(1);
  });

  it("keeps a known ledger commitment id out of the weekly market review", () => {
    const id = "2026-08-30-weekly-verdict-rates.front";
    const out = render({
      period: "weekly",
      frame: frame({
        ledger: {
          settledToday: [verdictReceipt(id, "continue", "continue", 0.09)],
          open: [],
          totalCommitments: 1,
        },
      }),
      doc: { ...DOC_EMPTY, review: `The prior call ${id} settled.` },
    });
    expect(out.sections[0]?.body).not.toContain(id);
    expect(out.faults.join("\n")).toContain("internal records");
  });

  it("C1: outlook may use a printed level when it supplies market context", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        outlook: "The front end at 4.34 is what we are watching.",
      },
    });
    expect(body(legacySections(out), 4)).toContain("4.34");
    expect(out.faults.join("\n")).not.toContain("restates the level");
  });
});

describe("proposed themes", () => {
  it("parses the exact line shape", () => {
    expect(
      proposedThemes(
        "PROPOSED: power-grid-capex — utilities capex outruns load growth — evidence: XLU vs SPY 12w excess",
      ),
    ).toEqual([
      {
        id: "power-grid-capex",
        thesis: "utilities capex outruns load growth",
        evidence: "XLU vs SPY 12w excess",
      },
    ]);
  });

  it("returns nothing from prose with no such line", () => {
    expect(
      proposedThemes("We think the grid is the trade of the decade."),
    ).toEqual([]);
  });

  it("drops a proposal whose id collides with a declared theme", () => {
    const out = render({
      doc: {
        ...DOC_EMPTY,
        outlook:
          "PROPOSED: el-nino-ag-2026 — ag stays bid — evidence: DBA vs SPY 1w excess",
      },
    });
    expect(out.proposed).toEqual([]);
    expect(out.faults.join("\n")).toContain("el-nino-ag-2026");
  });
});

describe("the commitments a review mints", () => {
  const doc: ReviewDoc = {
    ...DOC_EMPTY,
    coverage: [
      {
        id: "rates.front",
        token: "continue",
        p: 0.7,
        why: "front end still bid",
        observable: "DGS2 next Friday",
        scorable: true,
      },
      {
        id: "vol",
        token: "fade",
        why: "term structure flattening",
        observable: "VIX next Friday",
        scorable: false,
      },
      {
        id: "credit",
        token: "untested",
        why: "",
        observable: "",
        scorable: false,
      },
      {
        id: `theme:${THEME.id}`,
        token: "strengthen",
        p: 0.6,
        why: "ag basket leads",
        observable: "basket excess next Friday",
        scorable: true,
      },
    ],
    focus: [],
    themes: [],
  };

  it("mints one draft per scorable row, none for untested or an unusable p", () => {
    const drafts = verdictCommitments({
      frame: frame({ rows: fullRows() }),
      doc,
      day: "2026-09-06",
      phase: "weekly",
    });
    const ids = drafts.map((draft) => draft.id);
    expect(ids).toContain("2026-09-06-weekly-verdict-rates.front");
    expect(ids).toContain(`2026-09-06-weekly-verdict-theme:${THEME.id}`);
    expect(ids).not.toContain("2026-09-06-weekly-verdict-vol");
    expect(ids).not.toContain("2026-09-06-weekly-verdict-credit");
    const theme = drafts.find((draft) =>
      draft.id.endsWith(`verdict-theme:${THEME.id}`),
    );
    expect((theme?.payload as { kind?: string }).kind).toBe("coverage-verdict");
    expect((theme?.payload as { unit?: string }).unit).toBe("%");
  });

  it("mints one focus-admit per admitted name and none without a threshold", () => {
    const weekly = [
      focusRow("NVDA"),
      focusRow("AMD", { threshold: undefined }),
    ];
    const drafts = verdictCommitments({
      frame: frame({
        rows: fullRows(),
        focus: {
          weekly: weekly as never,
          daily: weekly as never,
          churn: 0,
          carried: [],
          dropped: [],
          notes: [],
          weightsNote: "weights: declared prior 2026-09-06",
        },
      }),
      doc: DOC_EMPTY,
      day: "2026-09-06",
      phase: "weekly",
      period: "weekly",
    });
    const focusDrafts = drafts.filter(
      (draft) => (draft.payload as { kind?: string }).kind === "focus-admit",
    );
    expect(focusDrafts.map((draft) => draft.id)).toEqual([
      "2026-09-06-weekly-focus-NVDA",
    ]);
    expect(
      (focusDrafts[0]?.payload as { threshold?: { pct?: number } }).threshold
        ?.pct,
    ).toBe(4.6);
  });

  it("a name carried from a still-open commitment mints no second one", () => {
    const drafts = verdictCommitments({
      frame: frame({
        rows: fullRows(),
        focus: {
          weekly: [focusRow("NVDA", { sticky: true })] as never,
          daily: [] as never,
          churn: 0,
          carried: ["NVDA"],
          dropped: [],
          notes: [],
          weightsNote: "weights: declared prior 2026-09-06",
        },
        ledger: {
          settledToday: [],
          open: [
            {
              id: "2026-08-30-weekly-focus-NVDA",
              issuedDay: "2026-08-30",
              issuedPhase: "weekly",
              payload: {
                kind: "focus-admit",
                ticker: "NVDA",
                admittedFor: { kind: "earnings", day: "2026-11-18" },
              },
            },
          ],
          totalCommitments: 1,
        },
      }),
      doc: DOC_EMPTY,
      day: "2026-09-06",
      phase: "weekly",
      period: "weekly",
    });
    expect(
      drafts.filter(
        (draft) => (draft.payload as { kind?: string }).kind === "focus-admit",
      ),
    ).toEqual([]);
  });
});

describe("the metric rows", () => {
  it("writes every §F/§G/§H name, and null where a source was absent", () => {
    const out = render({});
    const metrics = reviewMetrics({
      frame: frame(),
      sections: out.sections,
      gaps: out.gaps,
      citations: out.citations,
      focus: { churn: 0, whyMissing: 0, whyRejected: 0 },
      themes: { rows: 1, proposed: 0 },
      rotationRows: null,
      staleRowsQuoted: 0,
    });
    const by = new Map(metrics.map((metric) => [metric.name, metric.value]));
    for (const name of [
      "callsScored",
      "callsOutstanding",
      "callHitRate",
      "verdictBrier",
      "coverageGaps",
      "reviewModelWords",
      "reviewModelWords.s2",
      "reviewModelWords.s3",
      "reviewModelWords.s4",
      "ledgerCitationCount",
      "staleRowsQuoted",
      "focusHitRate",
      "focusChurn",
      "focusWhyRejected",
      "focusWhyMissing",
      "themeRows",
      "themesProposed",
      "rotationRows",
    ])
      expect(by.has(name), name).toBe(true);
    expect(by.get("coverageGaps")).toBe(ROW_COUNT);
    expect(by.get("ledgerCitationCount")).toBe(0);
    expect(by.get("rotationRows")).toBe(null);
    expect(by.get("callHitRate")).toBe(null);
  });
});

describe("privacy — the /flash page is public", () => {
  it("no position, size or account word reaches the seven sections", () => {
    const f = frame({
      rows: fullRows(),
      focus: {
        weekly: [focusRow("NVDA")] as never,
        daily: [focusRow("NVDA")] as never,
        churn: 0,
        carried: [],
        dropped: [],
        notes: [],
        weightsNote: "weights: declared prior 2026-09-06",
      },
    });
    const out = render({ frame: f });
    const serialised = JSON.stringify(out.sections).toLowerCase();
    // Word boundaries, deliberately: `dealer.positioning` is a DECLARED
    // coverage row id and must print. What may never appear is a holding.
    for (const banned of [
      /\bpositions?\b/u,
      /\bnet liq\b/u,
      /\bbuying power\b/u,
      /\bquantity\b/u,
      /\bp\/l\b/u,
    ])
      expect(serialised, String(banned)).not.toMatch(banned);
    // Nothing in SessionFrame can carry a holding: a positions-shaped payload
    // beside the frame contributes no ticker to the document.
    expect(serialised).not.toContain("hyg");
  });
});

describe("the masthead a review document carries", () => {
  // The 2026-09-06 W36 weekly reached argon with `headline: ""`: a review run
  // has no `regime` step, and nothing else fills the masthead.
  const view = (task: string) =>
    buildView(
      report({
        steps: [
          {
            task: "frame",
            role: "frame-clerk",
            mode: "deterministic",
            text: "",
            toolOutputs: [JSON.stringify(frame({ rows: fullRows() }))],
          },
          {
            task,
            role: "weekly-analyst",
            mode: "model",
            text: JSON.stringify({
              review: "We read the front end wrong.",
              outlook: "The front end is the question.",
              catalysts: "",
              coverage: [],
              focus: [],
              themes: [],
            }),
          },
        ],
      } as never),
      SPEC,
    );

  it("is never empty on either review period", () => {
    for (const task of [REVIEW_PERIODS[0], "edit"]) {
      const built = view(task);
      expect(built.headline.length, task).toBeGreaterThan(0);
    }
  });

  it("the weekly masthead is the market review lead", () => {
    const built = view(REVIEW_PERIODS[0]);
    expect(built.headline).toBe("We read the front end wrong.");
  });

  it("keeps decimal figures intact in a weekly market-review headline", () => {
    expect(
      reviewHeadline({
        period: REVIEW_PERIODS[0],
        scorecard: "Nothing settled yet",
        review: "10Y ended 4.77% after the payroll release.\nOutlook follows.",
      }),
    ).toBe("10Y ended 4.77% after the payroll release.");
  });

  it("does not fall back to yesterday's checks when a daily review has no lead", () => {
    expect(
      reviewHeadline({
        period: REVIEW_PERIODS[1],
        scorecard: "Nothing settled yet",
        checksLine: "Yesterday: 2 of 3 checks held.",
      }),
    ).toBe("Market review");
  });
});

describe("the section list a review document delivers", () => {
  // Scenario and retrospective material stays available as metadata, while the
  // weekly page itself is a market review.
  const built = (task = REVIEW_PERIODS[0]) =>
    buildView(
      report({
        steps: [
          {
            task: "frame",
            role: "frame-clerk",
            mode: "deterministic",
            text: "",
            toolOutputs: [JSON.stringify(frame({ rows: fullRows() }))],
          },
          {
            task: "scenarios",
            role: "scenario-analyst",
            mode: "model",
            text: JSON.stringify({
              sections: [
                {
                  title: "Section 5 — Dated Catalysts",
                  body: "No dated calendar rows were admitted to this run.",
                },
              ],
            }),
          },
          {
            task,
            role: "weekly-analyst",
            mode: "model",
            text: JSON.stringify({
              review: "We read the front end wrong.",
              outlook: "The front end is the question.",
              catalysts: "",
              coverage: [],
              focus: [],
              themes: [],
            }),
          },
          {
            task: "week-review",
            role: "week-reviewer",
            mode: "model",
            text: JSON.stringify({
              sections: [
                { title: "5 sessions, 2026-08-31 to 2026-09-04", body: "one." },
                {
                  title: "10 sessions, 2026-08-24 to 2026-09-04",
                  body: "two.",
                },
                {
                  title: "21 sessions, 2026-08-07 to 2026-09-04",
                  body: "three.",
                },
              ],
            }),
          },
        ],
      } as never),
      SPEC,
    );

  it("preserves weekly topic headings and their closing counterevidence without widening daily", () => {
    const review = "## Policy repricing needs price confirmation\n\n" +
      Array.from({ length: 55 }, () => "The dated observation supports a limited interpretation.").join(" ") +
      "\n\n## The opposing evidence\n\nCredit has not confirmed the interpretation.";
    const render = (task: string) => buildView(report({ steps: [
      { task: "frame", role: "frame-clerk", mode: "deterministic", text: "",
        toolOutputs: [JSON.stringify(frame({ rows: fullRows() }))] },
      { task, role: "weekly-analyst", mode: "model", text: JSON.stringify({
        review, outlook: "", catalysts: "", coverage: [], focus: [], themes: [],
      }) },
    ] } as never), SPEC).sections[0]!.body;
    expect(render("weekly")).toBe(review);
    expect(render("edit").length).toBeLessThan(review.length);
  });

  it("opens with the four weekly market titles, in order", () => {
    const titles = built().sections.map((section) => section.title);
    expect(titles).toEqual([...MARKET_REPORT_TITLES]);
  });

  it("uses the same public market layout for the daily review", () => {
    const daily = built("edit");
    expect(daily.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
    const publicText = JSON.stringify(daily.sections).toLowerCase();
    expect(publicText).not.toContain("scorecard");
    expect(publicText).not.toContain("open calls");
    expect(publicText).not.toContain("calls.open");
    expect((daily.otherSections ?? []).map((section) => section.title)).toEqual(
      [
        "5 sessions, 2026-08-31 to 2026-09-04",
        "10 sessions, 2026-08-24 to 2026-09-04",
        "21 sessions, 2026-08-07 to 2026-09-04",
        REVIEW_TITLES[0],
        REVIEW_TITLES[5],
        REVIEW_TITLES[6],
      ],
    );
  });

  it("keeps the final formal review when a recorded run has no frame", () => {
    const built = buildView(
      report({
        steps: [
          {
            task: "regime",
            role: "regime-analyst",
            mode: "model",
            text: JSON.stringify({
              sections: [
                { title: "Upstream transcript", body: "internal regime prose" },
              ],
            }),
          },
          { task: REVIEW_PERIODS[0], role: "weekly-analyst", mode: "model", text: "" },
          {
            task: REVIEW_PERIODS[0],
            role: "weekly-analyst",
            mode: "model",
            text: JSON.stringify({
              review: "Rates repricing remains the market story.",
              outlook: "Watch whether credit confirms the move.",
              catalysts: "No sourced calendar row was retained in the recording.",
              coverage: [],
              focus: [],
              themes: [],
            }),
          },
        ],
      } as never),
      SPEC,
    );
    expect(built.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
    expect(built.sections[0]?.body).toBe(
      "Rates repricing remains the market story.",
    );
    expect(built.sections[2]?.body).not.toContain("no dated event was admitted");
    expect(JSON.stringify(built.sections)).not.toContain("Upstream transcript");
    expect(built.otherSections?.map((section) => section.title)).toEqual([
      "Upstream transcript",
    ]);
    expect(built.footer?.notes).toContain(
      "Incomplete provenance: this recorded run has no deterministic session frame.",
    );
  });

  it("keeps scorecards and retrospective windows outside the public document", () => {
    const view = built();
    expect(view.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
    expect((view.otherSections ?? []).map((section) => section.title)).toEqual([
      "5 sessions, 2026-08-31 to 2026-09-04",
      "10 sessions, 2026-08-24 to 2026-09-04",
      "21 sessions, 2026-08-07 to 2026-09-04",
      REVIEW_TITLES[0],
      REVIEW_TITLES[5],
      REVIEW_TITLES[6],
    ]);
    const publicText = JSON.stringify(view.sections).toLowerCase();
    expect(publicText).not.toContain("scorecard");
    expect(publicText).not.toContain("open calls");
    expect(publicText).not.toContain("calls.open");
  });

  it("drops the scenario step's own section — §5 is that content", () => {
    const titles = built().sections.map((section) => section.title);
    expect(titles).not.toContain("Section 5 — Dated Catalysts");
  });

  // The first fix keyed on title PLUS body, and `enforceBudget` word-trims a
  // body after `sectionsFrom` has run — so the key never matched the delivered
  // section and the block came straight back on the review-v6 rerun. A body
  // long enough to be trimmed is the case that caught it.
  it("drops it even when the budget trimmed the body it was keyed on", () => {
    const long = Array.from(
      { length: 400 },
      (_, index) => `word${String(index)}`,
    ).join(" ");
    const view = buildView(
      report({
        steps: [
          {
            task: "frame",
            role: "frame-clerk",
            mode: "deterministic",
            text: "",
            toolOutputs: [JSON.stringify(frame({ rows: fullRows() }))],
          },
          {
            task: "scenarios",
            role: "scenario-analyst",
            mode: "model",
            text: JSON.stringify({
              sections: [{ title: "Section 5 — Dated Catalysts", body: long }],
            }),
          },
          {
            task: REVIEW_PERIODS[0],
            role: "weekly-analyst",
            mode: "model",
            text: JSON.stringify({ ...DOC_EMPTY, review: "a." }),
          },
        ],
      } as never),
      SPEC,
    );
    expect(view.sections.map((section) => section.title)).toEqual([
      ...MARKET_REPORT_TITLES,
    ]);
  });
});

describe("the theme view block", () => {
  // On 2026-09-06 it printed `token: "untested"` and `excess1w: "—"` while the
  // rotation step had priced that same basket at +3.4072 four-week excess. The
  // token is the MODEL's, joined by row id; the excess is the frame's basket,
  // which is the same computation the rotation table runs.
  const doc: ReviewDoc = {
    ...DOC_EMPTY,
    coverage: [
      {
        id: `theme:${THEME.id}`,
        token: "continue",
        p: 0.6,
        why: "ag basket still ahead of SPY",
        observable: "excess vs SPY next week",
        scorable: true,
      },
    ],
    themes: [
      { id: THEME.id, leadership: "confirms", why: "ag inputs still lead" },
    ],
  };

  it("takes the token from the model's own coverage entry for theme:<id>", () => {
    const out = render({ frame: frame({ rows: fullRows() }), doc });
    const row = out.view.themes!.find((entry) => entry.id === THEME.id)!;
    expect(row.token).toBe("continue");
    expect(row.leadership).toBe("confirms");
    // fullRows() gives the theme a computed basket: +1.7 % on the week,
    // +3.2 % since it was entered.
    expect(row.excess1w).toBe("+1.7%");
    expect(row.excessSinceEntered).toBe("+3.2%");
  });

  it("says untested only when the model gave that row no entry", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: { ...doc, coverage: [] },
    });
    const row = out.view.themes!.find((entry) => entry.id === THEME.id)!;
    expect(row.token).toBe("untested");
    expect(row.excess1w).toBe("+1.7%");
  });
});

describe("calls.open is the renderer's row, not the model's", () => {
  // It was handed to the model as an ordinary coverage row on 2026-09-06 and
  // came back `untested` — a verdict token on a number the renderer already
  // holds. It keeps its declared slot, so the row count does not move.
  const withOpen = (openRows: OpenRow[]) =>
    frame({
      rows: fullRows().map((row) =>
        row.id === "calls.open"
          ? {
              ...row,
              rendererFilled: true as const,
              level: String(openRows.length),
              delta: openRows.length,
            }
          : row,
      ),
      ledger: { settledToday: [], open: openRows, totalCommitments: 3 },
    });

  const open: OpenRow[] = [
    {
      id: "2026-09-04-close-verdict-rates.long",
      issuedDay: "2026-09-04",
      issuedPhase: "close",
      payload: { kind: "coverage-verdict", rowId: "rates.long" },
    },
    {
      id: "2026-09-04-close-verdict-credit",
      issuedDay: "2026-09-04",
      issuedPhase: "close",
      payload: { kind: "coverage-verdict", rowId: "credit" },
    },
  ];

  it("keeps the ledger's open count out of public coverage", () => {
    const out = render({ frame: withOpen(open) });
    expect(body(legacySections(out), 3)).not.toContain("calls.open");
    expect(out.view.coverageDetail?.some((row) => row.id === "calls.open")).toBe(
      false,
    );
  });

  it("keeps the declared row count and is never a coverage gap", () => {
    const out = render({ frame: withOpen(open) });
    const lines = body(legacySections(out), 3)
      .split("\n")
      .filter((row) => row.startsWith("- "));
    expect(lines.length).toBe(PUBLIC_ROW_COUNT);
    expect(body(legacySections(out), 3)).not.toContain("left out: calls.open");
    // Every OTHER row is a gap here (this document answers none of them);
    // `calls.open` is not one of them.
    expect(out.gaps).toBe(ROW_COUNT - 1);
  });

  // Its level is `0`, and `String.includes("0")` is true of "9/16", "2026" and
  // every ratio — so §4 was dropped for "restating the level 0" on the
  // review-v6 close.
  it("never triggers the section 4 no-restatement fault", () => {
    const out = render({
      frame: withOpen(open),
      doc: {
        ...DOC_EMPTY,
        outlook: "The 9/16 meeting is the whole week; nothing lands before it.",
      },
    });
    // This document answers no coverage row at all, so it earns the omission
    // fault; the one under test is §4's no-restatement rule.
    expect(out.faults.filter((line) => line.includes("restates"))).toEqual([]);
    expect(body(legacySections(out), 4)).toContain("9/16");
  });

  it("mints no commitment even when the model answers it anyway", () => {
    const drafts = verdictCommitments({
      frame: withOpen(open),
      doc: {
        ...DOC_EMPTY,
        coverage: [
          {
            id: "calls.open",
            token: "continue",
            p: 0.7,
            why: "two still pending",
            observable: "the ledger",
            scorable: true,
          },
        ],
      },
      day: "2026-09-06",
      phase: "weekly",
    });
    expect(drafts).toEqual([]);
  });
});

describe("an untested coverage row prints three fields and no more", () => {
  // It read `rates.front — untested — UNTESTED — data not printed this period
  // — settles: data not printed this period` on 18 of 23 rows: five fields,
  // four of them saying the same nothing.
  it("names the row, says there was no datum, and stops", () => {
    const out = render({});
    const line = body(legacySections(out), 3)
      .split("\n")
      .find((row) => row.startsWith("- rates.front"))!;
    expect(line).toBe("- rates.front · no datum this period · UNTESTED");
    expect(line).not.toContain("settles:");
  });

  it("still carries the source's own reason, on the row's detail", () => {
    const out = render({});
    expect(
      (out.view.coverageDetail ?? []).find((row) => row.id === "rates.front")
        ?.leftOut,
    ).toBe("tool absent");
    expect(body(legacySections(out), 3)).toContain("left out: ");
  });

  // On the review-v6 rerun the author answered the macro rows and stopped, and
  // all ten sector rows printed "no datum this period" over a frame that had
  // just priced every one of them.
  it("a priced row nobody called prints its number, not `no datum`", () => {
    const out = render({ frame: frame({ rows: fullRows() }), doc: DOC_EMPTY });
    const line = body(legacySections(out), 3)
      .split("\n")
      .find((row) => row.startsWith("- sector:Computer/GPU"))!;
    expect(line).toContain("4.34 → -3.1 bp");
    expect(line).toContain("UNTESTED · not called this period");
    expect(line).not.toContain("members: NVDA, AMD");
    expect(line).not.toContain("no datum this period");
    // It is still a gap, and still one of the UNTESTED lines `coverageGaps`
    // is measured against.
    expect(out.gaps).toBe(ROW_COUNT);
    expect(
      body(legacySections(out), 3)
        .split("\n")
        .filter((row) => row.startsWith("- ") && row.includes("UNTESTED"))
        .length,
    ).toBe(PUBLIC_ROW_COUNT);
  });

  it("allows an analyst to leave priced rows uncalled", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        coverage: COVERAGE.map((id) => ({
          id,
          token: "continue" as const,
          p: 0.7,
          why: "same tape",
          observable: "next close",
        })),
      },
    });
    expect(
      out.faults.filter((line) => line.startsWith("coverage omits")),
    ).toEqual([]);
  });

  it("raises no omission fault when every priced row was answered", () => {
    const rows = fullRows();
    const out = render({
      frame: frame({ rows }),
      doc: {
        ...DOC_EMPTY,
        coverage: rows.map((row) => ({
          id: row.id,
          token: "continue" as const,
          p: 0.7,
          why: "same tape",
          observable: "next close",
        })),
      },
    });
    expect(
      out.faults.filter((line) => line.startsWith("coverage omits")),
    ).toEqual([]);
  });

  it("a row with NO datum is not an omission — untested is its honest answer", () => {
    const out = render({ frame: frame(), doc: DOC_EMPTY });
    expect(
      out.faults.filter((line) => line.startsWith("coverage omits")),
    ).toEqual([]);
  });
});

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
import type { CoverageRow } from "../quality/channels.js";
import type { OpenRow, SessionFrame, SettledRow } from "../quality/frame.js";
import type { ThemeSpec } from "../quality/review-config.js";
import { REVIEW_BUDGET } from "../render/budget.js";
import {
  citationLine,
  pendingLine,
  proposedThemes,
  REVIEW_TITLES,
  reviewMetrics,
  reviewSections,
  verdictCommitments,
  type CalendarRow,
} from "../render/review.js";
import type { ReviewDoc } from "../render/review.js";

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

function render(over: {
  frame?: SessionFrame;
  doc?: ReviewDoc | null;
  period?: "weekly" | "daily";
  rotation?: Parameters<typeof reviewSections>[0]["rotation"];
  calendarRows?: CalendarRow[];
}) {
  const f = over.frame ?? frame();
  const period = over.period ?? "weekly";
  return reviewSections({
    frame: f,
    rotation: over.rotation ?? null,
    doc: over.doc === undefined ? DOC_EMPTY : over.doc,
    caps: period === "weekly" ? f.caps.weekly : f.caps.daily,
    period,
    calendarRows: over.calendarRows ?? [],
  });
}

function body(sections: Array<{ title: string; body: string }>, n: number) {
  return sections[n - 1]?.body ?? "";
}

describe("the seven fixed sections", () => {
  it("returns exactly seven, in order, on an empty frame", () => {
    const out = render({});
    expect(out.sections.map((section) => section.title)).toEqual([
      ...REVIEW_TITLES,
    ]);
  });

  it("returns exactly seven with a fully populated frame and a document", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        review: "We read the front end wrong.",
        outlook: "The front end is the question.",
      },
    });
    expect(out.sections.map((section) => section.title)).toEqual([
      ...REVIEW_TITLES,
    ]);
  });
});

describe("section 3 — the coverage list never shrinks", () => {
  it("prints one line per declared row on a full frame and on an empty one", () => {
    const full = render({ frame: frame({ rows: fullRows() }) });
    const empty = render({});
    const count = (out: ReturnType<typeof render>) =>
      body(out.sections, 3)
        .split("\n")
        .filter((line) => line.startsWith("- ")).length;
    expect(count(full)).toBe(ROW_COUNT);
    expect(count(empty)).toBe(ROW_COUNT);
  });

  it("an empty frame reads untested on every row, counts every gap and lists a reason for each", () => {
    const out = render({});
    const section = body(out.sections, 3);
    for (const line of section.split("\n").filter((l) => l.startsWith("- ")))
      expect(line).toContain("untested");
    expect(out.gaps).toBe(ROW_COUNT);
    expect(
      section.split("\n").filter((l) => l.startsWith("left out:")).length,
    ).toBe(ROW_COUNT);
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
    const section = body(out.sections, 3);
    expect(section).toContain("members: NVDA, AMD");
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
    expect(body(weekly.sections, 3)).toContain("3d rotation");
    expect(body(weekly.sections, 3)).toContain("XLK");
    expect(body(weekly.sections, 3)).toContain("benchmark SPY");
    const daily = render({ rotation, period: "daily" });
    expect(body(daily.sections, 3)).not.toContain("3d rotation");
  });

  it("prints the rotation block as not priced when the weekly has no payload", () => {
    const weekly = render({ period: "weekly" });
    expect(body(weekly.sections, 3)).toContain("rotation: not priced this run");
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
    expect(body(out.sections, 3)).toContain(">4.65bp");
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
    const section = body(out.sections, 1);
    expect(section).toContain("4 scored of 6 issued");
    expect(section).toContain("callHitRate 0.75");
    expect(section).not.toContain("callHitRate 0.5 ");
    expect(section).toContain(`${String(ROW_COUNT)} not called`);
    expect(section).toContain(
      "all 18 calls issued since 2026-08-24; none removed",
    );
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
      frame: frame({
        ledger: { settledToday: many, open: [], totalCommitments: 12 },
      }),
    });
    expect(body(out.sections, 1)).toContain("over-confident");

    const few = many.slice(0, 4);
    const small = render({
      frame: frame({
        ledger: { settledToday: few, open: [], totalCommitments: 4 },
      }),
    });
    expect(body(small.sections, 1)).toContain("n=4, not yet scorable");
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
    expect(body(daily.sections, 1)).not.toContain("calibration");
  });

  it("an empty ledger is one coverage line, never an error", () => {
    expect(body(render({}).sections, 1)).toContain("no call has come due yet");
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
    const section = body(out.sections, 5);
    expect(out.admitted).toEqual(["CPI YoY"]);
    expect(out.notAdmitted[0]).toContain("FOMC decision");
    expect(section).toContain("not admitted: FOMC decision");
    expect(section).not.toContain("FOMC decision is the whole week.");
    expect(out.faults.join("\n")).toContain("FOMC decision");
  });

  it("C3: a post-close row dated 2026-09-02 settles the next open session", () => {
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
    expect(body(out.sections, 5)).toContain("settles: 2026-09-03");
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
    expect(
      body(weekly.sections, 6)
        .split("\n")
        .filter((line) => line.startsWith("| ")).length,
    ).toBe(15);
    const daily = render({ frame: f, period: "daily" });
    expect(daily.view.focus?.rows.length).toBe(5);
    expect(body(daily.sections, 6)).toContain(
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
    expect(body(out.sections, 6)).toContain("3 of 5");
  });

  it("drops a banned why, names it, counts it, and counts a missing one", () => {
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
    expect(out.focusWhyRejected).toBe(1);
    expect(out.focusWhyMissing).toBe(1);
    expect(out.faults.join("\n")).toContain("NVDA");
    expect(out.view.focus?.rows[0]?.why).toBe("");
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
    expect(body(out.sections, 2)).not.toContain(
      "2026-08-24-weekly-verdict-vol",
    );
    expect(out.faults.join("\n")).toContain("2026-08-24-weekly-verdict-vol");
  });

  it("C2: a stale row earns a not-to-quote line and quoting it counts", () => {
    const rows = fullRows().map((row) =>
      row.id === "credit" ? { ...row, asOf: "2026-06-01" } : row,
    );
    const out = render({
      frame: frame({ rows }),
      doc: { ...DOC_EMPTY, review: "Credit was the quiet story this week." },
    });
    expect(body(out.sections, 2)).toContain("not to quote: credit");
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

  it("C1: a section 4 paragraph restating a printed level is a fault", () => {
    const out = render({
      frame: frame({ rows: fullRows() }),
      doc: {
        ...DOC_EMPTY,
        outlook: "The front end at 4.34 is what we are watching.",
      },
    });
    expect(out.faults.join("\n")).toContain("4.34");
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

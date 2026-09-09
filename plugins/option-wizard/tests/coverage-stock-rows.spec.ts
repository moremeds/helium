/**
 * #106 Loop 2 item 1 — a weekly call on a ranked single name mints a ledger
 * row, and a call that would mint nothing faults the page.
 *
 * Every number here is real and frozen. The week returns and excesses are the
 * `ow_stock_week` response recorded on 2026-09-08 for the 2026-08-31..09-04
 * week (`docs/evidence/flash-samples/2026-09-06-weekly-v2/tool-io/
 * 00012-ow_stock_week.json.gz`, `source: "apex-bars-fallback"`, SPY
 * +0.0010918307662313165); the DELL earnings row is the
 * `ow_uw_earnings_report` response recorded in the same sample
 * (`00011-…`, reportDate 2026-09-01, actualEps "6.76", streetMeanEst "4.95").
 */
import { describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTenantYaml } from "@helium/core";
import {
  COVERAGE_CANDIDATE_LIMIT,
  DAILY_COVERAGE_CANDIDATE_LIMIT,
  candidateLimit,
  inWindowEarnings,
  rankCoverageCandidates,
  stockRowId,
  type StockWeekPayload,
} from "../quality/coverage-candidates.js";
import { SESSION_FRAME_SIBLINGS, buildTools } from "../tools/index.js";
import type { SessionFrame } from "../quality/frame.js";
import { REVIEW_BUDGET } from "../render/budget.js";
import {
  reviewSections,
  verdictCommitments,
  type ReviewDoc,
} from "../render/review.js";

/** The recorded W37 payload, verbatim. */
const W37: StockWeekPayload = {
  start: "2026-08-31",
  end: "2026-09-04",
  source: "apex-bars-fallback",
  benchmarks: {
    SPY: { window_return: 0.0010918307662313165 },
    QQQ: { window_return: 0.003531398740979741 },
  },
  results: [
    {
      symbol: "AMD",
      window_return: 0.025752824434039256,
      excess_vs_spy: 0.02466099366780794,
      excess_vs_qqq: 0.022221425693059516,
    },
    {
      symbol: "DELL",
      window_return: 0.14882517972996667,
      excess_vs_spy: 0.14773334896373536,
      excess_vs_qqq: 0.14529378098898693,
    },
    {
      symbol: "NVDA",
      window_return: 0.05888301539875895,
      excess_vs_spy: 0.05779118463252764,
      excess_vs_qqq: 0.05535161665777921,
    },
    {
      symbol: "SNDK",
      window_return: 0.17173295263235877,
      excess_vs_spy: 0.17064112186612745,
      excess_vs_qqq: 0.16820155389137903,
    },
  ],
  missing: [],
};

function candidates() {
  return rankCoverageCandidates({ payload: W37, events: [] });
}

function frame(over: Partial<SessionFrame> = {}): SessionFrame {
  return {
    kind: "session-frame/1",
    day: "2026-09-06",
    mode: "ratio",
    why: "the biggest move against its own median",
    ranked: [],
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
    checks: { line: "Yesterday: no prior checks.", scored: [] },
    ledger: { settledToday: [], open: [], totalCommitments: 0 },
    caps: { weekly: REVIEW_BUDGET.weekly, daily: REVIEW_BUDGET.daily },
    declared: { coverage: [], sectors: [], themes: [] },
    coverage: [],
    calendar: [],
    noRestate: [],
    coverageCandidates: candidates(),
    ...over,
  } as SessionFrame;
}

function doc(over: Partial<ReviewDoc> = {}): ReviewDoc {
  return {
    review: "",
    outlook: "",
    catalysts: "",
    coverage: [],
    focus: [],
    themes: [],
    ...over,
  };
}

const CALL_SNDK = {
  id: "stock:SNDK",
  token: "strengthen" as const,
  p: 0.6,
  why: "flash pricing tightened through the week",
  observable: "next week's excess vs SPY",
  scorable: true,
};

function sections(document: ReviewDoc, over: Partial<SessionFrame> = {}) {
  const f = frame(over);
  return reviewSections({
    frame: f,
    rotation: null,
    doc: document,
    caps: f.caps.weekly,
    period: "weekly",
    calendarRows: [],
  });
}

describe("ranked single names carry a ledger row id", () => {
  it("gives every candidate a stock:<SYMBOL> id", () => {
    const ranked = candidates();
    expect(ranked.stocks.map((row) => row.id)).toEqual([
      "stock:SNDK",
      "stock:DELL",
      "stock:NVDA",
      "stock:AMD",
    ]);
    expect(stockRowId("SNDK")).toBe("stock:SNDK");
  });

  it("mints one commitment per called name, in the existing id scheme", () => {
    const drafts = verdictCommitments({
      frame: frame(),
      doc: doc({ coverage: [CALL_SNDK] }),
      day: "2026-09-06",
      phase: "weekly",
      period: "weekly",
    });
    expect(drafts.map((draft) => draft.id)).toEqual([
      "2026-09-06-weekly-verdict-stock:SNDK",
    ]);
    const payload = drafts[0]?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("coverage-verdict");
    expect(payload.rowId).toBe("stock:SNDK");
    expect(payload.token).toBe("strengthen");
    // The excess over SPY in percentage points — what the next week's
    // observation of the same row will carry, so `settleVerdict` can classify.
    expect((payload.observed as { delta?: number }).delta).toBeCloseTo(
      17.064112186612745,
      10,
    );
    expect((payload.observed as { asOf?: string }).asOf).toBe("2026-09-04");
  });

  it("mints nothing for a name the frame did not rank", () => {
    const drafts = verdictCommitments({
      frame: frame(),
      doc: doc({ coverage: [{ ...CALL_SNDK, id: "stock:FIG" }] }),
      day: "2026-09-06",
      phase: "weekly",
      period: "weekly",
    });
    expect(drafts).toEqual([]);
  });
});

describe("a printed call that mints nothing is a fault", () => {
  it("faults a scorable call on an id no row and no candidate carries", () => {
    const result = sections(doc({ coverage: [{ ...CALL_SNDK, id: "stock:FIG" }] }));
    expect(
      result.faults.some(
        (fault) =>
          fault.includes("stock:FIG") && fault.includes("no ledger commitment"),
      ),
    ).toBe(true);
  });

  it("does not fault a call on a ranked name", () => {
    const result = sections(doc({ coverage: [CALL_SNDK] }));
    expect(
      result.faults.some((fault) => fault.includes("no ledger commitment")),
    ).toBe(false);
  });

  it("does not fault an untested entry on an id nothing carries", () => {
    const result = sections(
      doc({
        coverage: [
          {
            id: "stock:FIG",
            token: "untested",
            why: "missing: not in the ranked table",
            observable: "",
            scorable: false,
          },
        ],
      }),
    );
    expect(
      result.faults.some((fault) => fault.includes("no ledger commitment")),
    ).toBe(false);
  });
});

describe("section 3e prints the ranked names with their ids", () => {
  it("prints one line per candidate, id first, returns as percentages", () => {
    const result = sections(doc({ coverage: [CALL_SNDK] }));
    const coverage = result.sections
      .map((section) => section.body)
      .find((text) => text.includes("3e stocks"));
    expect(coverage).toBeDefined();
    expect(coverage).toContain(
      "- stock:SNDK · +17.2% week · excess vs SPY +17.1% · STRENGTHEN",
    );
    expect(coverage).toContain(
      "- stock:DELL · +14.9% week · excess vs SPY +14.8% · UNTESTED",
    );
  });

  it("prints the in-window earnings figures the clerk attached", () => {
    const ranked = candidates();
    const dell = ranked.stocks.find((row) => row.symbol === "DELL");
    if (dell !== undefined)
      dell.earnings = {
        reportDate: "2026-09-01",
        endingFiscalQuarter: "2026-07-31",
        actualEps: "6.76",
        streetMeanEst: "4.95",
        reportTime: "postmarket",
        sourceUrl: "https://api.unusualwhales.com/api/earnings/DELL",
      };
    const result = sections(doc(), { coverageCandidates: ranked });
    const coverage = result.sections
      .map((section) => section.body)
      .find((text) => text.includes("3e stocks"));
    expect(coverage).toContain("reported 2026-09-01 EPS 6.76 vs est 4.95");
  });
});

/** The reported week the recording was taken for. */
const WEEK = { start: "2026-08-31", end: "2026-09-04" };

/** `ow_uw_earnings_report` for DELL, recorded 2026-09-08 (00011-…). */
const DELL_REPORT = {
  source: "unusual_whales",
  ticker: "DELL",
  cutoff: "2026-09-06T12:00:00.000Z",
  earnings: [
    {
      reportDate: "2026-09-01",
      endingFiscalQuarter: "2026-07-31",
      actualEps: "6.76",
      streetMeanEst: "4.95",
      source: "company",
      reportTime: "postmarket",
      sourceUrl: "https://api.unusualwhales.com/api/earnings/DELL",
    },
  ],
};

/** The same tool for SNDK (00007-…): its newest completed report is three
 *  weeks BEFORE the reported window. */
const SNDK_REPORT = {
  source: "unusual_whales",
  ticker: "SNDK",
  cutoff: "2026-09-06T12:00:00.000Z",
  earnings: [
    {
      reportDate: "2026-08-05",
      endingFiscalQuarter: "2026-06-30",
      actualEps: "38.82",
      streetMeanEst: "34.24",
      source: "company",
      reportTime: "postmarket",
      sourceUrl: "https://api.unusualwhales.com/api/earnings/SNDK",
    },
  ],
};

describe("in-window completed earnings", () => {
  it("keeps the report that landed inside the reported week, as strings", () => {
    expect(inWindowEarnings(DELL_REPORT, WEEK)).toEqual({
      reportDate: "2026-09-01",
      endingFiscalQuarter: "2026-07-31",
      actualEps: "6.76",
      streetMeanEst: "4.95",
      reportTime: "postmarket",
      sourceUrl: "https://api.unusualwhales.com/api/earnings/DELL",
    });
  });

  it("refuses a report from before the window rather than printing it", () => {
    expect(inWindowEarnings(SNDK_REPORT, WEEK)).toBeNull();
  });

  it("refuses a replay refusal and an empty payload alike", () => {
    expect(
      inWindowEarnings(
        { unavailable: "as-of", asOf: "2026-09-06T12:00:00.000Z" },
        WEEK,
      ),
    ).toBeNull();
    expect(inWindowEarnings(null, WEEK)).toBeNull();
    expect(inWindowEarnings({ earnings: [] }, WEEK)).toBeNull();
  });
});

describe("the weekly clerk records the reads it needs", () => {
  it("declares the two new siblings", () => {
    expect(SESSION_FRAME_SIBLINGS).toContain("ow_uw_earnings_report");
    expect(SESSION_FRAME_SIBLINGS).toContain("ow_uw_headlines");
  });

  it("records what ow_uw_headlines answered, with no key configured", async () => {
    const tenantPath = join(__dirname, "..", "tenant.yaml");
    const spec = parseTenantYaml(readFileSync(tenantPath, "utf8"), tenantPath);
    const tool = buildTools({
      stateRoot: mkdtempSync(join(tmpdir(), "ow-loop2-frame-")),
      env: {
        HELIUM_AUDIT_DB: join(
          mkdtempSync(join(tmpdir(), "ow-loop2-db-")),
          "audit.db",
        ),
      },
      extensions: spec.extensions,
    }).find((entry) => entry.name === "ow_session_frame");
    if (tool === undefined) throw new Error("no tool ow_session_frame");
    const built = JSON.parse(await tool.run({})) as {
      coverageCandidates?: { notes: string[] };
    };
    expect(
      built.coverageCandidates?.notes.some((note) =>
        note.startsWith("ow_uw_headlines: no rows"),
      ),
    ).toBe(true);
  });

  it("leaves headlines absent when #113's overview has no row for a name", async () => {
    const tenantPath = join(__dirname, "..", "tenant.yaml");
    const spec = parseTenantYaml(readFileSync(tenantPath, "utf8"), tenantPath);
    const tool = buildTools({
      stateRoot: mkdtempSync(join(tmpdir(), "ow-loop2-news-")),
      env: {
        HELIUM_AUDIT_DB: join(
          mkdtempSync(join(tmpdir(), "ow-loop2-newsdb-")),
          "audit.db",
        ),
      },
      extensions: spec.extensions,
    }).find((entry) => entry.name === "ow_session_frame");
    if (tool === undefined) throw new Error("no tool ow_session_frame");
    const built = JSON.parse(await tool.run({})) as {
      coverageCandidates?: { stocks: Array<{ headlines?: unknown }> };
      newsOverview?: { stocks?: unknown[] };
    };
    // The citation fill is a copy from `newsOverview.stocks[]`, never a second
    // route to the tape: with no overview there is no `headlines` key at all,
    // and the frame still builds.
    expect(built.newsOverview?.stocks ?? []).toEqual([]);
    for (const row of built.coverageCandidates?.stocks ?? [])
      expect(row.headlines).toBeUndefined();
  });
});

describe("the daily run gets the same block, smaller", () => {
  it("caps a daily phase at five names and the weekly at eight", () => {
    expect(candidateLimit("weekly")).toBe(COVERAGE_CANDIDATE_LIMIT);
    for (const phase of ["premarket", "intraday", "close"])
      expect(candidateLimit(phase)).toBe(DAILY_COVERAGE_CANDIDATE_LIMIT);
    // An unphased host keeps what it had: a silent cut is worse than a
    // cadence this code cannot see.
    expect(candidateLimit(undefined)).toBe(COVERAGE_CANDIDATE_LIMIT);
    expect(
      rankCoverageCandidates({
        payload: W37,
        events: [],
        limit: DAILY_COVERAGE_CANDIDATE_LIMIT,
      }).stocks,
    ).toHaveLength(4);
  });

  it("prints 3e and mints on a daily period, not only on the weekly", () => {
    const f = frame();
    const result = reviewSections({
      frame: f,
      rotation: null,
      doc: doc({ coverage: [CALL_SNDK] }),
      caps: f.caps.daily,
      period: "daily",
      calendarRows: [],
    });
    const coverage = result.sections
      .map((section) => section.body)
      .find((text) => text.includes("3e stocks"));
    expect(coverage).toContain("- stock:SNDK · +17.2% week");
    const drafts = verdictCommitments({
      frame: f,
      doc: doc({ coverage: [CALL_SNDK] }),
      day: "2026-09-04",
      phase: "close",
      period: "daily",
    });
    expect(drafts.map((draft) => draft.id)).toEqual([
      "2026-09-04-close-verdict-stock:SNDK",
    ]);
    // The daily cadence settles after one open day, not five.
    expect(
      (drafts[0]?.payload as { settleAfterOpenDays?: number })
        .settleAfterOpenDays,
    ).toBe(1);
  });

  it("faults an unmintable call on a daily run too", () => {
    const f = frame();
    const result = reviewSections({
      frame: f,
      rotation: null,
      doc: doc({ coverage: [{ ...CALL_SNDK, id: "stock:FIG" }] }),
      caps: f.caps.daily,
      period: "daily",
      calendarRows: [],
    });
    expect(
      result.faults.some((fault) => fault.includes("no ledger commitment")),
    ).toBe(true);
  });
});

describe("the declined-call gate covers the ranked stock rows", () => {
  it("faults every ranked row nobody called", () => {
    const result = sections(doc());
    const fault = result.faults.find((line) =>
      line.includes("ranked stock rows"),
    );
    expect(fault).toBeDefined();
    // All four ranked names, none called.
    expect(fault).toContain("4 ranked stock rows");
    expect(fault).toContain("stock:SNDK");
    expect(fault).toContain("stock:AMD");
  });

  it('refuses "missing: " on the three largest |excess vs SPY|', () => {
    const excuse = (id: string) => ({
      id,
      token: "untested" as const,
      why: "missing: no operating datum this week",
      observable: "",
      scorable: false,
    });
    const result = sections(
      doc({
        coverage: [
          excuse("stock:SNDK"),
          excuse("stock:DELL"),
          excuse("stock:NVDA"),
          excuse("stock:AMD"),
        ],
      }),
    );
    const fault = result.faults.find((line) =>
      line.includes("ranked stock rows"),
    );
    // AMD is the fourth by |excess vs SPY|, so its reason is accepted; the
    // three largest are refused outright.
    expect(fault).toContain("3 ranked stock rows");
    expect(fault).toContain("stock:SNDK");
    expect(fault).toContain("stock:DELL");
    expect(fault).toContain("stock:NVDA");
    expect(fault).not.toContain("stock:AMD");
  });

  it("passes when the three largest are called and the rest name a gap", () => {
    const called = (id: string) => ({ ...CALL_SNDK, id });
    const result = sections(
      doc({
        coverage: [
          called("stock:SNDK"),
          called("stock:DELL"),
          called("stock:NVDA"),
          {
            id: "stock:AMD",
            token: "untested" as const,
            why: "missing: no in-window earnings or guidance",
            observable: "",
            scorable: false,
          },
        ],
      }),
    );
    expect(
      result.faults.some((line) => line.includes("ranked stock rows")),
    ).toBe(false);
  });

  it("marks the declined row on its printed line", () => {
    const result = sections(doc());
    const coverage = result.sections
      .map((section) => section.body)
      .find((text) => text.includes("3e stocks"));
    expect(coverage).toContain(
      "UNTESTED · not called this period · call declined on priced data",
    );
  });

  it("faults declined ranked rows on a daily run too", () => {
    const f = frame();
    const result = reviewSections({
      frame: f,
      rotation: null,
      doc: doc(),
      caps: f.caps.daily,
      period: "daily",
      calendarRows: [],
    });
    expect(
      result.faults.some((line) => line.includes("ranked stock rows")),
    ).toBe(true);
  });
});

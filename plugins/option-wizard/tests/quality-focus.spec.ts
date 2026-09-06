/**
 * The weekly 15 and the daily 5 are COMPUTED, never chosen.
 *
 * Every date asserted here is real: NVDA's next earnings date is the one
 * `ow_uw_earnings`' own verification comment recorded live on 2026-09-03
 * (`next_earnings_date: "2026-11-18"`, `announce_time: "unknown"`); the split
 * and the ex-dividend are the massive.com documentation's own AAPL rows
 * (execution 2005-02-28, ex-date 2025-08-11), read alongside a `day` that sits
 * a few sessions before each of them rather than re-dated to suit the test.
 * The universe is the real membership of three argon chains as Task 5 recorded
 * them.
 *
 * NOT covered, and named rather than faked: the `reportTime -> session`
 * mapping for a POST-market print. The tool comment records SNOW's
 * `announce_time` as `"postmarket"` but not SNOW's date, and inventing one to
 * exercise the branch would put a fabricated earnings date in a test whose
 * whole subject is dated events.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import {
  ADMITTED_EVENT_SOURCES,
  admitEvents,
  dailyFocus,
  decay,
  findFocusLeaks,
  focusEvents,
  scoreFocus,
  selectFocus,
  type FocusInputs,
} from "../quality/focus.js";
import {
  parseReviewConfig,
  type FocusConfig,
  type ThemeSpec,
} from "../quality/review-config.js";

const FIX = join(__dirname, "fixtures", "review");
const load = (name: string): any =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const TENANT = join(__dirname, "..", "tenant.yaml");
const config = parseReviewConfig(
  parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT).extensions,
);
const focusCfg = config.focus as FocusConfig;
const themes: ThemeSpec[] = config.themes;

/** Weekday arithmetic, injected. `quality/focus.ts` owns no calendar. */
const openDaysBetween = (from: string, to: string): number => {
  if (to === from) return 0;
  const forward = to > from;
  const [a, b] = forward ? [from, to] : [to, from];
  const cursor = new Date(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  let count = 0;
  while (cursor.getTime() < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return forward ? count : -count;
};

const gpu = load("watchlist-Computer-GPU.json").tickers.map(
  (row: { ticker: string }) => row.ticker,
) as string[];
const cyber = load("watchlist-Cybersecurity.json").tickers.map(
  (row: { ticker: string }) => row.ticker,
) as string[];
const beta = load("watchlist-Beta.json").tickers.map(
  (row: { ticker: string }) => row.ticker,
) as string[];
const UNIVERSE = [...gpu, ...cyber, ...beta];

const splitsDoc = load("massive-splits-docs.json");
const dividendsDoc = load("massive-dividends-docs.json");

/** The `ow_massive_actions` envelope, built from the documented rows. */
const actionsFrom = (args: {
  from: string;
  to: string;
  splits?: boolean;
  dividends?: boolean;
}): unknown => ({
  source: "massive",
  window: { from: args.from, to: args.to },
  splits:
    (args.splits ?? false)
      ? splitsDoc.results.map((row: Record<string, unknown>) => ({
          ticker: row.ticker,
          executionDate: row.execution_date,
          from: row.split_from,
          to: row.split_to,
          type: row.adjustment_type,
        }))
      : [],
  dividends:
    (args.dividends ?? false)
      ? dividendsDoc.results.map((row: Record<string, unknown>) => ({
          ticker: row.ticker,
          exDate: row.ex_dividend_date,
          declared: row.declaration_date,
          payDate: row.pay_date,
          recordDate: row.record_date,
          amount: row.cash_amount,
        }))
      : [],
  notes: [],
});

const base = (over: Partial<FocusInputs>): FocusInputs => ({
  day: "2026-09-06",
  universe: UNIVERSE,
  pinned: [],
  themes: [],
  pins: [],
  openDaysBetween,
  ...over,
});

const rowFor = (rows: readonly { ticker: string }[], ticker: string): any =>
  rows.find((row) => row.ticker === ticker);

describe("decay", () => {
  it.each([
    [10, 0, 7, 10],
    [10, 7, 7, 0],
    [10, 3, 7, 5.7143],
    [10, -1, 7, 0],
    [10, null, 7, 10],
    [8, 10, 10, 0],
  ])("decay(%s, %s, %s) === %s", (weight, away, window, expected) => {
    expect(decay(weight, away as number | null, window)).toBe(expected);
  });
});

describe("focusEvents", () => {
  // NVDA's real next earnings date, five sessions out from a `day` chosen to
  // sit inside the declared 7-session window.
  const earnings = {
    asOf: "2026-09-03T20:15:00.000Z",
    rows: [
      { ticker: "NVDA", nextEarningsDate: "2026-11-18", daysToEarnings: 5 },
    ],
    missing: [],
  };

  it("reads a real earnings date and refuses to invent a report time", () => {
    const events = focusEvents(base({ day: "2026-11-13", earnings }), focusCfg);
    const nvda = events.find((event) => event.ticker === "NVDA");
    expect(nvda).toBeDefined();
    expect(nvda?.kind).toBe("earnings");
    expect(nvda?.source).toBe("ow_uw_earnings");
    expect(nvda?.day).toBe("2026-11-18");
    expect(nvda?.sessionsAway).toBe(3);
    // UW's own "unknown" never becomes a report time.
    expect(nvda?.session).toBeUndefined();
  });

  it("scores nothing for an earnings date outside the window", () => {
    const rows = scoreFocus(base({ day: "2026-09-06", earnings }), focusCfg);
    const nvda = rowFor(rows, "NVDA");
    expect(nvda.score).toBe(0);
    expect(
      nvda.parts.find((part: { kind: string }) => part.kind === "earnings")
        ?.points,
    ).toBe(0);
  });

  it("drops an event from a source nobody verified", () => {
    const notes: string[] = [];
    const kept = admitEvents(
      [
        {
          ticker: "NVDA",
          kind: "corporate" as const,
          day: "2026-09-18",
          sessionsAway: 8,
          source: "get_market_events",
          label: "index add",
        },
      ],
      notes,
    );
    expect(kept).toEqual([]);
    expect(notes.join(" ")).toContain("get_market_events");
    expect(ADMITTED_EVENT_SOURCES.has("get_market_events")).toBe(false);
  });
});

describe("corporate actions", () => {
  const day = "2005-02-23";
  const inputs = base({
    day,
    universe: ["AAPL"],
    actions: actionsFrom({ from: day, to: "2005-03-10", splits: true }),
  });

  it("scores a split on its execution date, from the tool that dated it", () => {
    const rows = scoreFocus(inputs, focusCfg);
    const aapl = rowFor(rows, "AAPL");
    const part = aapl.parts.find(
      (entry: { kind: string }) => entry.kind === "corporate",
    );
    expect(part.from).toBe("ow_massive_actions");
    // weight 8, 3 open sessions into a 10-session window.
    expect(part.points).toBe(5.6);
    expect(aapl.score).toBe(5.6);
  });

  it("scores nothing for a split that already happened", () => {
    const rows = scoreFocus(
      base({
        day: "2026-09-06",
        universe: ["AAPL"],
        actions: actionsFrom({
          from: "2005-01-01",
          to: "2005-03-10",
          splits: true,
        }),
      }),
      focusCfg,
    );
    expect(rowFor(rows, "AAPL").score).toBe(0);
  });

  it("scores an ex-dividend only inside an open call's window", () => {
    const withCall = scoreFocus(
      base({
        day: "2025-08-06",
        universe: ["AAPL"],
        actions: actionsFrom({
          from: "2025-08-06",
          to: "2025-08-29",
          dividends: true,
        }),
        openCalls: [
          { id: "AAPL-2025-08-06-1", ticker: "AAPL", settleDay: "2025-08-20" },
        ],
      }),
      focusCfg,
    );
    const part = rowFor(withCall, "AAPL").parts.find(
      (entry: { kind: string }) => entry.kind === "assignmentRisk",
    );
    // weight 6, 3 open sessions into a 5-session window.
    expect(part.points).toBe(2.4);
  });

  it("produces no assignment-risk event at all with no open call", () => {
    const withoutCall = scoreFocus(
      base({
        day: "2025-08-06",
        universe: ["AAPL"],
        actions: actionsFrom({
          from: "2025-08-06",
          to: "2025-08-29",
          dividends: true,
        }),
      }),
      focusCfg,
    );
    expect(
      rowFor(withoutCall, "AAPL").parts.some(
        (entry: { kind: string }) => entry.kind === "assignmentRisk",
      ),
    ).toBe(false);
  });

  it("admits an operator-dated pin as the only path for a rebalance", () => {
    const rows = scoreFocus(
      base({
        day: "2026-09-14",
        universe: ["NVDA"],
        pins: [
          {
            ticker: "MARKET",
            day: "2026-09-18",
            kind: "corporate",
            label: "S&P quarterly rebalance effective",
          },
        ],
      }),
      focusCfg,
    );
    const part = rowFor(rows, "NVDA").parts.find(
      (entry: { kind: string }) => entry.kind === "corporate",
    );
    expect(part.from).toBe("tenant.yaml");
    // weight 8, 4 open sessions into a 10-session window.
    expect(part.points).toBe(4.8);
  });
});

describe("flow anomaly", () => {
  it("scores an IV rank of 84 and names the half that is missing", () => {
    const rows = scoreFocus(base({ ivRank: { NVDA: 84 } }), focusCfg);
    const part = rowFor(rows, "NVDA").parts.find(
      (entry: { kind: string }) => entry.kind === "flowAnomaly",
    );
    expect(part.from).toBe("ow_argon_watchlist iv_rank");
    expect(part.points).toBe(3);
    expect(rowFor(rows, "NVDA").ivRank).toBe(84);
  });

  it("does not score an IV rank of 79", () => {
    const rows = scoreFocus(base({ ivRank: { NVDA: 79 } }), focusCfg);
    expect(
      rowFor(rows, "NVDA").parts.some(
        (entry: { kind: string }) => entry.kind === "flowAnomaly",
      ),
    ).toBe(false);
  });
});

describe("scoreFocus over the recorded chains", () => {
  const inputs = base({
    pinned: ["NVDA"],
    themes,
    openCalls: [
      { id: "SPY-2026-09-03-2", ticker: "SPY", settleDay: "2026-09-11" },
    ],
  });

  it("sums its own parts and names every source", () => {
    const rows = scoreFocus(inputs, focusCfg);
    expect(rows.length).toBe(UNIVERSE.length);
    for (const row of rows) {
      const sum = Number(
        row.parts.reduce((total, part) => total + part.points, 0).toFixed(4),
      );
      expect(sum).toBe(row.score);
      for (const part of row.parts) expect(part.from.length).toBeGreaterThan(0);
    }
    expect(
      rowFor(rows, "NVDA").parts.map((p: { kind: string }) => p.kind),
    ).toContain("pinned");
    expect(rowFor(rows, "SPY").openCallIds).toEqual(["SPY-2026-09-03-2"]);
  });

  it("returns the same list whatever order the universe arrived in", () => {
    const shuffled = scoreFocus(
      { ...inputs, universe: [...UNIVERSE].reverse() },
      focusCfg,
    );
    expect(JSON.stringify(shuffled)).toBe(
      JSON.stringify(scoreFocus(inputs, focusCfg)),
    );
  });

  it("breaks a tie alphabetically", () => {
    const rows = scoreFocus(base({ universe: ["ZS", "AMD", "NET"] }), focusCfg);
    expect(rows.map((row) => row.ticker)).toEqual(["AMD", "NET", "ZS"]);
  });

  it("gives every universe member a row when nothing answered", () => {
    const rows = scoreFocus(base({}), focusCfg);
    expect(rows.length).toBe(UNIVERSE.length);
    expect(rows.every((row) => row.score === 0)).toBe(true);
  });
});

describe("selectFocus", () => {
  const rows = scoreFocus(base({ pinned: ["NVDA", "AMD"], themes }), focusCfg);

  it("gives the carried names their slots first", () => {
    const carried = ["ZS", "OKTA", "CHKP"];
    const picked = selectFocus({ rows, limit: 15, carried });
    expect(picked.rows.length).toBe(15);
    expect(
      picked.rows
        .slice(0, 3)
        .map((row) => row.ticker)
        .sort(),
    ).toEqual([...carried].sort());
    expect(picked.rows.slice(0, 3).every((row) => row.sticky === true)).toBe(
      true,
    );
    expect(picked.churn).toBe(0);
  });

  it("reports churn when more names are carried than there are slots", () => {
    const carried = UNIVERSE.slice(0, 17);
    const picked = selectFocus({ rows, limit: 15, carried });
    expect(picked.rows.length).toBe(15);
    expect(picked.churn).toBe(2);
    expect(picked.dropped.length).toBe(2);
    for (const entry of picked.dropped)
      expect(entry.why).toBe("carried list is 17 long; only 15 slots");
  });

  it("is byte-identical across two equal input objects", () => {
    const one = selectFocus({ rows, limit: 15, carried: ["NET"] });
    const two = selectFocus({
      rows: scoreFocus(base({ pinned: ["NVDA", "AMD"], themes }), focusCfg),
      limit: 15,
      carried: ["NET"],
    });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe("dailyFocus", () => {
  const all = scoreFocus(
    base({
      day: "2026-11-13",
      earnings: {
        asOf: "2026-11-13T21:00:00.000Z",
        rows: [
          { ticker: "NVDA", nextEarningsDate: "2026-11-18", daysToEarnings: 5 },
        ],
        missing: [],
      },
    }),
    focusCfg,
  );

  it("leads with the nearest event and tops up to the limit", () => {
    const weekly = all.slice(0, 3);
    const daily = dailyFocus(weekly, all, 5);
    expect(daily.length).toBe(5);
    expect(daily[0]?.ticker).toBe("NVDA");
  });

  it("returns what it has when the universe is smaller than the limit", () => {
    const two = scoreFocus(base({ universe: ["NVDA", "AMD"] }), focusCfg);
    expect(dailyFocus(two, two, 5).length).toBe(2);
  });
});

describe("findFocusLeaks", () => {
  it("flags a direction word and passes an event sentence", () => {
    const leaks = findFocusLeaks([
      { ticker: "NVDA", why: "bullish into the print" },
      {
        ticker: "AMD",
        why: "Q3 earnings after the close; guidance is the swing factor",
      },
    ]);
    expect(leaks.length).toBe(1);
    expect(leaks[0]?.field).toContain("NVDA");
    expect(leaks[0]?.pattern).toContain("bull");
    expect(leaks[0]?.excerpt.length).toBeLessThanOrEqual(40);
  });
});

describe("purity", () => {
  it("computes the list without a clock or a coin", async () => {
    const src = readFileSync(
      join(__dirname, "..", "quality", "focus.ts"),
      "utf8",
    );
    for (const banned of [
      "Date.now(",
      "Math.random(",
      "new Date(",
      "process.env",
      "node:fs",
    ])
      expect(src, banned).not.toContain(banned);
  });
});

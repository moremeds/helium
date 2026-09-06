/**
 * `ow_massive_actions` — dated splits and ex-dividends.
 *
 * The two fixtures are the vendor's own DOCUMENTED sample responses, fetched
 * 2026-09-06; no live call has been made. Every window in this file is chosen
 * so the documented rows fall inside or outside it, because inventing a
 * corporate action to test the mapping would be exactly the fabrication this
 * tool exists to remove.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

const FIX = join(__dirname, "fixtures", "review");
const SPLITS: unknown = JSON.parse(
  readFileSync(join(FIX, "massive-splits-docs.json"), "utf8"),
);
const DIVIDENDS: unknown = JSON.parse(
  readFileSync(join(FIX, "massive-dividends-docs.json"), "utf8"),
);

const ENV = { MASSIVE_API_KEY: "k" };

function tool(env: Record<string, string | undefined> = ENV) {
  const found = buildTools({ stateRoot: "/nonexistent", env }).find(
    (t) => t.name === "ow_massive_actions",
  );
  if (found === undefined) throw new Error("no tool ow_massive_actions");
  return found;
}

interface Seen {
  urls: string[];
  auth: Array<string | undefined>;
}

function serve(
  seen: Seen,
  opts: { failSplits?: boolean } = {},
): (url: URL | string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(input);
    seen.urls.push(url.toString());
    const headers = new Headers(init?.headers ?? {});
    seen.auth.push(headers.get("authorization") ?? undefined);
    if (url.pathname === "/stocks/v1/splits") {
      return opts.failSplits === true
        ? new Response("boom", { status: 500, statusText: "Server Error" })
        : new Response(JSON.stringify(SPLITS), { status: 200 });
    }
    if (url.pathname === "/stocks/v1/dividends") {
      return new Response(JSON.stringify(DIVIDENDS), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
}

interface Out {
  source: string;
  window: { from: string; to: string };
  splits: Array<Record<string, unknown>>;
  dividends: Array<Record<string, unknown>>;
  notes: string[];
}

async function run(
  args: Record<string, unknown>,
  seen: Seen,
  env: Record<string, string | undefined> = ENV,
  opts: { failSplits?: boolean } = {},
): Promise<Out> {
  return JSON.parse(
    await tool(env).run(args, { fetchImpl: serve(seen, opts) } as never),
  ) as Out;
}

/** The documented rows' own dates, so nothing has to be invented to be in
 *  range. Splits: AAPL 2005-02-28. Dividends: AAPL ex 2025-08-11. */
const WIDE = { from: "2005-01-01", to: "2025-12-31" };

describe("ow_massive_actions", () => {
  it("asks both endpoints for the window, once each, with a bearer key", async () => {
    const seen: Seen = { urls: [], auth: [] };
    await run(WIDE, seen);
    // TWO calls per run, not per ticker: both endpoints take a date range.
    expect(seen.urls).toHaveLength(2);
    const splits = new URL(seen.urls.find((u) => u.includes("/splits"))!);
    expect(splits.searchParams.get("execution_date.gte")).toBe(WIDE.from);
    expect(splits.searchParams.get("execution_date.lte")).toBe(WIDE.to);
    const dividends = new URL(seen.urls.find((u) => u.includes("/dividends"))!);
    expect(dividends.searchParams.get("ex_dividend_date.gte")).toBe(WIDE.from);
    expect(dividends.searchParams.get("ex_dividend_date.lte")).toBe(WIDE.to);
    // The header form is argon's, from a client that already talks to this
    // provider — not an invented auth scheme.
    expect(seen.auth).toEqual(["Bearer k", "Bearer k"]);
  });

  it("normalises the documented rows so no snake_case reaches a caller", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const out = await run(WIDE, seen);
    expect(out.source).toBe("massive");
    expect(out.window).toEqual(WIDE);
    expect(out.splits).toEqual([
      {
        ticker: "AAPL",
        executionDate: "2005-02-28",
        from: 1,
        to: 2,
        type: "forward_split",
      },
    ]);
    expect(out.dividends).toEqual([
      {
        ticker: "AAPL",
        exDate: "2025-08-11",
        declared: "2025-07-31",
        payDate: "2025-08-14",
        recordDate: "2025-08-11",
        amount: 0.26,
      },
    ]);
    expect(out.notes).toEqual([]);
  });

  it("filters out a row the window does not contain", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const out = await run({ from: "2026-09-08", to: "2026-09-22" }, seen);
    expect(out.splits).toEqual([]);
    expect(out.dividends).toEqual([]);
  });

  it("filters out a row for a ticker outside the supplied set", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const out = await run({ ...WIDE, tickers: ["NVDA", "AMD"] }, seen);
    expect(out.splits).toEqual([]);
    expect(out.dividends).toEqual([]);
  });

  it("passes the ticker through when exactly one is asked for", async () => {
    const seen: Seen = { urls: [], auth: [] };
    await run({ ...WIDE, tickers: ["AAPL"] }, seen);
    for (const url of seen.urls) {
      expect(new URL(url).searchParams.get("ticker")).toBe("AAPL");
    }
  });

  it("keeps the other endpoint's rows when one answers 500, and never throws", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const out = await run(WIDE, seen, ENV, { failSplits: true });
    expect(out.splits).toEqual([]);
    expect(out.dividends).toHaveLength(1);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain("/stocks/v1/splits");
  });

  it("throws its own name when MASSIVE_API_KEY is unset", async () => {
    const seen: Seen = { urls: [], auth: [] };
    await expect(run(WIDE, seen, {})).rejects.toThrow(
      /MASSIVE_API_KEY is unset; ow_massive_actions has no live route/u,
    );
  });

  it("defaults the base url and uses a declared one verbatim", async () => {
    const seen: Seen = { urls: [], auth: [] };
    await run(WIDE, seen);
    expect(new URL(seen.urls[0]!).origin).toBe("https://api.massive.com");
    const other: Seen = { urls: [], auth: [] };
    await run(WIDE, other, {
      ...ENV,
      MASSIVE_BASE_URL: "https://massive.internal",
    });
    expect(new URL(other.urls[0]!).origin).toBe("https://massive.internal");
  });
});

// TODO-verified-shape.
it.skip("ow_massive_actions: live shape unverified — run once with MASSIVE_API_KEY and record", () => {
  // The fixtures above are the vendor's DOCUMENTED samples, fetched
  // 2026-09-06 from https://massive.com/docs/rest/stocks/corporate-actions/
  // {splits,dividends}. No live call has been made. Before this tool is
  // trusted in production: run one real call for a known split (a recent
  // forward split in the universe) and one for a known dividend, paste the
  // observed keys and the date into the tool's header comment, replace both
  // fixtures with the recorded responses, and answer the two open questions —
  //   1. does /stocks/v1/splits return an ANNOUNCED split before its
  //      execution_date?
  //   2. are FORWARD-dated ex-dividend rows served at all? The documented
  //      sample's ex-date (2025-08-11) is in the past, so the plan's claim
  //      that the sample proves forward rows is WRONG and nothing here
  //      establishes it.
  // Unskip this test only when the comment names a live date.
});

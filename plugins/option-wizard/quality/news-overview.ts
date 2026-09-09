/**
 * The news overview block (#113).
 *
 * #106 asked for one screen that says "what is happening" BEFORE the author
 * picks a subject, plus the headlines behind each stock row it will write
 * about. Every phase gets it: the weekly author is choosing a subject from a
 * week of tape, the daily author is dating the cause it already has, so the
 * caps differ (`newsCapsFor`) and nothing else does. This module is the assembly: it decides what to ask for, in
 * what order, and what an unanswered symbol looks like. It does not fetch —
 * `read` is handed in, which is what lets the ordering, the venue fallback and
 * the missing guard be tested against frozen real rows.
 *
 * TWO RULES ARE STRUCTURAL HERE, not stylistic:
 *
 * 1. **Serial.** Every `read` is awaited before the next one starts. The reads
 *    are opencli subprocesses driving one local GUI app, and concurrent web
 *    reads on the mini fail ("Navigation rejected", 2026-09-06). There is no
 *    `Promise.all` in this file and there must never be one.
 * 2. **A headline is a citation, never a number.** Nothing here parses a
 *    figure out of a title. The rows carry `link` so a reader can check the
 *    quote — which is why TradingView is the source at all: the Unusual Whales
 *    feed carries no URL.
 *
 * @module dsh-plugin-tenant-option-wizard/quality/news-overview
 */

/** One headline, trimmed to what a citation needs. `urgency` and
 *  `related_symbols` are dropped HERE and only here: the tool itself returns
 *  all seven fields verbatim, but the frame is one payload under core's
 *  summariser ceiling (`SUMMARISE_OVER_BYTES`, 128 KiB) and those two fields
 *  buy a citation nothing. `id` stays
 *  because it is what `ow_tv_news --id` needs to fetch the body. */
export interface NewsRow {
  id: string;
  published: string;
  provider: string;
  title: string;
  link: string;
}

export interface NewsOverview {
  /** When the block was assembled, ISO. */
  asOf: string;
  /** TradingView's `markets_today` section: the global tape. */
  marketsToday: NewsRow[];
  /** TradingView's `economic` category: prints, central banks, fiscal. */
  economic: NewsRow[];
  /** One entry per stock that answered, in the order it was asked for. */
  stocks: Array<{ symbol: string; tvSymbol: string; headlines: NewsRow[] }>;
  /** Every symbol that produced no headline, with the reason. NEVER silently
   *  dropped: an absent name reads as "nothing happened to it", which is a
   *  quotable falsehood. */
  missing: Array<{ symbol: string; reason: string }>;
  notes: string[];
}

/**
 * The US venues a news symbol is tried on, in `tvLast`'s order and for its
 * reason: TradingView's `search` answers with a display name ("NYSE Arca")
 * while the news route wants a code ("AMEX"), so a resolver would be a
 * translation table that rots. Probed live 2026-09-09: `--symbol AMEX:SPY`
 * returns rows, `--symbol "NYSE Arca:SPY"` and `--symbol NYSE:NVDA` both
 * return `[]`. An empty list is the ONLY signal a wrong venue gives, so the
 * miss reason below never claims which of the two it was.
 */
export const NEWS_VENUES: readonly string[] = ["NASDAQ", "AMEX", "NYSE"];

/**
 * The caps, per phase. Daily is the same block at a smaller scale, not a
 * different block: the weekly author is choosing a subject from a week of
 * tape, while a daily author already knows the day's cause and needs the
 * headline that dates it. Both are measured, not tasteful — a FULL weekly
 * block is 17 KB of JSON with every row carrying the longest real link in the
 * fixtures (the test asserts it) against core's 128 KiB
 * `SUMMARISE_OVER_BYTES`, and the frame carries plenty besides this block.
 *
 * `stocks` is a COST cap as much as a context one: each symbol is up to three
 * opencli subprocesses on a miss, and a daily run has a 4-times-a-day budget
 * the weekly does not. It is the ranked candidates plus room for the
 * operator's pinned names; truncation is a note, never silence.
 */
export interface NewsCaps {
  /** Rows kept from each of the two global feeds. */
  global: number;
  /** Headlines per stock. */
  perStock: number;
  /** How many stocks are asked for headlines at all. */
  stocks: number;
}

export const NEWS_CAPS: Readonly<Record<"weekly" | "daily", NewsCaps>> = {
  weekly: { global: 8, perStock: 3, stocks: 12 },
  daily: { global: 4, perStock: 2, stocks: 5 }, // 2 + 5 calls ≈ 10 s on the mini; matches the daily candidate cap of 5
};

/** The caps a phase gets. Anything that is not the weekly run is daily —
 *  premarket, intraday, close, and an unnamed phase alike. A host that
 *  forgets to pass a phase must get the CHEAPER block, never the larger one. */
export function newsCapsFor(phase: string | undefined): NewsCaps {
  return phase === "weekly" ? NEWS_CAPS.weekly : NEWS_CAPS.daily;
}

/** What `buildNewsOverview` is handed: run one news read and give back the
 *  parsed payload. Anything it throws is recorded, never swallowed. */
export type NewsRead = (args: {
  symbol?: string;
  section?: string;
  category?: string;
  limit: number;
}) => Promise<unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The rows of a news payload, defensively. A payload that refused
 * (`{unavailable: "as-of"}`) has no `rows` and must not read as a quiet news
 * day; a row missing `link` is DROPPED, because a citation a reader cannot
 * open is the failure mode this whole block exists to avoid.
 */
export function newsRowsOf(payload: unknown, limit: number): NewsRow[] {
  const rows = (payload as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  const out: NewsRow[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const link = text(row.link);
    const title = text(row.title);
    if (link === "" || title === "") continue;
    out.push({
      id: text(row.id),
      published: text(row.published),
      provider: text(row.provider),
      title,
      link,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The first US venue whose news feed answers for `symbol`, and its rows.
 *
 * ONE loop, two callers — `ow_tv_news` resolving a bare ticker and the
 * overview below — so the venue order and the "empty means try the next one"
 * rule cannot drift apart. Serial: each venue is awaited before the next.
 */
export async function resolveVenue<T>(
  symbol: string,
  fetchRows: (tvSymbol: string) => Promise<T[]>,
): Promise<{ tvSymbol: string; rows: T[] } | undefined> {
  for (const venue of NEWS_VENUES) {
    const tvSymbol = `${venue}:${symbol}`;
    const rows = await fetchRows(tvSymbol);
    if (rows.length > 0) return { tvSymbol, rows };
  }
  return undefined;
}

/** The reason a symbol produced nothing. It never claims WHICH of the two
 *  causes it was: an empty list is the only signal a wrong venue gives. */
export function noVenueReason(symbol: string): string {
  return (
    `no headline on ${NEWS_VENUES.join(", ")}:${symbol} — TradingView answers an ` +
    "unknown venue with an empty list, so this is either an exchange we did not " +
    "resolve or a symbol with no story"
  );
}

/** A payload that REFUSED rather than answered — `{unavailable: "as-of", …}`
 *  from the replay wrapper — and its reason. A refusal is not an empty news
 *  day and must never be read as one. */
export function refusalOf(payload: unknown): string | undefined {
  const row = payload as
    { unavailable?: unknown; reason?: unknown } | undefined;
  if (typeof row?.unavailable !== "string") return undefined;
  return typeof row.reason === "string" && row.reason !== ""
    ? `${row.unavailable}: ${row.reason}`
    : row.unavailable;
}

function why(error: unknown): string {
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? error.message)
    : String(error);
}

/**
 * Assemble the block: the two global feeds, then one stock at a time.
 *
 * The stock list arrives already ordered — ranked coverage candidates first,
 * then the operator's pinned names — because the cap has to drop the least
 * important names, and only the caller knows which those are.
 */
export async function buildNewsOverview(args: {
  asOf: string;
  symbols: readonly string[];
  read: NewsRead;
  caps: NewsCaps;
}): Promise<NewsOverview> {
  const { caps } = args;
  const limit = caps.stocks;
  const notes: string[] = [];
  const missing: Array<{ symbol: string; reason: string }> = [];

  const failures: string[] = [];
  const feed = async (
    label: string,
    ask: { section?: string; category?: string },
  ): Promise<NewsRow[]> => {
    try {
      const payload = await args.read({ ...ask, limit: caps.global });
      const refused = refusalOf(payload);
      if (refused !== undefined) {
        failures.push(refused);
        notes.push(`${label} did not answer: ${refused}`);
        return [];
      }
      return newsRowsOf(payload, caps.global);
    } catch (error: unknown) {
      const reason = why(error);
      failures.push(reason);
      notes.push(`${label} did not answer: ${reason}`);
      return [];
    }
  };

  const marketsToday = await feed("markets_today", {
    section: "markets_today",
  });
  const economic = await feed("economic", { category: "economic" });
  // BOTH feeds refused with the same reason — a thrown error or an explicit
  // `{unavailable}` payload: the route itself is down (no TradingView on this
  // machine, an as-of replay, a closed CDP port). Probing
  // twelve symbols x three venues would spend 36 subprocesses to collect 12
  // copies of one sentence. One note says it once.
  const routeDown =
    failures.length === 2 && failures[0] === failures[1]
      ? failures[0]
      : undefined;
  if (routeDown !== undefined)
    notes.push(
      `the news route is unavailable (${routeDown}); no per-stock headlines were attempted`,
    );
  else if (marketsToday.length === 0 && economic.length === 0)
    notes.push(
      "neither global feed returned a headline; the overview below is per-stock only",
    );

  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.symbols) {
    const symbol = raw.trim().toUpperCase();
    if (symbol === "" || seen.has(symbol)) continue;
    seen.add(symbol);
    wanted.push(symbol);
  }
  const asked = routeDown === undefined ? wanted.slice(0, limit) : [];
  if (routeDown === undefined && wanted.length > asked.length)
    notes.push(
      `asked ${String(asked.length)} of ${String(wanted.length)} symbols for headlines (cap ${String(limit)}); the ranked candidates come first`,
    );

  const stocks: NewsOverview["stocks"] = [];
  // Serial by construction: symbol after symbol, venue after venue.
  for (const symbol of asked) {
    let hit: { tvSymbol: string; rows: NewsRow[] } | undefined;
    try {
      hit = await resolveVenue(symbol, async (tvSymbol) =>
        newsRowsOf(
          await args.read({ symbol: tvSymbol, limit: caps.perStock }),
          caps.perStock,
        ),
      );
    } catch (error: unknown) {
      missing.push({ symbol, reason: why(error) });
      continue;
    }
    if (hit === undefined) {
      missing.push({ symbol, reason: noVenueReason(symbol) });
      continue;
    }
    stocks.push({ symbol, tvSymbol: hit.tvSymbol, headlines: hit.rows });
  }

  return { asOf: args.asOf, marketsToday, economic, stocks, missing, notes };
}

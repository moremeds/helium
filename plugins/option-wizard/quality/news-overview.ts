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
 * 3. **The global feeds are ranked, not sliced.** Until 2026-09-09 the two
 *    global feeds were the N most RECENT rows the feed returned, which is a
 *    time filter wearing an editor's hat. That morning's premarket kept a
 *    Saputo tariff market-talk, an oil headline, a Fortum/Google power deal
 *    and the Baltic index, while Benzinga's "Meta Trending After Unveiling
 *    Muse, Its First Personal AI Agent" (11:44:22Z, urgency 2, related
 *    NASDAQ:META) had already scrolled out of a four-row window by 13:07Z —
 *    with META up on the day. So the feeds are now fetched DEEP
 *    (`NEWS_FETCH_LIMIT`, the tool's own hard maximum) in the same number of
 *    calls, deduped by story, and ordered by `rankGlobalNews` before the cap
 *    is applied. The cap still bounds what enters the frame; it no longer
 *    decides what is important.
 *
 * @module dsh-plugin-tenant-option-wizard/quality/news-overview
 */

/** One headline, trimmed to what a citation needs. `urgency` and
 *  `related_symbols` are READ for ranking and then dropped HERE and only
 *  here: the tool itself returns all seven fields verbatim, but the frame is
 *  one payload under core's summariser ceiling (`SUMMARISE_OVER_BYTES`,
 *  128 KiB) and neither field buys a citation anything once the order is
 *  fixed. `id` stays because it is what `ow_tv_news --id` needs to fetch the
 *  body. */
export interface NewsRow {
  id: string;
  published: string;
  provider: string;
  title: string;
  link: string;
}

/** What a global feed's fetch turned into, by counting only. `fetched` is
 *  every row the feed returned, `kept` is what reached the frame, and the
 *  three `dropped` buckets account for the difference exactly:
 *  `fetched === kept + duplicate + unlinked + capped`. It exists so the page
 *  can say "4 of 25, 1 duplicate story" rather than implying the tape was
 *  quiet. No ratio, no percentage — the renderer prints these integers. */
export interface NewsSelectionCounts {
  fetched: number;
  kept: number;
  dropped: { duplicate: number; unlinked: number; capped: number };
}

export interface NewsOverview {
  /** When the block was assembled, ISO. */
  asOf: string;
  /** TradingView's `markets_today` section: the global tape. */
  marketsToday: NewsRow[];
  /** TradingView's `economic` category: prints, central banks, fiscal. */
  economic: NewsRow[];
  /** How each global feed's fetch was reduced to the rows above. */
  selection: { marketsToday: NewsSelectionCounts; economic: NewsSelectionCounts };
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

/**
 * How deep the two GLOBAL feeds are fetched, before ranking and before
 * `caps.global`. It is `ow_tv_news`'s own hard maximum, not a number picked
 * here: the tool clamps `limit` to 25 because 25 rows of these fields is
 * ~7 KB, the same order as `ow_uw_headlines`. The task's "e.g. 30" is above
 * that clamp, so 25 is what a deeper fetch can actually mean today.
 *
 * This changes the DEPTH of each call, never the NUMBER of calls: still one
 * `markets_today` read and one `economic` read, still serial. Per-stock feeds
 * are untouched — they are already scoped to one symbol, so a deeper fetch
 * there would buy ranking nothing and would cost real subprocess time.
 */
export const NEWS_FETCH_LIMIT = 25;

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

/** A parsed row plus the two fields ranking reads and the frame does not
 *  carry. Internal on purpose: `urgency` and `symbols` never leave this
 *  module, so no renderer can start quoting an urgency code as if it meant
 *  something to a reader. */
interface RankRow {
  row: NewsRow;
  /** TradingView's own urgency, LOWER is more urgent (1 beats 2). Absent when
   *  the row did not carry a number. */
  urgency: number | undefined;
  /** `related_symbols` reduced to bare tickers: "NASDAQ:META,TVC:GOLD" ->
   *  ["META", "GOLD"]. The venue is dropped because the tracked universe is
   *  keyed by ticker. */
  symbols: string[];
}

/** The tickers in a `related_symbols` field, which the live feed returns as a
 *  comma-joined string ("NASDAQ:META", "TVC:GOLD,OANDA:XAUUSD", ""). An array
 *  is accepted too: the tool passes the provider's shape through verbatim and
 *  this module never wants a shape change to read as "no symbols". */
function relatedTickers(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((entry) => text(entry))
    : text(value).split(",");
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const bare = trimmed.slice(trimmed.lastIndexOf(":") + 1).toUpperCase();
    if (bare !== "") out.push(bare);
  }
  return out;
}

/**
 * The rows of a news payload, defensively, with what ranking needs. A payload
 * that refused (`{unavailable: "as-of"}`) has no `rows` and must not read as a
 * quiet news day; a row missing `link` is DROPPED, because a citation a reader
 * cannot open is the failure mode this whole block exists to avoid — and
 * counted, so the drop is visible rather than silent.
 */
function parseRankRows(payload: unknown): {
  rows: RankRow[];
  fetched: number;
  unlinked: number;
} {
  const rows = (payload as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) return { rows: [], fetched: 0, unlinked: 0 };
  const out: RankRow[] = [];
  let unlinked = 0;
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") {
      unlinked += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;
    const link = text(row.link);
    const title = text(row.title);
    if (link === "" || title === "") {
      unlinked += 1;
      continue;
    }
    out.push({
      row: {
        id: text(row.id),
        published: text(row.published),
        provider: text(row.provider),
        title,
        link,
      },
      urgency: typeof row.urgency === "number" ? row.urgency : undefined,
      symbols: relatedTickers(row.related_symbols),
    });
  }
  return { rows: out, fetched: rows.length, unlinked };
}

/**
 * The rows of a news payload, trimmed to a citation and capped. Unchanged
 * behaviour for the per-stock feeds, which are already scoped to one symbol
 * and arrive in the provider's order.
 */
export function newsRowsOf(payload: unknown, limit: number): NewsRow[] {
  return parseRankRows(payload)
    .rows.slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * A title with the provider suffix removed, for dedupe only. The same wire
 * story reaches the tape as "… — Barrons.com", "… — WSJ" and "… — Market
 * Talk"; keeping all three spends the cap on one story. Everything after the
 * LAST em/en dash goes, then case and whitespace are normalised.
 *
 * Deliberately NOT a hyphen: "Anglo-American" and "e-commerce" are titles, not
 * attributions, and an ASCII hyphen would eat them.
 */
function storyKey(title: string): string {
  return title
    .replace(/\s*[\u2014\u2013]\s*[^\u2014\u2013]*$/u, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** Which of a pair is the one a dup group keeps: the EARLIEST published, then
 *  the smaller id, then the smaller title. The last two exist only so the
 *  answer does not depend on which row the feed happened to list first. */
function earlier(a: RankRow, b: RankRow): RankRow {
  if (a.row.published !== b.row.published)
    return a.row.published < b.row.published ? a : b;
  if (a.row.id !== b.row.id) return a.row.id < b.row.id ? a : b;
  return a.row.title <= b.row.title ? a : b;
}

/** Missing urgency sorts as if it were the least urgent value there is, so a
 *  row that carries the signal always outranks a row that does not. */
const URGENCY_ABSENT = Number.MAX_SAFE_INTEGER;

/**
 * Dedupe by story, then order by importance, then cap. Deterministic and
 * total: no model, no clock, and no arithmetic beyond counting how many of a
 * row's related symbols are in the tracked universe.
 *
 * The order is `urgency` ascending (TradingView: 1 is more urgent than 2),
 * then universe hits descending, then `published` descending, then `id` and
 * `title` ascending. The last two keys are what make it a total order — with
 * them the same rows in a different order give the same output, which is the
 * property that keeps a run reproducible against a frozen recording.
 *
 * Rule 4 of #113: nothing is dropped for being OLD. The window is whatever the
 * feed returned; an 11:44Z story is still the day's story at 13:07Z.
 */
function rankGlobalNews(
  payload: unknown,
  args: { universe: ReadonlySet<string>; cap: number },
): { rows: NewsRow[]; counts: NewsSelectionCounts } {
  const parsed = parseRankRows(payload);

  // Two grouping passes, id first then story key, each keeping the earliest
  // row of its group. Grouping rather than "skip the second one seen" is what
  // makes the result independent of the feed's order.
  const byId = new Map<string, RankRow>();
  const anonymous: RankRow[] = [];
  for (const entry of parsed.rows) {
    if (entry.row.id === "") {
      anonymous.push(entry);
      continue;
    }
    const seen = byId.get(entry.row.id);
    byId.set(entry.row.id, seen === undefined ? entry : earlier(seen, entry));
  }
  const byStory = new Map<string, RankRow>();
  for (const entry of [...byId.values(), ...anonymous]) {
    const key = storyKey(entry.row.title);
    const seen = byStory.get(key);
    byStory.set(key, seen === undefined ? entry : earlier(seen, entry));
  }

  const unique = [...byStory.values()];
  const duplicate = parsed.rows.length - unique.length;
  const hits = new Map<RankRow, number>();
  for (const entry of unique)
    hits.set(
      entry,
      entry.symbols.filter((ticker) => args.universe.has(ticker)).length,
    );

  unique.sort((a, b) => {
    const urgency = (a.urgency ?? URGENCY_ABSENT) - (b.urgency ?? URGENCY_ABSENT);
    if (urgency !== 0) return urgency;
    const breadth = (hits.get(b) ?? 0) - (hits.get(a) ?? 0);
    if (breadth !== 0) return breadth;
    if (a.row.published !== b.row.published)
      return a.row.published < b.row.published ? 1 : -1;
    if (a.row.id !== b.row.id) return a.row.id < b.row.id ? -1 : 1;
    if (a.row.title === b.row.title) return 0;
    return a.row.title < b.row.title ? -1 : 1;
  });

  const kept = unique.slice(0, Math.max(args.cap, 0));
  return {
    rows: kept.map((entry) => entry.row),
    counts: {
      fetched: parsed.fetched,
      kept: kept.length,
      dropped: {
        duplicate,
        unlinked: parsed.unlinked,
        capped: unique.length - kept.length,
      },
    },
  };
}

/** The counts a feed that never answered reports: nothing fetched, nothing
 *  kept, nothing filtered. The note beside it says why. */
const NO_SELECTION: NewsSelectionCounts = {
  fetched: 0,
  kept: 0,
  dropped: { duplicate: 0, unlinked: 0, capped: 0 },
};

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
  /** The tracked universe, as bare tickers. It is the second ranking key: a
   *  global headline about names this run already follows beats one about a
   *  name it does not. Absent it, ranking falls back to urgency and recency —
   *  never an error, because a caller with no universe is still better served
   *  by a deduped feed. */
  universe?: readonly string[];
}): Promise<NewsOverview> {
  const { caps } = args;
  const universe = new Set(
    (args.universe ?? []).map((ticker) => ticker.trim().toUpperCase()),
  );
  universe.delete("");
  const limit = caps.stocks;
  const notes: string[] = [];
  const missing: Array<{ symbol: string; reason: string }> = [];

  const failures: string[] = [];
  // Fetched DEEP and capped LATE: one call per feed, `NEWS_FETCH_LIMIT` rows
  // asked for, `caps.global` rows kept after dedupe and ranking. The cap is
  // still what bounds the frame; it is no longer what decides importance.
  const feed = async (
    label: string,
    ask: { section?: string; category?: string },
  ): Promise<{ rows: NewsRow[]; counts: NewsSelectionCounts }> => {
    try {
      const payload = await args.read({ ...ask, limit: NEWS_FETCH_LIMIT });
      const refused = refusalOf(payload);
      if (refused !== undefined) {
        failures.push(refused);
        notes.push(`${label} did not answer: ${refused}`);
        return { rows: [], counts: NO_SELECTION };
      }
      return rankGlobalNews(payload, { universe, cap: caps.global });
    } catch (error: unknown) {
      const reason = why(error);
      failures.push(reason);
      notes.push(`${label} did not answer: ${reason}`);
      return { rows: [], counts: NO_SELECTION };
    }
  };

  const marketsTodayFeed = await feed("markets_today", {
    section: "markets_today",
  });
  const economicFeed = await feed("economic", { category: "economic" });
  const marketsToday = marketsTodayFeed.rows;
  const economic = economicFeed.rows;
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

  return {
    asOf: args.asOf,
    marketsToday,
    economic,
    selection: {
      marketsToday: marketsTodayFeed.counts,
      economic: economicFeed.counts,
    },
    stocks,
    missing,
    notes,
  };
}

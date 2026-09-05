/**
 * Bars, in ET sessions, from whatever holds them.
 *
 * The settler never selects by HKT date. The lake's 1m file is EXTENDED HOURS
 * and its `bar_timestamp` is `TIMESTAMP WITH TIME ZONE` in `Asia/Hong_Kong`
 * (~850 rows per HKT date, verified on the mini 2026-09-04/05/06), so ONE ET
 * session spans two HKT dates: 09:30 ET is 21:30 the same HK day and 15:59 ET
 * is 03:59 the NEXT one. Everything here converts to America/New_York first.
 *
 * Production reads apex, not the parquet: `ow_apex_bars`
 * (`tools/index.ts:2892`) already serves the same lake over HTTP with no
 * credential, so there is no duckdb dependency to add and no second reader to
 * keep in step. apex normalises `time` to UTC
 * (`apex src/api/payload/chart.py:15-46`), which is why an instant is all this
 * module ever reads.
 * @module dsh-plugin-tenant-option-wizard/eval/bars
 */

/** One OHLCV row, field-for-field as apex returns it. */
export interface Bar {
  /** UTC ISO instant for an intraday bar; `yyyy-mm-dd` for a daily bar. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarSource {
  /** RTH-inclusive 1m bars covering the ET session dates `fromEt..toEt`. */
  bars1m(symbol: string, fromEt: string, toEt: string): Promise<Bar[]>;
  /** Daily bars for the trade dates `fromDate..toDate`. */
  bars1d(symbol: string, fromDate: string, toDate: string): Promise<Bar[]>;
}

export const RTH_OPEN = 9 * 60 + 30;
export const RTH_CLOSE = 16 * 60;
/**
 * A full RTH session is 390 one-minute bars. 380 is the floor a session must
 * clear to be trusted: an early close is not the case this guards — those are
 * in the tenant's calendar — a LAKE GAP is, and a gap is why
 * `livewire-shepherd` exists. A short session is `pending`, never a verdict.
 */
export const MIN_RTH_BARS = 380;

const ET = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function etSession(iso: string): { date: string; minute: number } {
  const parts = new Map(
    ET.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = Number(parts.get("hour")) % 24;
  return {
    date: `${parts.get("year")!}-${parts.get("month")!}-${parts.get("day")!}`,
    minute: hour * 60 + Number(parts.get("minute")),
  };
}

/** The tenant's own word on which days it has nothing to say about. */
export interface TenantCalendar {
  weekdaysOnly: boolean;
  closed: readonly string[];
}

/**
 * The ET weekdays in `[from, to]` that the tenant says are OPEN and the lake
 * has no daily bar for. Spec §5 D3: settlement still counts lake bars, and the
 * calendar is a CROSS-CHECK — a weekday nobody declared closed with no bar is
 * a lake gap, and a gap must settle `pending`, never `not-entered`.
 *
 * No calendar means no cross-check. The tenant is the only thing that knows
 * why a day is shut (`packages/core/src/tenant.ts:39-60`), and a settler that
 * guessed at holidays would be the exchange calendar this repo has decided not
 * to grow.
 */
export function missingWeekdays(
  have: readonly string[],
  from: string,
  to: string,
  calendar?: TenantCalendar,
): string[] {
  if (calendar === undefined) return [];
  const known = new Set(have);
  const closed = new Set(calendar.closed);
  const out: string[] = [];
  for (
    let at = Date.parse(`${from}T12:00:00Z`);
    at <= Date.parse(`${to}T12:00:00Z`);
    at += 86_400_000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (date <= from) continue;
    const weekday = new Date(at).getUTCDay();
    if (calendar.weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    if (closed.has(date) || known.has(date)) continue;
    out.push(date);
  }
  return out;
}

/** ET session date -> that session's RTH bars, in time order. */
export function rthSessions(bars: readonly Bar[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const bar of [...bars].sort((a, b) => a.time.localeCompare(b.time))) {
    const { date, minute } = etSession(bar.time);
    if (minute < RTH_OPEN || minute >= RTH_CLOSE) continue;
    const list = out.get(date);
    if (list === undefined) out.set(date, [bar]);
    else list.push(bar);
  }
  return out;
}

/** The frozen fixture, for tests. Never used in production. */
export function fixtureBarSource(doc: {
  bars1m: Bar[];
  bars1d: Bar[];
}): BarSource {
  return {
    async bars1m(_symbol, fromEt, toEt) {
      return doc.bars1m.filter((bar) => {
        const { date } = etSession(bar.time);
        return date >= fromEt && date <= toEt;
      });
    },
    async bars1d(_symbol, fromDate, toDate) {
      return doc.bars1d.filter(
        (bar) => bar.time >= fromDate && bar.time <= toDate,
      );
    },
  };
}

/**
 * apex over HTTP, mirroring `ow_apex_bars`: `start` must be offset-aware or
 * apex answers 500, and no credential is needed. The window is widened by a
 * day on each side and then filtered by ET session, because an ET session date
 * is not a UTC date.
 *
 * `price_mode=raw`, NOT `adjusted`. Verified against the live apex at
 * `OW_APEX_API_BASE` on 2026-09-06: `adjusted` silently truncates the daily
 * series at the last date its factor coverage reaches — 08-20..09-10 returned
 * 7 bars ending 2026-08-28 where `raw` returned 12 ending 2026-09-04 — and for
 * 1m it refuses outright with `adjusted_unavailable: incomplete or overlapping
 * factor coverage for SPY 1m`. A settler reading `adjusted` therefore reports
 * `pending` forever on the newest sessions, which is the one failure mode that
 * looks exactly like a quiet market. Raw is also what the receipt already
 * claims (`priceBasis: "raw, not dividend-adjusted"`), so this is the mode the
 * evidence was always describing.
 */
export function apexBarSource(
  base: string,
  fetchImpl: typeof fetch = fetch,
): BarSource {
  const day = 86_400_000;
  async function bars(
    symbol: string,
    timeframe: string,
    fromIso: string,
    toIso: string,
  ): Promise<Bar[]> {
    const url = new URL(`/v1/equity/${encodeURIComponent(symbol)}/bars`, base);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", fromIso);
    url.searchParams.set("end", toIso);
    url.searchParams.set("price_mode", "raw");
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(
        `settler: ${url.pathname} returned ${String(response.status)} ${response.statusText}`,
      );
    const body = (await response.json()) as { bars?: Bar[] };
    return body.bars ?? [];
  }
  return {
    async bars1m(symbol, fromEt, toEt) {
      return bars(
        symbol,
        "1m",
        new Date(Date.parse(`${fromEt}T00:00:00Z`) - day).toISOString(),
        new Date(Date.parse(`${toEt}T00:00:00Z`) + day).toISOString(),
      );
    },
    async bars1d(symbol, fromDate, toDate) {
      const rows = await bars(
        symbol,
        "1d",
        new Date(Date.parse(`${fromDate}T00:00:00Z`) - day).toISOString(),
        new Date(Date.parse(`${toDate}T00:00:00Z`) + day).toISOString(),
      );
      // A daily bar is a DATE that apex serves as UTC midnight of the trade
      // date — verified live 2026-09-06: `2026-09-03T00:00:00+00:00` carries
      // close 773.17, the same close the lake's `trade_date` 2026-09-03 row
      // holds. Reading it through `etSession` would call it 20:00 on 09-02 and
      // move every daily bar back one day, which is why the UTC date is taken
      // literally here while every intraday bar goes through the ET session.
      return rows
        .map((bar) => ({ ...bar, time: bar.time.slice(0, 10) }))
        .filter((bar) => bar.time >= fromDate && bar.time <= toDate);
    },
  };
}

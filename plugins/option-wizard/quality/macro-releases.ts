/**
 * The week's macro release calendar (#107, the data layer for #106).
 *
 * Two facts the report keeps getting wrong without this: WHAT prints today,
 * and WHETHER a number the page quotes has actually printed yet. argon's
 * `/macro/releases` answers both — the Unusual Whales calendar for the
 * schedule, FRED for the actual — and this module does the only two things
 * that may be done to that payload: FILTER it to the session, and SPLIT it on
 * whether the print exists.
 *
 * Nothing here computes. `forecast` and `prior` are the source's own TEXT
 * ("3.4%", "208K") and are carried verbatim: parsing them into numbers would
 * put an arithmetic of ours behind a figure the reader will read as UW's, and
 * a surprise is NEVER derived here from forecast and prior — argon's contract
 * is explicit that `actual` is the only place a printed value comes from.
 *
 * A release counts as PRINTED only when `actual` is not null. argon writes
 * `series_id`, `actual` and `published_at` as one null group — an event is
 * mapped to a hand-checked FRED series or it is not — so `series_id: null`
 * means unmapped, never unavailable, and the split below gates on `actual`
 * alone.
 *
 * Pure: no fetch, so the filtering can be tested against a frozen real week.
 * @module dsh-plugin-tenant-option-wizard/quality/macro-releases
 */

/** One row of argon's `/macro/releases`, in argon's own field spelling.
 *  Verified against the contract recorded on helium #107 (argon PR #428,
 *  flag `UW_SCAN_MACRO_RELEASE_CALENDAR_ENABLED`, 2026-09-08). */
export interface MacroRelease {
  /** UW's own event text, e.g. "CPI (YoY)". Never rewritten. */
  event: string;
  type: string;
  /** The period the print is ABOUT, e.g. "2026-08" — not when it lands. */
  reported_period: string;
  /** ISO-8601 with offset. UTC in every row seen so far. */
  scheduled_at: string;
  /** UW TEXT ("3.4%", "208K"), nullable. Never parsed into a number. */
  forecast: string | null;
  prior: string | null;
  /** null = this event is not mapped to a FRED series (only UNRATE is today),
   *  which is not the same as "the number is unavailable". */
  series_id: string | null;
  /** The printed value, CARRIED VERBATIM and never parsed. argon's OpenAPI
   *  (`MacroReleaseRow`, read 2026-09-09 off argon's own
   *  `feat/macro-release-calendar`) serialises it as a decimal STRING to keep
   *  the publisher's precision, while helium #107's written contract calls it
   *  a number — so both are accepted and neither is converted. null before the
   *  print, and null forever for an unmapped event. Its non-nullness is the
   *  ONLY gate on quoting a release as printed. */
  actual: string | number | null;
  revision: boolean;
  /** When the actual became public — FRED's realtime_start. date-time in
   *  argon's schema; a bare YYYY-MM-DD is read the same way. */
  published_at: string | null;
}

/** What the summariser hands the frame. `scheduled` and `printed` partition
 *  the rows the phase kept; a row is never in both. */
export interface MacroReleasesSummary {
  weekStart: string;
  weekEnd: string;
  /** Not printed yet (`actual` null), ascending by `scheduled_at`. */
  scheduled: MacroRelease[];
  /** Printed (`actual` not null), ascending by `scheduled_at`. */
  printed: MacroRelease[];
  /** Present only when the calendar could not be read at all — the endpoint is
   *  absent, the flag is off, argon is old. The frame still builds; the page
   *  says the calendar is missing rather than saying nothing prints. */
  unavailable?: string;
}

/** The phases whose report is about ONE session. `weekly` (and anything not
 *  named here) reads the whole week. */
const DAILY_PHASES = new Set(["premarket", "intraday", "close"]);

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The calendar day of an ISO instant, as the source spells it: the leading
 *  YYYY-MM-DD. `scheduled_at` and `published_at` are both UTC date-times in
 *  argon's schema, so this is a prefix read rather than a zone conversion — a conversion here would move a 12:30Z print onto the
 *  previous day for anyone reading from a western offset. */
function dayOf(value: string | null): string | null {
  if (value === null) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
}

function releaseOf(raw: unknown): MacroRelease | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const event = str(row.event);
  const scheduled_at = str(row.scheduled_at);
  if (event === null || scheduled_at === null) return undefined;
  return {
    event,
    type: str(row.type) ?? "",
    reported_period: str(row.reported_period) ?? "",
    scheduled_at,
    forecast: str(row.forecast),
    prior: str(row.prior),
    series_id: str(row.series_id),
    // No coercion in either direction: a string stays a string, a number
    // stays a number, and anything else is no print at all.
    actual:
      typeof row.actual === "string" && row.actual !== ""
        ? row.actual
        : typeof row.actual === "number" && Number.isFinite(row.actual)
          ? row.actual
          : null,
    revision: row.revision === true,
    published_at: str(row.published_at),
  };
}

/**
 * Split one `/macro/releases` payload into what is still coming and what has
 * printed, at the scale the phase reports on.
 *
 * A daily phase keeps the releases scheduled ON the session day, and the
 * prints published on or before it — a premarket page that listed Friday's
 * jobs report as today's event, or quoted an actual that lands at 12:30Z as if
 * it already existed, is exactly the failure this filter exists to stop. A
 * printed row with no `published_at` cannot be placed in time and so does not
 * survive a daily cut; argon's null grouping makes that row impossible, and
 * dropping it is safer than dating it by its schedule.
 *
 * Weekly keeps every row of the week. Nothing is recomputed, reordered by
 * anything but the schedule, or turned into a number.
 */
export function summariseMacroReleases(
  payload: unknown,
  opts: { asOf: string; phase?: string },
): MacroReleasesSummary {
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const weekStart = str(body.week_start) ?? "";
  const weekEnd = str(body.week_end) ?? "";
  const stated = str(body.unavailable);
  if (stated !== null || !Array.isArray(body.releases)) {
    return {
      weekStart,
      weekEnd,
      scheduled: [],
      printed: [],
      unavailable:
        stated ??
        "argon returned no `releases` array for this week; the macro calendar is unread",
    };
  }

  const rows = body.releases
    .map(releaseOf)
    .filter((row): row is MacroRelease => row !== undefined)
    .sort(
      (a, b) =>
        a.scheduled_at.localeCompare(b.scheduled_at, "en") ||
        a.event.localeCompare(b.event, "en"),
    );

  const daily = DAILY_PHASES.has(opts.phase ?? "");
  const day = dayOf(opts.asOf) ?? opts.asOf;
  const scheduled = rows.filter(
    (row) =>
      row.actual === null && (!daily || dayOf(row.scheduled_at) === day),
  );
  const printed = rows.filter((row) => {
    if (row.actual === null) return false;
    if (!daily) return true;
    const published = dayOf(row.published_at);
    return published !== null && published <= day;
  });
  return { weekStart, weekEnd, scheduled, printed };
}

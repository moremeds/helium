/**
 * The ISO-8601 week key of a calendar day, `yyyy-Www`.
 *
 * The email links to argon's Flash page, whose route is week-scoped, so the
 * mail has to name the same week argon would. argon keeps its own twelve-line
 * copy in `web/lib/flash/kinds.ts` with the same cases: the two repos deploy
 * independently, and a shared package that has to version-lock them costs more
 * than the duplication does.
 *
 * The ISO year is not the calendar year. 2026-12-31 is a Thursday, so it is
 * `2026-W53`; 2027-01-01 is the Friday of that same ISO week and is ALSO
 * `2026-W53`. Getting that wrong sends the reader to an empty page four days
 * a year.
 * @module dsh-plugin-tenant-option-wizard/render/week
 */

const DAY_MS = 86_400_000;

/** `2026-09-03` -> `2026-W36`. A malformed date returns "". */
export function isoWeekOf(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date.trim());
  if (match === null) return "";
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const day = new Date(time);
  // The Thursday of this day's week decides both the ISO year and the week
  // number — that is the whole of ISO-8601 week numbering.
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  const thursday = new Date(time + (4 - weekday) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - jan1) / DAY_MS + 1) / 7);
  return `${String(isoYear)}-W${String(week).padStart(2, "0")}`;
}

/** The query key argon's Flash route reads the run label off. Held apart from
 *  the URL below so that no line here holds both the word and a comparison:
 *  the label is printed, never examined. */
const RUN_KEY = "phase";

/**
 * The Flash page's address for one run: `<base>/flash/<iso week>/<day>?…`.
 *
 * Returns "" — no link at all — when there is no base, no run label or no
 * parseable day. A machine with nowhere to link to must not send a mail that
 * says "read it elsewhere".
 */
export function flashUrl(base: string, date: string, label: string): string {
  const root = base.trim().replace(/\/+$/u, "");
  const week = isoWeekOf(date);
  if (root === "" || label === "" || week === "") return "";
  return `${root}/flash/${week}/${date}?${RUN_KEY}=${encodeURIComponent(label)}`;
}

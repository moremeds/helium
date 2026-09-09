/**
 * Every ISO-8601 timestamp in a briefing must be a VERBATIM copy of one a tool
 * returned.
 *
 * The bug this exists for (2026-09-02 intraday): UW returned
 * `2026-09-02T12:45:00-04:00` and $48.67M; the email wrote "+$49M into 16:28
 * ET". The money was right, the clock was four hours wrong — UTC read as ET.
 * A reader who checks the number can never catch that, and no prompt reliably
 * stops it, so it is checked here instead: a timestamp that is not a substring
 * of some tool output was computed, and computing one is exactly the mistake.
 * @module dsh-plugin-tenant-option-wizard/gates/as-of-verbatim
 */
import type { Gate, GateCtx } from "@helium/core";

/** ISO-8601 with an EXPLICIT zone: `…T12:45:00-04:00` or `…T17:31:16Z`.
 *  Fractional seconds optional (UW sends six digits). A bare date carries no
 *  clock to get wrong and is not matched. */
const ISO =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

/** The field names a close-shaped price is published under anywhere in this
 *  tenant's tool outputs, as of 2026-09-09:
 *    ow_spot        -> `{"last":765.96,"prevClose":…}` (quotes[])
 *    ow_macro_rates -> `{"last":…}` per quote, `level` for a curve level
 *    ow_session_frame -> equity internals `level`, pending ledger rows
 *                        `"referenceClose":{"date":…,"value":…}`
 *    ow_uw_stock    -> `close` / `prev_close` (TradingView row, strings)
 *  A bare substring match is NOT enough: the market-tide print carries
 *  `"underlying_price":"765.96"`, an intraday quote that happens to equal the
 *  close, and letting that satisfy the check is exactly how run-9fa9f332
 *  "passed" by accident while run-7cf66c8d failed. */
const CLOSE_FIELDS =
  "close|last|level|value|prev_close|prevClose|previousClose";

/** Does `value` appear as the value of a close-shaped field in `text`?
 *  Numbers arrive both bare (`"last":765.96`) and quoted (`"close":"765.96"`),
 *  so the surrounding quotes are optional; the trailing lookahead stops
 *  `765.96` from matching inside `765.961`. */
function quotedAsClose(text: string, value: string): boolean {
  const escaped = value.replace(/[.]/gu, "\\.");
  return new RegExp(
    `"(?:${CLOSE_FIELDS})"\\s*:\\s*"?${escaped}"?(?![\\d.])`,
    "u",
  ).test(text);
}

/** Every `"referenceClose": { … }` object in `text`, with whichever of
 *  `date` / `value` it carries. Used on BOTH sides: the model's own text (what
 *  it claims) and the tool outputs (what a tool labelled). */
function referenceCloses(
  text: string,
): Array<{ date: string | undefined; value: string | undefined }> {
  return [...text.matchAll(/"referenceClose"\s*:\s*\{([^}]*)\}/gu)].map(
    (match) => {
      const body = match[1] ?? "";
      return {
        date: /"date"\s*:\s*"([^"]+)"/u.exec(body)?.[1],
        value: /"value"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/u.exec(body)?.[1],
      };
    },
  );
}

const gate: Gate = {
  id: "as-of-verbatim",
  phase: "output",
  appliesTo: [
    "regime-analyst",
    "gex-reporter",
    "risk-reviewer",
    "scenario-analyst",
  ],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    // A REFERENCE CLOSE is a price, not a timestamp, and it is the anchor every
    // Brier score is measured from: a value the model rounded or remembered
    // makes the whole forecast unfalsifiable while looking perfectly plausible.
    // Same rule as the clock, same reason — copy it, never compute it.
    //
    // The scan is over the WHOLE RUN (`ctx.toolOutputs`), matching the
    // timestamp branch below, because that is where the close actually is.
    // scenario-analyst is permitted only ow_uw_market_state and
    // ow_macro_rates; the close reaches it in the handoff text from an earlier
    // step's ow_session_frame / ow_spot. Scoping this to the step's own tools
    // (`ctx.stepToolOutputs`) failed three production runs on 2026-09-09
    // (run-7cf66c8d, SPY 765.96) on a number that WAS tool-sourced — the tool
    // just ran in a different step. `stepToolOutputs` stays on the ctx type
    // for the other gates that legitimately need step scope; this branch does
    // not read it.
    const sourcesForClose = ctx.toolOutputs ?? [];
    const labelled = sourcesForClose
      .flatMap(referenceCloses)
      .filter(
        (row): row is { date: string; value: string } =>
          row.date !== undefined && row.value !== undefined,
      );
    for (const claim of referenceCloses(textOf(input))) {
      if (claim.value === undefined) continue;
      const value = claim.value;
      if (sourcesForClose.length === 0)
        return {
          pass: false,
          reason: `referenceClose.value ${value} but this run called no tool — there was nothing to copy it from`,
        };
      if (!sourcesForClose.some((out) => quotedAsClose(out, value)))
        return {
          pass: false,
          reason:
            `referenceClose.value ${value} appears as no close/last/level field in any tool ` +
            "output from this run — quote the close a tool returned, not an intraday print",
        };
      // A value with the right digits under the wrong session date is the
      // 2026-09-09 defect: 765.96 IS the close, but it is the 09-08 close, and
      // filing it as 09-09 slides every Brier settlement one session over.
      // Only a tool that LABELLED the pair can settle this; where no tool
      // published `{date, value}` for this number (ow_spot carries a timestamp,
      // not a session date), the date is left unchecked rather than guessed.
      const forValue = labelled.filter(
        (row) => Number(row.value) === Number(value),
      );
      if (
        claim.date !== undefined &&
        forValue.length > 0 &&
        !forValue.some((row) => row.date === claim.date)
      )
        return {
          pass: false,
          reason:
            `referenceClose ${value} is dated ${claim.date}, but the tool that returned it labelled ` +
            `it ${[...new Set(forValue.map((row) => row.date))].join(", ")} — use the session date the tool gave`,
        };
    }
    const found = [...new Set(textOf(input).match(ISO) ?? [])];
    if (found.length === 0)
      return { pass: true, reason: "no explicit timestamp to check" };
    // Precision is dropped, not converted. UW sends `…T18:40:17.075Z` and prose
    // writes `…T18:40:17Z`; the clock line says `…T01:12:44Z` and prose writes
    // `…T01:12Z`. Both are the same instant in the same zone, written shorter.
    // Refusing them failed two whole runs and taught nobody anything, so the
    // fallback comparison truncates BOTH sides to the minute. The zone
    // designator survives that untouched, which is the point: a four-hour
    // timezone error — the bug this gate exists for — still cannot match.
    const atMinute = (text: string): string =>
      text.replace(/(T\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?/g, "$1");
    const sources = ctx.toolOutputs ?? [];
    if (sources.length === 0) {
      // No tool ran, yet the text carries a zoned timestamp. There was nothing
      // to copy it from, so it was written from the model's own head.
      return {
        pass: false,
        reason: `no tool output in this run, but the text carries ${String(found.length)} timestamp(s): ${found.join(", ")}`,
      };
    }
    const invented = found.filter(
      (stamp) =>
        !sources.some(
          (out) => out.includes(stamp) || atMinute(out).includes(atMinute(stamp)),
        ),
    );
    if (invented.length === 0) {
      return {
        pass: true,
        reason: `${String(found.length)} timestamp(s), each verbatim from a tool output`,
      };
    }
    return {
      pass: false,
      reason:
        `timestamp not found verbatim in any tool output: ${invented.join(", ")} — ` +
        "quote the tool's own string; never convert a timezone",
    };
  },
};

export default gate;

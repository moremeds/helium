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

const gate: Gate = {
  id: "as-of-verbatim",
  phase: "output",
  appliesTo: ["regime-analyst", "gex-reporter", "risk-reviewer"],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const found = [...new Set(textOf(input).match(ISO) ?? [])];
    if (found.length === 0)
      return { pass: true, reason: "no explicit timestamp to check" };
    // Fractional seconds are dropped, not converted. UW and TradingView send
    // `…T18:40:17.075Z`; prose says `…T18:40:17Z` and means the same instant in
    // the same zone. Refusing that taught nothing and failed a whole run, so
    // both sides are compared with the fraction removed — the zone, which is
    // what actually goes wrong, is still compared character for character.
    const unfraction = (text: string): string =>
      text.replace(/(T\d{2}:\d{2}:\d{2})\.\d+/g, "$1");
    const sources = (ctx.toolOutputs ?? []).map(unfraction);
    if (sources.length === 0) {
      // No tool ran, yet the text carries a zoned timestamp. There was nothing
      // to copy it from, so it was written from the model's own head.
      return {
        pass: false,
        reason: `no tool output in this run, but the text carries ${String(found.length)} timestamp(s): ${found.join(", ")}`,
      };
    }
    const invented = found.filter(
      (stamp) => !sources.some((out) => out.includes(unfraction(stamp))),
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

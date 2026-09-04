/**
 * A cause the regime step claims for a move must be a VERBATIM headline from
 * a tool THIS step called — or the step must say it looked and found none.
 *
 * The bug this exists for (2026-09-03 intraday): the curve rallied while
 * Governor Waller was on the wire, the regime step called no headline tool,
 * explained the rally from the curve itself, and named him nowhere. A prompt
 * now makes the step search and write a structured `cause`; this gate checks
 * that the headline it cites is a substring of the tool's own bytes. Same
 * reasoning as `as-of-verbatim`: a string that is not in any tool output was
 * written from the model's own head.
 * @module dsh-plugin-tenant-option-wizard/gates/cause-citation
 */
import type { Gate, GateCtx } from "@helium/core";
import { extractJson } from "../render/index.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "cause-citation",
  phase: "output",
  appliesTo: ["regime-analyst"],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const parsed = extractJson(textOf(input));
    const cause = parsed?.cause;
    // The rule is prompt-scoped to intraday and close; a premarket step that
    // wrote no `cause` is obeying it, not dodging it.
    if (cause === null || cause === undefined || typeof cause !== "object")
      return { pass: true, reason: "no cause claimed" };
    const row = cause as {
      located?: unknown;
      headline?: unknown;
      searched?: unknown;
      searchTerm?: unknown;
    };
    if (row.located !== true)
      return { pass: true, reason: "cause not located, honestly" };
    const headline = typeof row.headline === "string" ? row.headline : "";
    // THIS step's tool outputs, not the run's: an earlier step's headline call
    // would satisfy a run-wide check while this step never saw the feed.
    const sources = ctx.stepToolOutputs ?? [];
    if (sources.length === 0)
      return {
        pass: false,
        reason: `cause located but this step called no tool — nothing to copy "${headline}" from`,
      };
    if (headline !== "" && sources.some((out) => out.includes(headline)))
      return {
        pass: true,
        reason: "cause headline verbatim from a tool output",
      };
    const searched = [row.searchTerm, row.searched]
      .flat()
      .filter((term): term is string => typeof term === "string");
    return {
      pass: false,
      reason:
        `cause headline not found verbatim in any tool output this step: "${headline}"` +
        (searched.length === 0 ? "" : ` (searched: ${searched.join(", ")})`) +
        " — copy the row's own headline character for character",
    };
  },
};

export default gate;

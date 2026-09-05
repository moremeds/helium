/**
 * "The record for tomorrow did not get written", said in the brief.
 *
 * The runner declines to store a block that is not a JSON object, and the
 * schema declines the rest — but neither of them can TELL the reader, and a
 * missing record is invisible until the next run silently falls back to
 * markdown. An advisory refusal reaches the report through the same path
 * flash-budget's does: StepReport.gateRefusals -> the renderer's
 * degradationFrom (plugins/option-wizard/render/index.ts:344-356).
 *
 * The refusal string starts with the exact words the spec asks for,
 * `regime-state: missing`, so a reader and a grep agree.
 * @module dsh-plugin-tenant-option-wizard/gates/regime-state
 */
import type { Gate, GateCtx } from "@helium/core";
import { RegimeState, findStateBlock } from "../state/regime.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "regime-state",
  phase: "output",
  advisory: true,
  // Only the step that is asked for the record can fail to produce one.
  appliesTo: ["regime-analyst"],
  async check(
    input: unknown,
    _ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const block = findStateBlock(textOf(input));
    if (block === null)
      return { pass: false, reason: "regime-state: missing (no block)" };
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch {
      return { pass: false, reason: "regime-state: missing (not JSON)" };
    }
    const parsed = RegimeState.safeParse(value);
    if (parsed.success) return { pass: true, reason: "regime-state: written" };
    return {
      pass: false,
      reason: `regime-state: missing (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")})`,
    };
  },
};

export default gate;

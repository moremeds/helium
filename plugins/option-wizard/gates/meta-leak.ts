/**
 * The brief may not talk about itself, MEASURED.
 *
 * Advisory for the same reason `flash-budget` is: the reader is better served
 * by a brief with a leak in it than by no brief, and a refusal here is a row
 * in the audit table plus one degradation line naming the exact field,
 * pattern and excerpt. Same mechanism, same semantics, same file shape.
 * @module dsh-plugin-tenant-option-wizard/gates/meta-leak
 */
import type { Gate, GateCtx } from "@helium/core";
import { extractJson } from "../render/json.js";
import { findMetaLeaks } from "../quality/meta-leak.js";

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "meta-leak",
  phase: "output",
  advisory: true,
  // Every role that writes prose a reader sees.
  appliesTo: ["editor", "regime-analyst"],
  async check(
    input: unknown,
    _ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const parsed = extractJson(textOf(input));
    if (parsed === null) return { pass: true, reason: "no document to scan" };
    const leaks = findMetaLeaks(parsed);
    if (leaks.length === 0)
      return { pass: true, reason: "no meta words in the prose" };
    return {
      pass: false,
      reason:
        `${String(leaks.length)} meta leak${leaks.length === 1 ? "" : "s"}: ` +
        leaks
          .map((leak) => `${leak.field} /${leak.pattern}/ "${leak.excerpt}"`)
          .join("; "),
    };
  },
};

export default gate;

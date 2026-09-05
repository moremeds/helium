/**
 * The flash budget, MEASURED. The renderer (`render/index.ts` `enforceBudget`)
 * already cuts every over-budget body back to its last sentence, so this gate
 * changes nothing the reader sees. It exists so that a prompt being ignored
 * looks different from a prompt being obeyed: a refusal here is a zero-token
 * row in the audit table naming the exact counts, and one degradation line in
 * the brief. Without it, nobody ever learns the editor is over budget, or by
 * how much.
 *
 * The runner does not discard a refused output (`runner.ts`: "a refusal here
 * does NOT discard the text"), and `editorDocFrom` is told by name that this
 * gate is advisory (`advisory: true`): the renderer trims to the same budget,
 * so a refusal is recorded but does not fail the step.
 * @module dsh-plugin-tenant-option-wizard/gates/flash-budget
 */
import type { Gate, GateCtx } from "@helium/core";
import { FLASH_BUDGET, measure } from "../render/budget.js";
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
  id: "flash-budget",
  phase: "output",
  advisory: true,
  // Every role that can put a `sections` array into a brief. `drift-watcher`
  // and `recap-writer` were removed with the settlement steps on 2026-09-05;
  // a gate naming a role the manifest does not declare guards nothing.
  appliesTo: ["editor", "regime-analyst"],
  async check(
    input: unknown,
    _ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const parsed = extractJson(textOf(input));
    if (parsed === null || !Array.isArray(parsed.sections))
      return { pass: true, reason: "no sections to measure" };
    const { overages, sectionCount } = measure(parsed);
    const parts: string[] = [];
    const sections = overages.filter((o) => o.what.startsWith("section "));
    if (sections.length > 0)
      parts.push(
        `${String(sections.length)} of ${String(sectionCount ?? 0)} sections over ${String(FLASH_BUDGET.sectionBodyWords)} words (${sections.map((o) => String(o.words)).join(", ")})`,
      );
    if ((sectionCount ?? 0) > FLASH_BUDGET.sectionCount)
      parts.push(
        `${String(sectionCount)} sections of ${String(FLASH_BUDGET.sectionCount)}`,
      );
    for (const o of overages.filter((o) => !o.what.startsWith("section ")))
      parts.push(`${o.what} ${String(o.words)} of ${String(o.limit)}`);
    const single = overages.filter((o) => o.firstSentenceOver);
    if (single.length > 0)
      parts.push(
        `first sentence alone over budget, word-cut with "…": ${single.map((o) => o.what).join(", ")}`,
      );
    if (parts.length === 0)
      return {
        pass: true,
        reason: `within budget: ${String(sectionCount)} sections`,
      };
    return { pass: false, reason: parts.join("; ") };
  },
};

export default gate;

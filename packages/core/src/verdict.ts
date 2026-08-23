/**
 * Structured triage verdict parsing and the severity threshold gate (spec §4,
 * §8): the model proposes a verdict, the job's `escalateWhen` disposes.
 * @module @helium/core/verdict
 */
import { z } from "zod";
import type { Severity } from "./job.js";

export interface TriageVerdict {
  escalate: boolean;
  severity: Severity;
  reason: string;
}

const VerdictSchema = z.object({
  escalate: z.boolean(),
  severity: z.enum(["noise", "minor", "material", "critical"]),
  reason: z.string(),
});

/** Top-level {...} spans, string-aware so braces inside strings never open a span. */
function jsonSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * Parse the last well-formed verdict JSON object found in `text`.
 * @param text - the model's raw reply.
 * @returns the parsed verdict, or null when no span parses and validates.
 */
export function parseVerdict(text: string): TriageVerdict | null {
  const spans = jsonSpans(text);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(spans[i]!);
    } catch {
      continue;
    }
    const parsed = VerdictSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

const RANK: Record<Severity, number> = {
  noise: 0,
  minor: 1,
  material: 2,
  critical: 3,
};

/**
 * The job's threshold is the gate. `escalate` is the model's recommendation and is
 * recorded, but it can neither raise nor veto the decision (spec §4: agents propose,
 * a gate disposes).
 * @param v - the parsed verdict.
 * @param escalateWhen - the job's configured severity floor.
 * @returns whether this verdict's severity meets or exceeds the threshold.
 */
export function meetsThreshold(
  v: TriageVerdict,
  escalateWhen: Exclude<Severity, "noise">,
): boolean {
  return RANK[v.severity] >= RANK[escalateWhen];
}

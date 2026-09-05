/**
 * `helium scoreboard <tenant>` — what the ledger says, and nothing else.
 *
 * It aggregates `scores` BY KEY and never learns what a key means (doctrine 2):
 * `t1Brier` and `resolutionBrier` do not share a range, so it prints the
 * observed range beside each mean rather than pretending one scale.
 *
 * Read-only. It computes nothing the settler did not already decide, because a
 * number computed in two places is a number that will disagree with itself.
 * @module @helium/cli/scoreboard
 */
import type { LedgerRead } from "@helium/core";

export interface VariantSummary {
  /** Receipts in this variant, pending included. */
  n: number;
  pending: number;
  /** Mean per score key over NON-pending receipts. */
  means: Record<string, number>;
  /** Observed spread per key, and how many receipts carried it. */
  ranges: Record<string, { min: number; max: number; n: number }>;
}

export interface Scoreboard {
  byVariant: Record<string, VariantSummary>;
}

export function summarise(
  records: LedgerRead,
  opts: { deployment?: string; variant?: string } = {},
): Scoreboard {
  const byId = new Map(records.commitments.map((entry) => [entry.id, entry]));
  const byVariant: Record<string, VariantSummary> = {};
  const values = new Map<string, Map<string, number[]>>();
  for (const receipt of records.receipts) {
    const commitment = byId.get(receipt.commitmentId);
    if (commitment === undefined) continue;
    if (
      opts.deployment !== undefined &&
      opts.deployment !== "all" &&
      commitment.deployment !== opts.deployment
    )
      continue;
    if (opts.variant !== undefined && commitment.variant !== opts.variant)
      continue;
    const key = commitment.variant;
    let row = byVariant[key];
    if (row === undefined) {
      row = { n: 0, pending: 0, means: {}, ranges: {} };
      byVariant[key] = row;
    }
    row.n += 1;
    if (receipt.status === "pending") {
      row.pending += 1;
      continue;
    }
    let keys = values.get(key);
    if (keys === undefined) {
      keys = new Map();
      values.set(key, keys);
    }
    for (const [name, value] of Object.entries(receipt.scores)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const list = keys.get(name);
      if (list === undefined) keys.set(name, [value]);
      else list.push(value);
    }
  }
  for (const [key, keys] of values) {
    const row = byVariant[key]!;
    for (const [name, list] of keys) {
      row.means[name] =
        list.reduce((total, value) => total + value, 0) / list.length;
      row.ranges[name] = {
        min: Math.min(...list),
        max: Math.max(...list),
        n: list.length,
      };
    }
  }
  return { byVariant };
}

export function parseScoreboardArgs(
  argv: string[],
):
  | { tenant?: string; since?: string; deployment: string; variant?: string }
  | { error: string } {
  const out: {
    tenant?: string;
    since?: string;
    deployment: string;
    variant?: string;
  } = { deployment: "production" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (
      token === "--since" ||
      token === "--deployment" ||
      token === "--variant"
    ) {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${token} needs a value` };
      if (token === "--since") out.since = value;
      if (token === "--deployment") out.deployment = value;
      if (token === "--variant") out.variant = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `unknown option ${token}` };
    if (out.tenant === undefined) out.tenant = token;
  }
  return out;
}

export function renderScoreboard(
  board: Scoreboard,
  costByVariant: Record<string, number>,
): string[] {
  const lines: string[] = [
    "the same idea re-issued on consecutive days is several correlated samples;",
    "V0 does not de-duplicate them.",
    "",
  ];
  for (const [variant, row] of Object.entries(board.byVariant).sort()) {
    const cost = costByVariant[variant];
    lines.push(
      `${variant}: ${String(row.n)} receipts, ${String(row.pending)} pending` +
        (cost === undefined ? "" : `, ${cost.toFixed(6)} USD`),
    );
    for (const [name, mean] of Object.entries(row.means).sort()) {
      const range = row.ranges[name]!;
      lines.push(
        `  ${name}  mean ${mean.toFixed(4)}  observed ${range.min.toFixed(4)}..${range.max.toFixed(4)}  n=${String(range.n)}`,
      );
    }
    if (Object.keys(row.means).length === 0)
      lines.push("  no settled score yet");
    lines.push("");
  }
  if (Object.keys(board.byVariant).length === 0)
    lines.push(
      "no receipts match; the ledger may hold only outstanding commitments",
    );
  return lines;
}

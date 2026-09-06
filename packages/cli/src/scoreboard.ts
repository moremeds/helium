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
import type { Commitment, LedgerRead } from "@helium/core";

export interface GroupSummary {
  /** Receipts in this group, pending included. */
  n: number;
  pending: number;
  /** Mean per score key over NON-pending receipts. */
  means: Record<string, number>;
  /** Observed spread per key, and how many receipts carried it. */
  ranges: Record<string, { min: number; max: number; n: number }>;
}

export interface Scoreboard {
  /** Keyed `${variant}@${codeSha}` — see `groupKey`. */
  byGroup: Record<string, GroupSummary>;
}

/**
 * A deploy is a baseline reset: the run that issued a commitment is the only
 * thing that decides whether its score describes the current behaviour, so the
 * sha is part of the group key rather than a column beside it. A commitment
 * written before the field existed groups under `unknown` instead of silently
 * joining whatever sha happens to be current.
 */
export function groupKey(commitment: Commitment): string {
  return `${commitment.variant}@${commitment.codeSha ?? "unknown"}`;
}

export function summarise(
  records: LedgerRead,
  opts: { deployment?: string; variant?: string; codeSha?: string } = {},
): Scoreboard {
  const byId = new Map(records.commitments.map((entry) => [entry.id, entry]));
  const byGroup: Record<string, GroupSummary> = {};
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
    if (
      opts.codeSha !== undefined &&
      (commitment.codeSha ?? "unknown") !== opts.codeSha
    )
      continue;
    const key = groupKey(commitment);
    let row = byGroup[key];
    if (row === undefined) {
      row = { n: 0, pending: 0, means: {}, ranges: {} };
      byGroup[key] = row;
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
    const row = byGroup[key]!;
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
  return { byGroup };
}

export function parseScoreboardArgs(
  argv: string[],
):
  | {
      tenant?: string;
      since?: string;
      deployment: string;
      variant?: string;
      codeSha?: string;
    }
  | { error: string } {
  const out: {
    tenant?: string;
    since?: string;
    deployment: string;
    variant?: string;
    codeSha?: string;
  } = { deployment: "production" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (
      token === "--since" ||
      token === "--deployment" ||
      token === "--variant" ||
      token === "--code-sha"
    ) {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${token} needs a value` };
      if (token === "--since") out.since = value;
      if (token === "--deployment") out.deployment = value;
      if (token === "--variant") out.variant = value;
      if (token === "--code-sha") out.codeSha = value;
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
  costByGroup: Record<string, number>,
): string[] {
  const lines: string[] = [
    "the same idea re-issued on consecutive days is several correlated samples;",
    "V0 does not de-duplicate them.",
    "",
  ];
  for (const [group, row] of Object.entries(board.byGroup).sort()) {
    const cost = costByGroup[group];
    lines.push(
      `${group}: ${String(row.n)} receipts, ${String(row.pending)} pending` +
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
  if (Object.keys(board.byGroup).length === 0)
    lines.push(
      "no receipts match; the ledger may hold only outstanding commitments",
    );
  return lines;
}

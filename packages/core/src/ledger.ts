/**
 * The outcome ledger: one append-only jsonl per tenant under the state root.
 *
 * Three record kinds and no schema beyond them. Core does not read inside a
 * payload and does not know what any status other than `"pending"` means
 * (doctrine 2); it owns finding the outstanding promises and nothing else.
 *
 * jsonl rather than a table because a run that is killed mid-write must lose
 * at most its last line, and because the whole file is small enough to read
 * (doctrine 6: a database earns its keep when a `grep` stops working).
 * @module @helium/core/ledger
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Commitment, Receipt } from "./plugins.js";

export type LedgerRecord =
  | { kind: "commitment"; commitment: Commitment }
  | { kind: "receipt"; receipt: Receipt }
  | { kind: "baseline"; baseline: Commitment };

export interface LedgerRead {
  commitments: Commitment[];
  receipts: Receipt[];
  baselines: Commitment[];
}

export function ledgerPath(stateRoot: string, tenant: string): string {
  return join(stateRoot, "ledger", `${tenant}.jsonl`);
}

export function appendLedger(
  stateRoot: string,
  tenant: string,
  records: readonly LedgerRecord[],
): void {
  if (records.length === 0) return;
  const path = ledgerPath(stateRoot, tenant);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

function after(at: string, since: string | undefined): boolean {
  return since === undefined || at >= since;
}

/**
 * Every record, raw and in file order. A line that does not parse is SKIPPED,
 * not thrown on: one torn write at the tail of an append-only file must not
 * make every earlier commitment unreadable.
 */
export function readLedger(
  stateRoot: string,
  tenant: string,
  opts: { since?: string } = {},
): LedgerRead {
  const out: LedgerRead = { commitments: [], receipts: [], baselines: [] };
  const path = ledgerPath(stateRoot, tenant);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let record: LedgerRecord;
    try {
      record = JSON.parse(text) as LedgerRecord;
    } catch {
      continue;
    }
    if (record.kind === "commitment") {
      if (after(record.commitment.issuedAt, opts.since))
        out.commitments.push(record.commitment);
    } else if (record.kind === "baseline") {
      if (after(record.baseline.issuedAt, opts.since))
        out.baselines.push(record.baseline);
    } else if (record.kind === "receipt") {
      if (after(record.receipt.settledAt, opts.since))
        out.receipts.push(record.receipt);
    }
  }
  return out;
}

/**
 * The commitments a settler should be offered: no receipt at all, or a latest
 * receipt that says `pending`.
 *
 * Pass an UNFILTERED read. A `since`-filtered read can hide the receipt that
 * settled an old commitment, which would make a finished promise look open
 * forever.
 */
export function outstanding(read: {
  commitments: readonly Commitment[];
  receipts: readonly Receipt[];
}): Commitment[] {
  const latest = new Map<string, Receipt>();
  for (const receipt of read.receipts) {
    const prior = latest.get(receipt.commitmentId);
    if (prior === undefined || receipt.settledAt >= prior.settledAt)
      latest.set(receipt.commitmentId, receipt);
  }
  const seen = new Set<string>();
  const open: Commitment[] = [];
  for (const commitment of read.commitments) {
    if (seen.has(commitment.id)) continue;
    seen.add(commitment.id);
    const receipt = latest.get(commitment.id);
    if (receipt === undefined || receipt.status === "pending")
      open.push(commitment);
  }
  return open;
}

/**
 * The run ids a pruner must keep: any run that made a commitment nobody has
 * settled yet. Handed to a caller-supplied `keep(runId)` hook; this module
 * never prunes anything itself.
 */
export function runIdsWithOutstanding(
  stateRoot: string,
  tenant: string,
): Set<string> {
  return new Set(
    outstanding(readLedger(stateRoot, tenant)).map(
      (commitment) => commitment.runId,
    ),
  );
}

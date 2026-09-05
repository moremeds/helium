import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLedger,
  ledgerPath,
  outstanding,
  readLedger,
  runIdsWithOutstanding,
  type Commitment,
  type LedgerRecord,
  type Receipt,
} from "@helium/core";

function root(): string {
  return mkdtempSync(join(tmpdir(), "helium-ledger-"));
}

function commitment(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id,
    runId: `run-${id}`,
    tenant: "t",
    issuedAt: "2026-09-04T12:00:00Z",
    deployment: "production",
    variant: "live",
    payload: { k: 1 },
    ...over,
  };
}

function receipt(
  id: string,
  status: string,
  over: Partial<Receipt> = {},
): Receipt {
  return {
    commitmentId: id,
    runId: "run-settler",
    settledAt: "2026-09-05T12:00:00Z",
    status,
    scores: { b: 0.25 },
    ...over,
  };
}

describe("ledger", () => {
  it("returns empty arrays when the file does not exist", () => {
    expect(readLedger(root(), "t")).toEqual({
      commitments: [],
      receipts: [],
      baselines: [],
    });
  });

  it("round-trips the three record kinds in append order", () => {
    const dir = root();
    const records: LedgerRecord[] = [
      { kind: "commitment", commitment: commitment("a") },
      { kind: "baseline", baseline: commitment("a-base") },
      { kind: "receipt", receipt: receipt("a", "targetFirst") },
    ];
    appendLedger(dir, "t", records);
    appendLedger(dir, "t", [
      { kind: "commitment", commitment: commitment("b") },
    ]);
    const read = readLedger(dir, "t");
    expect(read.commitments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(read.baselines.map((c) => c.id)).toEqual(["a-base"]);
    expect(read.receipts.map((r) => r.status)).toEqual(["targetFirst"]);
    expect(ledgerPath(dir, "t").endsWith("/ledger/t.jsonl")).toBe(true);
  });

  it("appends nothing for an empty batch and creates no file", () => {
    const dir = root();
    appendLedger(dir, "t", []);
    expect(readLedger(dir, "t").commitments).toEqual([]);
  });

  it("skips a corrupt line rather than losing the whole file", () => {
    const dir = root();
    appendLedger(dir, "t", [
      { kind: "commitment", commitment: commitment("a") },
    ]);
    const path = ledgerPath(dir, "t");
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(
      path,
      `{ not json\n${JSON.stringify({ kind: "commitment", commitment: commitment("b") })}\n`,
      "utf8",
    );
    expect(readLedger(dir, "t").commitments.map((c) => c.id)).toEqual(["b"]);
  });

  it("`since` filters commitments by issuedAt and receipts by settledAt", () => {
    const dir = root();
    appendLedger(dir, "t", [
      {
        kind: "commitment",
        commitment: commitment("old", { issuedAt: "2026-08-01T00:00:00Z" }),
      },
      { kind: "commitment", commitment: commitment("new") },
      {
        kind: "receipt",
        receipt: receipt("old", "unresolved", {
          settledAt: "2026-08-02T00:00:00Z",
        }),
      },
      { kind: "receipt", receipt: receipt("new", "unresolved") },
    ]);
    const read = readLedger(dir, "t", { since: "2026-09-01T00:00:00Z" });
    expect(read.commitments.map((c) => c.id)).toEqual(["new"]);
    expect(read.receipts.map((r) => r.commitmentId)).toEqual(["new"]);
  });

  it("outstanding excludes settled, includes pending and never-settled", () => {
    const read = {
      commitments: [
        commitment("settled"),
        commitment("pending"),
        commitment("fresh"),
      ],
      receipts: [
        receipt("settled", "targetFirst"),
        receipt("pending", "pending"),
      ],
    };
    expect(outstanding(read).map((c) => c.id)).toEqual(["pending", "fresh"]);
  });

  it("the LATEST receipt decides: pending then settled is settled", () => {
    const read = {
      commitments: [commitment("x")],
      receipts: [
        receipt("x", "pending", { settledAt: "2026-09-05T00:00:00Z" }),
        receipt("x", "not-entered", { settledAt: "2026-09-06T00:00:00Z" }),
      ],
    };
    expect(outstanding(read)).toEqual([]);
  });

  it("a re-issued id is listed once", () => {
    const read = {
      commitments: [commitment("x"), commitment("x")],
      receipts: [],
    };
    expect(outstanding(read).map((c) => c.id)).toEqual(["x"]);
  });

  it("runIdsWithOutstanding names the runs a pruner must keep", () => {
    const dir = root();
    appendLedger(dir, "t", [
      {
        kind: "commitment",
        commitment: commitment("open", { runId: "run-keep" }),
      },
      {
        kind: "commitment",
        commitment: commitment("done", { runId: "run-drop" }),
      },
      { kind: "receipt", receipt: receipt("done", "unresolved") },
    ]);
    expect([...runIdsWithOutstanding(dir, "t")]).toEqual(["run-keep"]);
  });
});

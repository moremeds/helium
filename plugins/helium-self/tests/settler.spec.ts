/**
 * Every number below is a REAL row read from argon's Postgres on 2026-09-06:
 * `uw_scan.backtest_sweep_results`, run_id = 3 (`spx_density_calibration`).
 * The arm-H candidate run does not exist yet, so the three verdict fixtures
 * pair two real cells of that run against each other — the rule is what is
 * under test, and pairing observed cells keeps a fabricated number out of the
 * one place a fabricated number would be indistinguishable from a result.
 *
 *   id 328  origin=prospective   h=all  ratio 0.9600833121858524  mean 0.0022298653495520827
 *   id 329  origin=reconstructed h=all  ratio 1.0476453175072984  mean 0.003059214297125671
 *   id 313  origin=prospective   h=1    ratio 0.968009576469881   mean 0.0016496165339378512
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Commitment } from "@helium/core";
import { buildSettler, verdict } from "../tools/index.js";

const HOLDOUT_328 = {
  id: 328,
  run_id: 3,
  origin: "prospective",
  h: "all",
  ratio: 0.9600833121858524,
  mean: 0.0022298653495520827,
};
const RECONSTRUCTED_329 = {
  id: 329,
  run_id: 4,
  origin: "prospective",
  h: "all",
  ratio: 1.0476453175072984,
  mean: 0.003059214297125671,
};
const H1_313 = {
  id: 313,
  run_id: 4,
  origin: "prospective",
  h: "all",
  ratio: 0.968009576469881,
  mean: 0.0016496165339378512,
};

const PAYLOAD = {
  kind: "argon-sweep-compare",
  id: "2026-09-06-density-arm-h",
  baselineSweepRun: 3,
  candidateSweepRun: null,
  candidateSweepStrategy: "spx-density-calibration-arm-H",
  holdout: { origin: "prospective", rows: 80 },
  metrics: {
    q05PinballRatio: { improveIfDeltaAtMost: -0.03 },
    meanPinball: { regressIfDeltaAbove: 0.01 },
  },
};

function commitment(payload: unknown = PAYLOAD): Commitment {
  return {
    id: "2026-09-06-density-arm-h",
    runId: "run-0",
    tenant: "helium-self",
    issuedAt: "2026-09-06T00:00:00Z",
    deployment: "test",
    variant: "live",
    payload,
  };
}

/** Answers the run lookup with `runs`, then every result query with `cells`. */
function stubQuery(runs: unknown[], cells: unknown[]) {
  return vi.fn(async (sql: string) =>
    sql.includes("backtest_sweep_runs") ? runs : cells,
  );
}

const NOW = new Date("2026-09-07T00:00:00Z");

describe("helium-self settler", () => {
  it("stays pending when no candidate sweep run exists yet", async () => {
    const query = stubQuery([], []);
    const [receipt] = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      query,
    ).settle([commitment()], NOW);
    expect(receipt?.status).toBe("pending");
    expect(receipt?.scores).toEqual({});
    // Pending must not have gone looking for rows of a run that is not there.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("calls the candidate run improved when q05 drops past the threshold", async () => {
    // baseline 1.0476 -> candidate 0.9601: delta -0.0876 <= -0.03, mean falls.
    const [receipt] = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      stubQuery(
        [{ id: 4 }],
        [
          { ...RECONSTRUCTED_329, run_id: 3, id: 329 },
          { ...HOLDOUT_328, run_id: 4, id: 328 },
        ],
      ),
    ).settle([commitment()], NOW);
    expect(receipt?.status).toBe("improved");
    expect(receipt?.scores.deltaQ05PinballRatio).toBeCloseTo(-0.087562, 6);
    expect(receipt?.detail).toEqual({
      baselineRun: 3,
      candidateRun: 4,
      rowIds: [329, 328],
    });
    expect(receipt?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls it flat inside the band", async () => {
    // 0.96008 -> 0.96801: delta +0.0079, inside +-0.03; mean falls.
    const [receipt] = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      stubQuery([{ id: 4 }], [HOLDOUT_328, H1_313]),
    ).settle([commitment()], NOW);
    expect(receipt?.status).toBe("flat");
    expect(receipt?.scores.deltaQ05PinballRatio).toBeCloseTo(0.007926, 6);
  });

  it("calls it regressed when q05 rises past the band", async () => {
    // 0.96008 -> 1.04765: delta +0.0876 > 0.03.
    const [receipt] = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      stubQuery([{ id: 4 }], [HOLDOUT_328, RECONSTRUCTED_329]),
    ).settle([commitment()], NOW);
    expect(receipt?.status).toBe("regressed");
    expect(receipt?.scores.baselineQ05PinballRatio).toBe(HOLDOUT_328.ratio);
    expect(receipt?.scores.candidateQ05PinballRatio).toBe(
      RECONSTRUCTED_329.ratio,
    );
  });

  it("hashes the exact rows, so a repaired row changes the receipt", async () => {
    const settle = async (cells: unknown[]) =>
      (
        await buildSettler(
          { stateRoot: "/state", env: {}, variant: "live" },
          stubQuery([{ id: 4 }], cells),
        ).settle([commitment()], NOW)
      )[0]?.evidenceHash;
    const before = await settle([HOLDOUT_328, RECONSTRUCTED_329]);
    const after = await settle([
      HOLDOUT_328,
      { ...RECONSTRUCTED_329, ratio: RECONSTRUCTED_329.ratio + 1e-9 },
    ]);
    expect(before).not.toBe(after);
  });

  it("leaves a commitment of another kind alone", async () => {
    const receipts = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      stubQuery([{ id: 4 }], []),
    ).settle([commitment({ kind: "spy-direction" })], NOW);
    expect(receipts).toEqual([]);
  });

  it("stays pending, with a reason, when the payload cannot be read", async () => {
    const [receipt] = await buildSettler(
      { stateRoot: "/state", env: {}, variant: "live" },
      stubQuery([{ id: 4 }], []),
    ).settle([commitment({ ...PAYLOAD, baselineSweepRun: "three" })], NOW);
    expect(receipt?.status).toBe("pending");
    expect(receipt?.detail).toMatchObject({
      reason: expect.stringContaining("baselineSweepRun"),
    });
  });

  it("reads the band from the payload, not from a constant", () => {
    expect(verdict(-0.02, 0, { improveIfDeltaAtMost: -0.03, regressIfDeltaAbove: 0.01 })).toBe("flat");
    expect(verdict(-0.02, 0, { improveIfDeltaAtMost: -0.01, regressIfDeltaAbove: 0.01 })).toBe("improved");
    expect(verdict(0, 0.02, { improveIfDeltaAtMost: -0.03, regressIfDeltaAbove: 0.01 })).toBe("regressed");
  });
});

/**
 * The coverage-call branch, settled from files only.
 *
 * Every level below is a REAL observation, read out of the W37-run-day sample
 * `docs/evidence/flash-depth/2026-09-08/final/payload.json` (option-wizard
 * weekly, run_day 2026-09-07, week_key 2026-W37, run_id
 * run-90bf475f-6686-4219-8f29-903dc9a2b5d5, code_sha 3e48937): DGS2 4.375 and
 * DGS10 4.788 as of 2026-09-04, 2s10s 41.3bp, BAMLH0A0HYM2 2.65 as of
 * 2026-09-03, VIX 14.52, SPY 770.19 close, Memory/Storage +7.5% vs SPY on the
 * week. That sample printed 22 coverage rows and marked all 22 UNTESTED, which
 * is the 0-call baseline this commitment is set against; the fixtures below
 * move only the CALL COUNT, because the count is the whole rule.
 */
const REVIEW_BODY =
  "The week to 2026-09-04 was a rotation story more than an index story. " +
  "SPY returned just +0.1% on the week, and the cross-asset frame stayed calm: " +
  "VIX at 14.52, high-yield spreads (BAMLH0A0HYM2) tight at 2.65 as of " +
  "2026-09-03, the 10-year (DGS10) at 4.788 and 2s10s at 41.3bp.";

/** Six real rows of that table, in the order the renderer printed them. */
const CALLED_ROWS = [
  { id: "rates.front", level: 4.375, unit: "bp" },
  { id: "rates.long", level: 4.788, unit: "bp" },
  { id: "credit", level: 2.65, unit: "bp" },
  { id: "vol", level: 14.52, unit: "pts" },
  { id: "equity.internals", level: 770.19, unit: "pts" },
  { id: "sector:Memory/Storage", level: 7.6, unit: "%" },
];

/** A placeholder id: the 2026-09-13 run does not exist yet, and borrowing a
 *  real run id from another day would claim more than the fixture knows. */
const TARGET_RUN = "run-1f0d5c2a-9b41-4e73-8f2c-6d0a2b7e5c91";

const COVERAGE_PAYLOAD = {
  kind: "option-wizard-coverage",
  target: {
    tenant: "option-wizard",
    phase: "weekly",
    deployment: "production",
  },
  window: { startsAt: "2026-09-13T00:00:00Z" },
  metrics: {
    calls: { improveIfAtLeast: 6, regressIfAtMost: 0 },
    review: { requireNonEmpty: true },
  },
  reviewSectionTitles: ["2 · 上周复盘", "Market review"],
};

function coverageCommitment(payload: unknown = COVERAGE_PAYLOAD): Commitment {
  return {
    id: "2026-09-08-weekly-coverage-calls",
    runId: "run-mint",
    tenant: "helium-self",
    issuedAt: "2026-09-08T00:00:00Z",
    deployment: "production",
    variant: "live",
    payload,
  };
}

/**
 * A state root holding one weekly evidence file and one option-wizard ledger:
 * `calls` real rows minted as `coverage-verdict`, plus the SPY pair every run
 * mints, which must not be counted as coverage calls.
 */
function stateWith(opts: {
  calls: number;
  review?: string;
  startedAt?: string;
  day?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "helium-self-"));
  const day = opts.day ?? "2026-09-13";
  const startedAt = opts.startedAt ?? "2026-09-13T12:00:04Z";
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(
    join(root, "evidence", `option-wizard-${day}-weekly-${TARGET_RUN}.json`),
    JSON.stringify({
      run: {
        runId: TARGET_RUN,
        tenant: "option-wizard",
        day,
        phase: "weekly",
        deployment: "production",
        variant: "live",
        startedAt,
      },
      steps: [],
      view: {
        date: day,
        sections: [
          { title: "Market review", body: opts.review ?? REVIEW_BODY },
          { title: "Outlook", body: "…" },
          { title: "Supporting coverage", body: "…" },
        ],
      },
    }),
    "utf8",
  );
  mkdirSync(join(root, "ledger"), { recursive: true });
  const context = {
    runId: TARGET_RUN,
    tenant: "option-wizard",
    issuedAt: `${day}T12:06:00Z`,
    deployment: "production",
    variant: "live",
  };
  const lines = CALLED_ROWS.slice(0, opts.calls).map((row) =>
    JSON.stringify({
      kind: "commitment",
      commitment: {
        ...context,
        id: `${day}-weekly-verdict-${row.id}`,
        payload: {
          kind: "coverage-verdict",
          evaluator: "verdict-v0",
          rowId: row.id,
          unit: row.unit,
          token: "up",
          p: 0.6,
          observed: { level: row.level, asOf: "2026-09-04" },
          settleAfterOpenDays: 5,
        },
      },
    }),
  );
  lines.push(
    JSON.stringify({
      kind: "commitment",
      commitment: {
        ...context,
        id: `${day}-weekly-spy-t5`,
        payload: {
          kind: "spy-direction",
          evaluator: "evaluator-v0",
          horizonBars: 5,
          symbol: "SPY",
          referenceClose: 770.19,
          pDown: 0.5,
        },
      },
    }),
  );
  writeFileSync(join(root, "ledger", "option-wizard.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return root;
}

async function settleCoverageIn(stateRoot: string, payload?: unknown) {
  const [receipt] = await buildSettler(
    { stateRoot, env: {}, variant: "live" },
    stubQuery([], []),
  ).settle([coverageCommitment(payload)], new Date("2026-09-20T12:00:00Z"));
  return receipt;
}

describe("helium-self coverage-call settler", () => {
  it("stays pending until a weekly run inside the window exists", async () => {
    // A production weekly from the week BEFORE the window is on disk and is
    // still not the run this commitment named.
    const receipt = await settleCoverageIn(
      stateWith({ calls: 6, day: "2026-09-06", startedAt: "2026-09-06T12:00:07Z" }),
    );
    expect(receipt?.status).toBe("pending");
    expect(receipt?.scores).toEqual({});
    expect(receipt?.detail).toMatchObject({
      reason: expect.stringContaining("2026-09-13T00:00:00Z"),
    });
  });

  it("calls it improved at six calls with the 复盘 written", async () => {
    const receipt = await settleCoverageIn(stateWith({ calls: 6 }));
    expect(receipt?.status).toBe("improved");
    expect(receipt?.scores.calls).toBe(6);
    expect(receipt?.detail).toMatchObject({
      runId: TARGET_RUN,
      reviewSection: "Market review",
    });
    expect(receipt?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls it regressed when the table carries no call at all", async () => {
    // The 2026-09-08 baseline: 22 rows, 22 UNTESTED, nothing minted.
    const receipt = await settleCoverageIn(stateWith({ calls: 0 }));
    expect(receipt?.status).toBe("regressed");
    expect(receipt?.scores.calls).toBe(0);
  });

  it("calls it flat below the bar, and flat again when the 复盘 is blank", async () => {
    expect((await settleCoverageIn(stateWith({ calls: 3 })))?.status).toBe("flat");
    const empty = await settleCoverageIn(stateWith({ calls: 6, review: "  " }));
    expect(empty?.status).toBe("flat");
    expect(empty?.scores.reviewChars).toBe(0);
  });

  it("counts only coverage-verdict rows of that run", async () => {
    const receipt = await settleCoverageIn(stateWith({ calls: 2 }));
    expect(receipt?.detail).toMatchObject({
      callIds: [
        "2026-09-13-weekly-verdict-rates.front",
        "2026-09-13-weekly-verdict-rates.long",
      ],
    });
  });

  it("reads the bar from the payload, not from a constant", async () => {
    const receipt = await settleCoverageIn(stateWith({ calls: 3 }), {
      ...COVERAGE_PAYLOAD,
      metrics: {
        calls: { improveIfAtLeast: 3, regressIfAtMost: 0 },
        review: { requireNonEmpty: true },
      },
    });
    expect(receipt?.status).toBe("improved");
  });

  it("stays pending, with a reason, when the payload cannot be read", async () => {
    const receipt = await settleCoverageIn(stateWith({ calls: 6 }), {
      ...COVERAGE_PAYLOAD,
      reviewSectionTitles: [],
    });
    expect(receipt?.status).toBe("pending");
    expect(receipt?.detail).toMatchObject({
      reason: expect.stringContaining("reviewSectionTitles"),
    });
  });
});

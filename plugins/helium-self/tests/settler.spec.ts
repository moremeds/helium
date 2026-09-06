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

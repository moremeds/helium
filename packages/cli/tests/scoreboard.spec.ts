import { describe, expect, it } from "vitest";
import type { Commitment, LedgerRead, Receipt } from "@helium/core";
import {
  parseScoreboardArgs,
  renderScoreboard,
  summarise,
} from "../src/scoreboard.js";

function c(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id,
    runId: `run-${id}`,
    tenant: "t",
    issuedAt: "2026-09-04T00:00:00Z",
    deployment: "production",
    variant: "live",
    payload: {},
    ...over,
  };
}
function r(
  id: string,
  status: string,
  scores: Record<string, number>,
): Receipt {
  return {
    commitmentId: id,
    runId: "run-s",
    settledAt: "2026-09-05T00:00:00Z",
    status,
    scores,
  };
}
const empty: LedgerRead = { commitments: [], receipts: [], baselines: [] };

describe("summarise", () => {
  it("means each scores key over non-pending receipts only", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b"), c("p")],
      receipts: [
        r("a", "down", { t1Brier: 0.04 }),
        r("b", "up", { t1Brier: 0.36 }),
        r("p", "pending", {}),
      ],
    });
    expect(board.byVariant.live!.n).toBe(3);
    expect(board.byVariant.live!.pending).toBe(1);
    expect(board.byVariant.live!.means.t1Brier).toBeCloseTo(0.2, 10);
    expect(board.byVariant.live!.ranges.t1Brier).toEqual({
      min: 0.04,
      max: 0.36,
      n: 2,
    });
  });

  it("groups by the commitment's variant, not the receipt's run", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b", { variant: "replay" })],
      receipts: [
        r("a", "down", { t1Brier: 0 }),
        r("b", "down", { t1Brier: 1 }),
      ],
    });
    expect(Object.keys(board.byVariant).sort()).toEqual(["live", "replay"]);
  });

  it("a test-deployment run never appears when production is asked for", () => {
    const board = summarise(
      {
        ...empty,
        commitments: [c("a"), c("t", { deployment: "test" })],
        receipts: [
          r("a", "down", { t1Brier: 0 }),
          r("t", "down", { t1Brier: 1 }),
        ],
      },
      { deployment: "production" },
    );
    expect(board.byVariant.live!.n).toBe(1);
    expect(board.byVariant.live!.means.t1Brier).toBe(0);
  });

  it("ignores a receipt whose commitment is not in the read", () => {
    expect(
      summarise({ ...empty, receipts: [r("ghost", "down", { x: 1 })] }),
    ).toEqual({ byVariant: {} });
  });

  it("ignores a non-finite score rather than poisoning the mean", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b")],
      receipts: [
        r("a", "down", { t1Brier: 0.25 }),
        r("b", "down", { t1Brier: Number.NaN }),
      ],
    });
    expect(board.byVariant.live!.means.t1Brier).toBe(0.25);
  });

  it("defaults the CLI to production and rejects an unknown flag", () => {
    expect(parseScoreboardArgs(["option-wizard"])).toEqual({
      tenant: "option-wizard",
      deployment: "production",
    });
    expect(
      parseScoreboardArgs([
        "option-wizard",
        "--deployment",
        "all",
        "--variant",
        "replay",
        "--since",
        "2026-09-01",
      ]),
    ).toEqual({
      tenant: "option-wizard",
      deployment: "all",
      variant: "replay",
      since: "2026-09-01",
    });
    expect(parseScoreboardArgs(["option-wizard", "--nope"])).toEqual({
      error: "unknown option --nope",
    });
  });

  it("renders one block per variant with the cost joined on", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a")],
      receipts: [r("a", "down", { t1Brier: 0.04 })],
    });
    const lines = renderScoreboard(board, { live: 0.42 });
    expect(lines.join("\n")).toContain("live");
    expect(lines.join("\n")).toContain("t1Brier");
    expect(lines.join("\n")).toContain("0.420000");
  });
});

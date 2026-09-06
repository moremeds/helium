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
    codeSha: "abc1234",
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
    expect(board.byGroup["live@abc1234"]!.n).toBe(3);
    expect(board.byGroup["live@abc1234"]!.pending).toBe(1);
    expect(board.byGroup["live@abc1234"]!.means.t1Brier).toBeCloseTo(0.2, 10);
    expect(board.byGroup["live@abc1234"]!.ranges.t1Brier).toEqual({
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
    expect(Object.keys(board.byGroup).sort()).toEqual([
      "live@abc1234",
      "replay@abc1234",
    ]);
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
    expect(board.byGroup["live@abc1234"]!.n).toBe(1);
    expect(board.byGroup["live@abc1234"]!.means.t1Brier).toBe(0);
  });

  it("ignores a receipt whose commitment is not in the read", () => {
    expect(
      summarise({ ...empty, receipts: [r("ghost", "down", { x: 1 })] }),
    ).toEqual({ byGroup: {} });
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
    expect(board.byGroup["live@abc1234"]!.means.t1Brier).toBe(0.25);
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

  it("renders one block per group with the cost joined on", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a")],
      receipts: [r("a", "down", { t1Brier: 0.04 })],
    });
    const lines = renderScoreboard(board, { "live@abc1234": 0.42 });
    expect(lines.join("\n")).toContain("live@abc1234");
    expect(lines.join("\n")).toContain("t1Brier");
    expect(lines.join("\n")).toContain("0.420000");
  });
  it("a commitment issued by a different sha is a separate group", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b", { codeSha: "def5678" })],
      receipts: [
        r("a", "down", { t1Brier: 0 }),
        r("b", "down", { t1Brier: 1 }),
      ],
    });
    expect(Object.keys(board.byGroup).sort()).toEqual([
      "live@abc1234",
      "live@def5678",
    ]);
    expect(board.byGroup["live@abc1234"]!.means.t1Brier).toBe(0);
    expect(board.byGroup["live@def5678"]!.means.t1Brier).toBe(1);
  });

  it("a record written before codeSha existed groups under unknown", () => {
    const legacy = c("old");
    delete legacy.codeSha;
    const board = summarise({
      ...empty,
      commitments: [legacy],
      receipts: [r("old", "down", { t1Brier: 0.5 })],
    });
    expect(Object.keys(board.byGroup)).toEqual(["live@unknown"]);
    expect(board.byGroup["live@unknown"]!.means.t1Brier).toBe(0.5);
  });

  it("--code-sha keeps one sha, and `unknown` selects the unstamped rows", () => {
    const legacy = c("old");
    delete legacy.codeSha;
    const read = {
      ...empty,
      commitments: [c("a"), c("b", { codeSha: "def5678" }), legacy],
      receipts: [
        r("a", "down", { t1Brier: 0 }),
        r("b", "down", { t1Brier: 1 }),
        r("old", "down", { t1Brier: 0.5 }),
      ],
    };
    expect(
      Object.keys(summarise(read, { codeSha: "def5678" }).byGroup),
    ).toEqual(["live@def5678"]);
    expect(Object.keys(summarise(read, { codeSha: "unknown" }).byGroup)).toEqual(
      ["live@unknown"],
    );
  });

  it("parses --code-sha", () => {
    expect(
      parseScoreboardArgs(["option-wizard", "--code-sha", "abc1234"]),
    ).toEqual({
      tenant: "option-wizard",
      deployment: "production",
      codeSha: "abc1234",
    });
    expect(parseScoreboardArgs(["option-wizard", "--code-sha"])).toEqual({
      error: "--code-sha needs a value",
    });
  });
});

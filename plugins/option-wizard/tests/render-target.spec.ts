import { describe, expect, it } from "vitest";
import {
  BRIEF_VIEW_SCHEMA_VERSION,
  candidatesFrom,
  DEFAULT_DEADLINE_BARS,
} from "../render/index.js";

const legs = [
  { action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 },
  { action: "sell", right: "put", strike: 745, expiry: "2026-10-02", mid: 4.2 },
];

function review(proposal: Record<string, unknown>): string {
  return (
    "```json\n" +
    JSON.stringify({
      proposals: [
        {
          ticker: "SPY",
          strategy: "put debit spread",
          legs,
          invalidation: [{ level: 778, side: "above" }],
          ...proposal,
        },
      ],
    }) +
    "\n```"
  );
}

describe("typed target and deadlines", () => {
  it("bumps the schema version, because target changed meaning", () => {
    expect(BRIEF_VIEW_SCHEMA_VERSION).toBe(3);
  });

  it("keeps a level+side target as a number and leaves thesis empty", () => {
    const { candidates } = candidatesFrom(
      review({ target: { level: 748, side: "below" } }),
      "2026-09-04",
      "premarket",
    );
    expect(candidates[0]!.target).toEqual({ level: 748, side: "below" });
    expect(candidates[0]!.thesis).toBe("");
  });

  it("a prose target becomes the thesis and leaves target unset", () => {
    const { candidates } = candidatesFrom(
      review({ target: "SPY grinds down toward 748 on a soft ISM" }),
      "2026-09-04",
      "premarket",
    );
    expect(candidates[0]!.target).toBeUndefined();
    expect(candidates[0]!.thesis).toBe("SPY grinds down toward 748 on a soft ISM");
  });

  it("carries both when the model writes a typed target AND a thesis", () => {
    const { candidates } = candidatesFrom(
      review({ target: { level: 748, side: "below" }, thesis: "soft ISM" }),
      "2026-09-04",
      "premarket",
    );
    expect(candidates[0]!.target).toEqual({ level: 748, side: "below" });
    expect(candidates[0]!.thesis).toBe("soft ISM");
  });

  it("defaults the entry deadline to five 1d bars", () => {
    const { candidates } = candidatesFrom(
      review({ entry: { level: 766, side: "below" } }),
      "2026-09-04",
      "premarket",
    );
    expect(DEFAULT_DEADLINE_BARS).toBe(5);
    expect(candidates[0]!.entry).toEqual({
      level: 766,
      side: "below",
      deadlineBars: 5,
    });
  });

  it("honours a shortened deadline and ignores an extension", () => {
    const short = candidatesFrom(
      review({ entry: { level: 766, side: "below", deadlineBars: 2 } }),
      "2026-09-04",
      "premarket",
    );
    expect(short.candidates[0]!.entry!.deadlineBars).toBe(2);
    const long = candidatesFrom(
      review({ entry: { level: 766, side: "below", deadlineBars: 40 } }),
      "2026-09-04",
      "premarket",
    );
    expect(long.candidates[0]!.entry!.deadlineBars).toBe(5);
    const junk = candidatesFrom(
      review({ entry: { level: 766, side: "below", deadlineBars: 0 } }),
      "2026-09-04",
      "premarket",
    );
    expect(junk.candidates[0]!.entry!.deadlineBars).toBe(5);
  });

  it("resolutionDeadline is the expiry, the one date the contract fixes", () => {
    const { candidates } = candidatesFrom(review({}), "2026-09-04", "premarket");
    expect(candidates[0]!.resolutionDeadline).toBe("2026-10-02");
  });

  it("still drops a proposal whose invalidation is prose", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        proposals: [
          { ticker: "SPY", strategy: "s", legs, invalidation: "if it breaks up" },
        ],
      }) +
      "\n```";
    const { candidates, rejected } = candidatesFrom(
      text,
      "2026-09-04",
      "premarket",
    );
    expect(candidates).toEqual([]);
    expect(rejected[0]!.reason).toContain("settleable level");
  });
});

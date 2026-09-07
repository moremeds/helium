/**
 * Tomorrow's three checks, and yesterday's three scored.
 *
 * The record they ride in is the EXISTING `regime-state` fence — one extra
 * `checks` key and one `invalidation` key. No second state file, no plural
 * `stateBlocks`, no core edit, and no filesystem write in the renderer.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RegimeState, parseRegimeState } from "../state/regime.js";
import { checksLine, priorRecord, scoreChecks } from "../state/checks.js";
import type { Channel } from "../quality/channels.js";

const BASE = {
  cause: "the front end came in ahead of payrolls",
  tide: "up" as const,
  thesis: "call-heavy tape into a coin-flip-plus hike",
};

const CHECKS = [
  { series: "VIXCLS", level: "15.2", text: "VIX holds under 16" },
  { series: "DGS10", level: "4.79", text: "10Y holds 4.77" },
  { series: "BAMLH0A0HYM2", level: "2.66", text: "HY OAS stays inside 2.70" },
];

describe("the regime-state record carries the checks", () => {
  it("still parses a record written before this key existed", () => {
    expect(parseRegimeState(BASE)).not.toBeNull();
  });

  it("takes exactly three checks — not two, not four", () => {
    expect(parseRegimeState({ ...BASE, checks: CHECKS })).not.toBeNull();
    expect(parseRegimeState({ ...BASE, checks: CHECKS.slice(0, 2) })).toBeNull();
    expect(
      parseRegimeState({ ...BASE, checks: [...CHECKS, CHECKS[0]] }),
    ).toBeNull();
  });

  it("refuses a numeric level — a retyped number is the one worth refusing", () => {
    expect(
      parseRegimeState({
        ...BASE,
        checks: [{ ...CHECKS[0], level: 15.2 }, CHECKS[1], CHECKS[2]],
      }),
    ).toBeNull();
  });

  it("round-trips the standing invalidation", () => {
    const parsed = parseRegimeState({
      ...BASE,
      checks: CHECKS,
      invalidation: {
        series: "BAMLH0A0HYM2",
        threshold: ">2.80",
        horizon: "5 sessions",
      },
    });
    expect(parsed?.invalidation?.threshold).toBe(">2.80");
    expect(RegimeState.safeParse(parsed).success).toBe(true);
  });
});

describe("priorRecord", () => {
  function root(records: Array<[string, string]>): string {
    const dir = mkdtempSync(join(tmpdir(), "ow-checks-"));
    for (const [day, label] of records) {
      const at = join(dir, "option-wizard", day);
      mkdirSync(at, { recursive: true });
      writeFileSync(
        join(at, `${label}.regime.json`),
        JSON.stringify({ ...BASE, checks: CHECKS }, null, 2),
        "utf8",
      );
    }
    return dir;
  }

  it("returns the newest record strictly before this run", () => {
    const stateRoot = root([
      ["2026-09-03", "close"],
      ["2026-09-04", "premarket"],
    ]);
    const found = priorRecord({
      stateRoot,
      day: "2026-09-04",
      label: "premarket",
    })!;
    expect(found.day).toBe("2026-09-03");
    expect(found.label).toBe("close");
    expect(found.state.checks).toHaveLength(3);
  });

  it("returns null when there is nothing before it", () => {
    const stateRoot = root([["2026-09-03", "close"]]);
    expect(
      priorRecord({ stateRoot, day: "2026-09-03", label: "premarket" }),
    ).toBeNull();
  });

  it("reaches back over a weekend and a declared closed day", () => {
    // 2026-09-05 is a Friday; 09-07 is Labor Day, declared closed in
    // tenant.yaml. Neither the weekend nor the holiday has a record, so
    // Tuesday's premarket reaches Friday's close without a calendar walk.
    const stateRoot = root([["2026-09-04", "close"]]);
    const found = priorRecord({
      stateRoot,
      day: "2026-09-08",
      label: "premarket",
    })!;
    expect(found.day).toBe("2026-09-04");
    expect(found.label).toBe("close");
  });

  it("orders two records inside one day by the day's own label order", () => {
    const stateRoot = root([
      ["2026-09-04", "premarket"],
      ["2026-09-04", "intraday"],
    ]);
    const found = priorRecord({
      stateRoot,
      day: "2026-09-04",
      label: "close",
    })!;
    expect(found.label).toBe("intraday");
  });

  it("returns null for a state root that is not there", () => {
    expect(
      priorRecord({
        stateRoot: join(tmpdir(), "ow-checks-absent"),
        day: "2026-09-04",
        label: "premarket",
      }),
    ).toBeNull();
  });
});

describe("scoreChecks", () => {
  const channels: Channel[] = [
    { id: "vol", order: 5, series: "VIXCLS", level: "14.32" },
    { id: "rates", order: 1, series: "DGS10", level: "4.79" },
  ];

  it("scores three verdicts, in the stored order", () => {
    const scored = scoreChecks(CHECKS, channels);
    expect(scored.map((s) => s.series)).toEqual([
      "VIXCLS",
      "DGS10",
      "BAMLH0A0HYM2",
    ]);
    expect(scored[0]!.verdict).toBe("hit");
    expect(scored[0]!.today).toBe("14.32");
    expect(scored[1]!.verdict).toBe("miss");
    // No channel carries HY OAS in this run at all.
    expect(scored[2]!.verdict).toBe("not-observed");
    expect(scored[2]!.today).toBeUndefined();
  });
});

describe("checksLine", () => {
  it("counts the verdicts in one sentence", () => {
    expect(
      checksLine([
        { series: "a", level: "1", text: "", verdict: "hit" },
        { series: "b", level: "1", text: "", verdict: "hit" },
        { series: "c", level: "1", text: "", verdict: "miss" },
      ]),
    ).toBe("Yesterday: 2 hit, 1 missed.");
  });

  it("says so when nothing was observed", () => {
    expect(
      checksLine([
        { series: "a", level: "1", text: "", verdict: "not-observed" },
        { series: "b", level: "1", text: "", verdict: "not-observed" },
        { series: "c", level: "1", text: "", verdict: "not-observed" },
      ]),
    ).toBe("Yesterday: 3 not observed.");
  });

  it("says so when there was no prior record at all", () => {
    expect(checksLine([])).toBe("Yesterday: no checks were written.");
  });
});

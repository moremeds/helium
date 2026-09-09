/**
 * Coverage never shrinks. The row list is `extensions.review.coverage` +
 * `sectors` + `themes`, in declared order, and a row with no datum prints
 * `untested` rather than disappearing — that is the mechanism that makes
 * "terse, never dropped" enforceable.
 *
 * Every length here is computed from the same declaration the renderer reads.
 * A constant would make adding a theme a test edit, which is exactly the
 * coupling `extensions:` exists to avoid.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import { coverageRows } from "../quality/channels.js";
import { parseReviewConfig } from "../quality/review-config.js";

const FIX = join(__dirname, "fixtures", "review");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const TENANT = join(__dirname, "..", "tenant.yaml");
const config = parseReviewConfig(
  parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT).extensions,
);
const declared = {
  coverage: config.coverage,
  sectors: config.sectors,
  themes: config.themes,
};
const expectedLength =
  declared.coverage.length + declared.sectors.length + declared.themes.length;

const macro = load("macro-2026-09-03-close.json");
const policy = load("policy-2026-09-03-close.json");
const gex = load("gex-2026-09-03-close.json");
const tide = load("tide-2026-09-03-close.json");
const spot = load("spot-2026-09-03-close-report.json");

const DAY = "2026-09-03";

describe("coverageRows over the shipped declaration", () => {
  const rows = coverageRows(
    { macro, policy, gex, tide, spot, day: DAY, openCalls: 4 },
    declared,
  );

  // A ROW A READER CAN SUBTRACT. The fx row printed `118.7 → +0.4 index pts`
  // beside a prior of `118.4`, because the move differenced the RAW observations
  // (118.7479 - 118.3583) while the level and prior print to one decimal. The
  // move is now taken between the two numbers the row shows.
  it("differences the fx row between the values it prints", () => {
    // No DXY quote, so the row falls to the Fed broad index — the path the
    // 2026-09-06 weekly took.
    const fx = coverageRows(
      { macro, policy, gex, tide, day: DAY, openCalls: 4 },
      declared,
    ).find((row) => row.id === "fx");
    expect(fx?.level).toBe("118.7");
    expect(fx?.prior).toBe("118.4");
    expect(fx?.move).toBe("+0.3 index pts");
  });

  it("prints every declared row, in declared order", () => {
    expect(rows).toHaveLength(expectedLength);
    expect(rows.map((r) => r.id)).toEqual([
      ...declared.coverage,
      ...declared.sectors.map((s) => `sector:${s}`),
      ...declared.themes.map((t) => `theme:${t.id}`),
    ]);
    expect(rows[0]!.id).toBe("rates.front");
    expect(rows[declared.coverage.length - 1]!.id).toBe("calls.open");
    expect(rows.at(-1)!.id).toBe("theme:el-nino-ag-2026");
    expect(rows.map((r) => r.order)).toEqual(rows.map((_, i) => i));
  });

  it("copies the spot strings for equity.internals rather than recomputing them", () => {
    const row = rows.find((r) => r.id === "equity.internals")!;
    expect(row.level).toBe("773.17");
    expect(row.move).toContain("+8.01");
    expect(row.untested).toBeUndefined();
  });

  it("counts open commitments for calls.open and names no ticker", () => {
    // The /flash page is public. The COUNT is the datum; a ticker here would
    // be a published-candidate name on a page that must never carry one.
    const row = rows.find((r) => r.id === "calls.open")!;
    expect(row.level).toBe("4");
    expect(row.series).toBe("open commitments");
    expect(JSON.stringify(row)).not.toMatch(/\b(SPY|QQQ|IWM|NVDA|SLV)\b/u);
  });

  it("prints the front end and the curve as untested, naming the series argon does not ingest", () => {
    expect(rows.find((r) => r.id === "rates.front")!.untested).toContain(
      "DGS2",
    );
    expect(rows.find((r) => r.id === "curve.shape")!.untested).toContain(
      "DGS2",
    );
  });

  it("prints a chain argon's rail does not serve as untested, not as absent", () => {
    const withRail = coverageRows(
      {
        macro,
        day: DAY,
        // The rail carries Computer/GPU and nothing else, so the other nine
        // declared chains are unknown to it.
        watchlist: {
          chains: [{ chain: "Computer/GPU", members: ["NVDA", "AMD"] }],
          unknown: [],
        },
      },
      declared,
    );
    expect(withRail).toHaveLength(expectedLength);
    expect(
      withRail.find((r) => r.id === "sector:Cybersecurity")!.untested,
    ).toContain("chain unknown");
  });

  it("keeps a theme row in its position when the basket cannot be computed", () => {
    const row = rows.at(-1)!;
    expect(row.id).toBe("theme:el-nino-ag-2026");
    expect(row.untested).toBeTruthy();
    expect(row.theme?.kill.armed).toContain("ONI");
  });
});

describe("coverageRows with nothing to read", () => {
  it("still prints every row, all untested", () => {
    const rows = coverageRows({ day: DAY }, declared);
    expect(rows).toHaveLength(expectedLength);
    expect(rows.filter((r) => r.untested === undefined)).toEqual([]);
  });

  it("follows the declaration when the register is empty", () => {
    const rows = coverageRows({ day: DAY }, { ...declared, themes: [] });
    expect(rows).toHaveLength(
      declared.coverage.length + declared.sectors.length,
    );
    expect(rows.map((r) => r.id).filter((id) => id.startsWith("theme:"))).toEqual(
      [],
    );
  });
});

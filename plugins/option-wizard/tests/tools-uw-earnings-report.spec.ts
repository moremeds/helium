import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

interface Fixture {
  earnings: { data: Array<Record<string, unknown>> };
  incomeStatements: { data: Array<Record<string, unknown>> };
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "review", "uw-avgo-earnings-report-live.json"),
    "utf8",
  ),
) as Fixture;

function tool() {
  const found = buildTools({
    stateRoot: "/nonexistent",
    env: { OW_UW_API_KEY: "k" },
    asOf: new Date("2026-09-07T16:00:00Z"),
  }).find((entry) => entry.name === "ow_uw_earnings_report");
  if (found === undefined) throw new Error("no tool ow_uw_earnings_report");
  return found;
}

describe("ow_uw_earnings_report", () => {
  it("keeps completed earnings and current statements separate, bounded, and sourced", async () => {
    const urls: URL[] = [];
    const fetchImpl = async (input: URL | string, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input);
      urls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
      if (url.pathname === "/api/earnings/AVGO")
        return new Response(JSON.stringify(FIXTURE.earnings), { status: 200 });
      if (url.pathname === "/api/stock/AVGO/income-statements")
        return new Response(JSON.stringify(FIXTURE.incomeStatements), { status: 200 });
      return new Response("nope", { status: 404 });
    };
    const out = JSON.parse(
      await tool().run({ ticker: "avgo" }, { fetchImpl } as never),
    ) as Record<string, unknown>;

    expect(urls.map((url) => url.pathname).sort()).toEqual([
      "/api/earnings/AVGO",
      "/api/stock/AVGO/income-statements",
    ]);
    expect(out.earnings).toEqual([
      expect.objectContaining({
        reportDate: "2026-09-02",
        endingFiscalQuarter: "2026-07-31",
        actualEps: "3.03",
        streetMeanEst: "3.22",
        source: "company",
        reportTime: "postmarket",
      }),
    ]);
    expect(out.statements).toEqual([
      expect.objectContaining({
        periodEnd: "2026-07-31",
        updatedAt: "2026-09-05T03:26:20Z",
        currency: null,
        financials: {
          revenue: "29591000000",
          grossProfit: "20456000000",
          operatingIncome: "15955000000",
          netIncome: "13088000000",
        },
      }),
    ]);
  });

  it("retains the other source when one source fails and rejects future data", async () => {
    const statements = structuredClone(FIXTURE.incomeStatements);
    statements.data.push({
      ...statements.data[0],
      fiscal_date_ending: "2026-08-31",
      updated_at: "2026-09-08T00:00:00Z",
    });
    const fetchImpl = async (input: URL | string) => {
      const url = input instanceof URL ? input : new URL(input);
      if (url.pathname === "/api/earnings/AVGO")
        return new Response("down", { status: 500, statusText: "Server Error" });
      return new Response(JSON.stringify(statements), { status: 200 });
    };
    const out = JSON.parse(
      await tool().run({ ticker: "AVGO" }, { fetchImpl } as never),
    ) as {
      earnings: unknown[];
      statements: unknown[];
      sourceErrors?: Record<string, string>;
    };

    expect(out.earnings).toEqual([]);
    expect(out.statements).toHaveLength(1);
    expect(out.sourceErrors?.earnings).toContain("/api/earnings/AVGO returned 500");
  });
});

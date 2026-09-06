/**
 * `ow_rotation` is the weekly deterministic step's only tool. Same two
 * properties as the frame: its schema must accept `{}`, and one symbol apex
 * cannot serve must not cost the other fifteen their row.
 *
 * The bars come from a stubbed `ow_apex_bars` fetch rather than from the
 * network, and the closes it returns are the real ones recorded on 2026-09-06
 * (`fixtures/review/rotation-closes-2026-08-28.json`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import { buildTools } from "../tools/index.js";
import { parseReviewConfig } from "../quality/review-config.js";

const TENANT = join(__dirname, "..", "tenant.yaml");
const spec = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT);
const review = parseReviewConfig(spec.extensions);
const rotation = review.rotation!;
const expectedRows = rotation.sectorEtfs.length + review.themes.length;

const FIX = join(__dirname, "fixtures", "review");
const closes = (
  JSON.parse(
    readFileSync(join(FIX, "rotation-closes-2026-08-28.json"), "utf8"),
  ) as { closes: Record<string, Record<string, number>> }
).closes;

const tools = (env: Record<string, string | undefined>) =>
  buildTools({
    stateRoot: "/tmp/ow-rotation",
    env,
    extensions: spec.extensions,
  });

/** Answers `/v1/equity/<symbol>/bars` from the recorded closes. `refuse` gets
 *  a 500, which is how a real lake gap reaches the tool. */
const fetchImpl = (refuse: ReadonlySet<string>): typeof fetch =>
  (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const symbol = url.pathname.split("/")[3] ?? "";
    if (refuse.has(symbol))
      return new Response("nope", { status: 500, statusText: "Server Error" });
    const bars = Object.entries(closes[symbol] ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, close]) => ({
        time: `${time}T00:00:00+00:00`,
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
      }));
    if (bars.length === 0)
      return new Response("[]", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify({ symbol, bars }), { status: 200 });
  }) as unknown as typeof fetch;

const run = async (refuse: ReadonlySet<string> = new Set()) => {
  const tool = tools({ OW_APEX_API_BASE: "http://apex.invalid" }).find(
    (entry) => entry.name === "ow_rotation",
  )!;
  return JSON.parse(await tool.run({}, { fetchImpl: fetchImpl(refuse) })) as {
    asOf: string;
    benchmark: string;
    benchmarkReturns: { w1: number | null };
    rows: Array<{ symbol: string; excess1w: number | null; untested?: string }>;
    notes: string[];
  };
};

describe("ow_rotation", () => {
  it("takes no parameters and does not mutate", () => {
    const tool = tools({ OW_APEX_API_BASE: "http://apex.invalid" }).find(
      (entry) => entry.name === "ow_rotation",
    )!;
    expect(tool.paramsSchema.safeParse({}).success).toBe(true);
    expect(tool.mutating).toBe(false);
  });

  it("prices every declared symbol and never drops one", async () => {
    const table = await run();
    expect(table.rows.length).toBe(expectedRows);
    expect(table.benchmark).toBe(rotation.benchmark);
    expect(table.benchmarkReturns.w1).not.toBeNull();
    expect(table.rows.some((row) => row.symbol === rotation.benchmark)).toBe(
      false,
    );
  });

  it("keeps the table whole when one symbol refuses", async () => {
    const table = await run(new Set(["XLK"]));
    expect(table.rows.length).toBe(expectedRows);
    const xlk = table.rows.find((row) => row.symbol === "XLK");
    expect(xlk?.untested).toBeDefined();
    expect(xlk?.excess1w).toBeNull();
    expect(table.notes.join(" ")).toContain("XLK");
    // Everything else still priced.
    expect(
      table.rows.filter((row) => row.excess1w !== null).length,
    ).toBeGreaterThan(5);
  });

  it("never throws, even when apex answers nothing at all", async () => {
    const table = await run(
      new Set(rotation.sectorEtfs.concat(["SPY", "DBA", "MOS", "NTR", "DE"])),
    );
    expect(table.rows.length).toBe(expectedRows);
    expect(table.rows.every((row) => row.untested !== undefined)).toBe(true);
  });

  it("reports the gap rather than a table when apex is not configured", async () => {
    const tool = tools({}).find((entry) => entry.name === "ow_rotation")!;
    const out = JSON.parse(await tool.run({})) as {
      rows?: unknown[];
      notes?: string[];
    };
    expect(out.rows?.length).toBe(expectedRows);
    expect(out.notes?.join(" ")).toContain("OW_APEX_API_BASE");
  });
});

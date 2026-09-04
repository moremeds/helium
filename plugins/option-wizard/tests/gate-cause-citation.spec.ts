/**
 * The `cause-citation` output gate. The fixture rows are the real Unusual
 * Whales headlines for Governor Waller's 2026-09-03 remarks — the cause the
 * intraday brief that day never named.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-cause-citation
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import gate from "../gates/cause-citation.js";

const FX = JSON.parse(
  readFileSync(
    new URL("./fixtures/uw-headlines-waller-2026-09-03.json", import.meta.url),
    "utf8",
  ),
) as { data: Array<{ created_at: string; headline: string }> };

const WALLER = FX.data.find((r) => r.created_at === "2026-09-03T13:03:25Z")!;
const TOOL_OUTPUT = JSON.stringify({ rows: FX.data });
const ctx = { runId: "run-1", role: "regime-analyst" };

const step = (cause: unknown): { text: string } => ({
  text: JSON.stringify({
    headline: "Yields fall, stocks rally.",
    sections: [{ title: "Reaction function", body: "See cause." }],
    cause,
  }),
});

describe("cause-citation", () => {
  it("refuses a located cause when this step called no tool", async () => {
    const result = await gate.check(
      step({
        located: true,
        headline: WALLER.headline,
        at: WALLER.created_at,
        source: "ow_uw_headlines",
        searchTerm: "Waller",
      }),
      { ...ctx, stepToolOutputs: [] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("called no tool");
  });

  it("passes the same claim when the headline is verbatim in this step's tool output", async () => {
    const result = await gate.check(
      step({
        located: true,
        headline: WALLER.headline,
        at: WALLER.created_at,
        source: "ow_uw_headlines",
        searchTerm: "Waller",
      }),
      { ...ctx, stepToolOutputs: [TOOL_OUTPUT] },
    );
    expect(result.pass).toBe(true);
  });

  it("refuses a paraphrase, naming the claim and the search terms", async () => {
    const result = await gate.check(
      step({
        located: true,
        headline: "Waller says current rates may be enough; no rush to cut",
        at: WALLER.created_at,
        source: "ow_uw_headlines",
        searchTerm: "Waller",
      }),
      { ...ctx, stepToolOutputs: [TOOL_OUTPUT] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("not found verbatim");
    expect(result.reason).toContain("Waller says current rates");
    expect(result.reason).toContain("searched: Waller");
  });

  it("ignores a run-wide tool output from an earlier step", async () => {
    const result = await gate.check(
      step({ located: true, headline: WALLER.headline }),
      { ...ctx, toolOutputs: [TOOL_OUTPUT], stepToolOutputs: [] },
    );
    expect(result.pass).toBe(false);
  });

  it("passes an honest 'not located'", async () => {
    const result = await gate.check(
      step({ located: false, searched: ["Waller", "Fed"] }),
      { ...ctx, stepToolOutputs: [TOOL_OUTPUT] },
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("not located");
  });

  it("passes a step with no cause at all", async () => {
    const result = await gate.check(step(undefined), ctx);
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("no cause claimed");
  });
});

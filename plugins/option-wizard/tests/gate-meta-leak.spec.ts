/**
 * The `meta-leak` advisory gate. The editor persona already forbade
 * replay/coverage words in prose; v3 still shipped "No prior intraday brief
 * exists" as a headline (docs/evidence/pit-replays/2026-09-05/pit-v3/). A
 * persona is a request; this is a match.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-meta-leak
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/meta-leak.js";
import { findMetaLeaks } from "../quality/meta-leak.js";

const ctx = { runId: "run-1", role: "editor" } as never;

describe("findMetaLeaks", () => {
  it("finds one violation in a headline that names a missing prior brief", () => {
    const leaks = findMetaLeaks({
      headline: "No prior intraday brief exists — starting from today.",
      sections: [],
    });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.field).toBe("headline");
    expect(leaks[0]!.pattern).toBe("no prior \\w+ brief");
    expect(leaks[0]!.excerpt).toContain("No prior intraday brief");
  });

  it("does not scan the coverage block", () => {
    // The coverage block is where "unavailable" BELONGS: it is the honest
    // record of what could not be read. Gating it would push the run into
    // hiding its own gaps, which is the opposite of the point.
    const leaks = findMetaLeaks({
      headline: "A bear-steepener took the 10Y to 4.788%.",
      sections: [{ title: "Rates led", body: "The 10Y sat at 4.79%." }],
      coverage: {
        title: "Layer Coverage",
        body: "Tape — ow_spot unavailable, skipped. Events — calendar unavailable.",
      },
    });
    expect(leaks).toEqual([]);
  });

  it("names the field for a section title and a section body separately", () => {
    const leaks = findMetaLeaks({
      headline: "Clean.",
      sections: [
        { title: "This is a replay", body: "Nothing to see." },
        { title: "Fine", body: "The tape was frozen at the open." },
      ],
    });
    expect(leaks.map((leak) => leak.field)).toEqual([
      "section 1 title",
      "section 2 body",
    ]);
  });

  it("scans decision values in both the object and the row shape", () => {
    const asObject = findMetaLeaks({
      headline: "Clean.",
      sections: [],
      decision: { Call: "Nothing ships today.", Action: "Sit." },
    });
    const asRows = findMetaLeaks({
      headline: "Clean.",
      sections: [],
      decision: [
        { label: "Call", value: "Nothing ships today." },
        { label: "Action", value: "Sit." },
      ],
    });
    expect(asObject.map((leak) => leak.field)).toEqual(["decision Call"]);
    expect(asRows.map((leak) => leak.field)).toEqual(["decision Call"]);
  });

  it("is case-insensitive and matches every listed pattern once", () => {
    const leaks = findMetaLeaks({
      headline:
        "REPLAY as-of unavailable FROZEN nothing ships no prior close brief not checked",
      sections: [],
    });
    expect(leaks).toHaveLength(7);
  });
});

describe("meta-leak gate", () => {
  it("is advisory and never blocks delivery", () => {
    expect(gate.id).toBe("meta-leak");
    expect(gate.phase).toBe("output");
    expect(gate.advisory).toBe(true);
    expect(gate.appliesTo).toEqual(["editor", "regime-analyst"]);
  });

  it("refuses the v3 headline and names field, pattern and excerpt", async () => {
    const text = JSON.stringify({
      headline: "No prior intraday brief exists — starting from today.",
      sections: [],
    });
    const result = await gate.check({ text }, ctx);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("1 meta leak");
    expect(result.reason).toContain("headline");
    expect(result.reason).toContain("no prior \\w+ brief");
    expect(result.reason).toContain("No prior intraday brief");
  });

  it("passes a clean brief whose coverage block admits an unavailable source", async () => {
    const text = JSON.stringify({
      headline: "A bear-steepener took the 10Y to 4.788%.",
      sections: [{ title: "Rates led", body: "The 10Y sat at 4.79%." }],
      coverage: {
        title: "Layer Coverage",
        body: "Tape — ow_spot unavailable.",
      },
    });
    const result = await gate.check({ text }, ctx);
    expect(result.pass).toBe(true);
  });

  it("passes a step whose text is not a document at all", async () => {
    const result = await gate.check({ text: "no json here" }, ctx);
    expect(result.pass).toBe(true);
  });
});

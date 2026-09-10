/**
 * #108 Loop 3 — the Sources block, the prose strip, and the paragraph
 * obligation.
 *
 * The three items are the user's, 2026-09-09: weekly coverage must be longer
 * (a paragraph per backed row), the 2026-09-09 premarket is the reference
 * shape for daily and must not be regressed, and inline source parentheticals
 * come out of the prose INTO one Sources block — never the strip alone.
 *
 * Every string asserted here comes from the frozen W37 replay
 * (`docs/evidence/flash-loop2/2026-09-09/run3`): the SPY gamma flip 768.35
 * as-of 2026-09-04, the Fed broad dollar index as-of 2026-08-28, the
 * 2026-08-31→2026-09-04 window, and the sentence that named `ow_reports` in
 * prose. No invented tickers, no round placeholder prices.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  sourcesBlock,
  sourcesBody,
  stripSourceParentheticals,
  toolNamesIn,
} from "../render/sources.js";

const here = (name: string): string =>
  fileURLToPath(new URL(`../${name}`, import.meta.url));

describe("source parentheticals leave the prose", () => {
  it("removes an as-of parenthetical whole", () => {
    const out = stripSourceParentheticals(
      "the SPY gamma flip sat at 768.35 (as-of 2026-09-04), quiet all week",
    );
    expect(out.text).toBe(
      "the SPY gamma flip sat at 768.35, quiet all week",
    );
    expect(out.removed).toEqual(["(as-of 2026-09-04)"]);
  });

  it("keeps the number and drops only the source segment", () => {
    const out = stripSourceParentheticals(
      "The policy path (9/16 hike probability 55.7, as-of 2026-09-04) is later context",
    );
    expect(out.text).toBe(
      "The policy path (9/16 hike probability 55.7) is later context",
    );
  });

  it("leaves a parenthetical that is data, not a source", () => {
    for (const text of [
      "Computer/GPU rose +5.9% (+5.7% vs SPY, 6 of 6 priced)",
      "the reported week (2026-08-31 through 2026-09-04)",
      "PANW (−10.3% window, excess −10.4%) was the laggard",
    ]) {
      const out = stripSourceParentheticals(text);
      expect(out.text).toBe(text);
      expect(out.removed).toEqual([]);
    }
  });

  it("drops a lone provider timestamp", () => {
    expect(
      stripSourceParentheticals("GuruFocus (2026-09-08T21:33:48Z) reported")
        .text,
    ).toBe("GuruFocus reported");
  });

  it("drops a frame-row citation", () => {
    expect(
      stripSourceParentheticals(
        "leadership was narrow (frame sector rows, as-of 2026-09-04)",
      ).text,
    ).toBe("leadership was narrow");
  });

  it("finds a tool name a sentence still carries", () => {
    expect(
      toolNamesIn(
        "ow_reports returned no stored close notes and ow_uw_headlines carried no history",
      ),
    ).toEqual(["ow_reports", "ow_uw_headlines"]);
  });
});

describe("the Sources block is built from the run, not from the prose", () => {
  const rows = sourcesBlock({
    coverage: [
      {
        layer: "macro",
        source: "ow_macro_rates",
        asOf: "2026-09-03",
        state: "ok",
      },
      {
        layer: "flow",
        source: "ow_uw_market_state",
        state: "skipped",
        reason: "no payload",
      },
      { layer: "fx", source: "ow_spot", asOf: "2026-08-28", state: "ok" },
    ],
    candidates: {
      window: { start: "2026-08-31", end: "2026-09-04" },
      source: "apex-equity-returns",
    },
    rotation: { asOf: "2026-09-04", benchmark: "SPY" },
    macroReleases: {
      weekStart: "2026-08-31",
      weekEnd: "2026-09-04",
      scheduled: 2,
      printed: 3,
    },
    premarketMovers: { asOf: "2026-09-09T12:02:11Z", session: "premarket" },
    eventDay: { date: "2026-09-04", pickedBy: "largest basket dispersion" },
    news: {
      asOf: "2026-09-09T01:12:44Z",
      providers: [
        { provider: "GuruFocus", published: "2026-09-08T21:33:48Z" },
        { provider: "GuruFocus", published: "2026-09-08T18:02:11Z" },
        { provider: "Reuters", published: "2026-09-08T12:40:00Z" },
      ],
    },
  });

  it("names every tool the run recorded, once", () => {
    expect(rows.map((row) => row.tool)).toEqual([
      "ow_macro_rates",
      "ow_uw_market_state",
      "ow_spot",
      "ow_stock_week",
      "ow_rotation",
      "ow_event_day",
      "ow_macro_releases",
      "ow_premarket_movers",
      "ow_tv_news",
    ]);
  });

  it("copies each source's own as-of and its own skip reason", () => {
    expect(rows[0]?.asOf).toBe("2026-09-03");
    expect(rows[1]?.reason).toBe("no payload");
    expect(rows[2]?.asOf).toBe("2026-08-28");
  });

  it("carries the headline providers with their timestamps, deduped", () => {
    const news = rows.find((row) => row.tool === "ow_tv_news");
    expect(news?.what).toContain("GuruFocus 2026-09-08T21:33:48Z");
    expect(news?.what).toContain("Reuters 2026-09-08T12:40:00Z");
    // The second GuruFocus row is the same provider, so it adds no entry.
    expect(news?.what.match(/GuruFocus/gu)?.length).toBe(1);
  });

  it("prints flat, because Gmail strips <details>", () => {
    const text = sourcesBody(rows);
    expect(text).toContain("- ow_macro_rates · macro · as of 2026-09-03");
    expect(text).toContain("- ow_uw_market_state · flow · no payload");
    expect(text).not.toContain("<details>");
  });

  it("lists the release window but no as-of the block does not carry", () => {
    const macro = rows.find((row) => row.tool === "ow_macro_releases");
    expect(macro?.what).toBe(
      "releases 2026-08-31→2026-09-04 — 3 printed, 2 scheduled",
    );
    // `MacroReleasesSummary` has no as-of field. Printing one would be
    // inventing a stamp, which is the failure the block exists to prevent.
    expect(macro?.asOf).toBeUndefined();
  });

  it("carries the movers' own as-of and the session it measures", () => {
    const movers = rows.find((row) => row.tool === "ow_premarket_movers");
    expect(movers?.asOf).toBe("2026-09-09T12:02:11Z");
    expect(movers?.what).toBe("movers, premarket");
  });

  it("says so rather than inventing one when nothing was recorded", () => {
    expect(sourcesBody(sourcesBlock({ coverage: [] }))).toBe(
      "no source was recorded for this run",
    );
  });
});

describe("the prompt carries the same rule at both scales", () => {
  // Read as TEXT, not parsed: the assertion is that the two task prompts carry
  // byte-identical rule blocks, and a parser that folds scalars would hide a
  // drift this test exists to catch.
  const yaml = readFileSync(here("team.yaml"), "utf8");
  const promptOf = (id: string): string => {
    const start = yaml.indexOf(`  - id: ${id}\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = yaml.slice(start + 1);
    const end = rest.indexOf("\n  - id: ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("obliges a paragraph per backed coverage row, weekly and daily", () => {
    for (const id of ["weekly", "edit"])
      expect(promptOf(id)).toContain("A BACKED COVERAGE ROW OWES A PARAGRAPH");
  });

  it("scales that obligation by phase inside one rule, not two rules", () => {
    const rule = (id: string): string =>
      promptOf(id)
        .split("A BACKED COVERAGE ROW OWES A PARAGRAPH")[1]
        ?.split("\n\n")[0] ?? "";
    // Byte-identical in both tasks: one rule, and its phase scale is stated
    // inside it. Two copies that drift are two rules.
    expect(rule("weekly")).toBe(rule("edit"));
    expect(rule("weekly")).toContain("the weekly writes a full paragraph");
    expect(rule("weekly")).toContain("the daily writes the");
  });

  it("says macro release figures are text, in both prompts", () => {
    for (const id of ["weekly", "edit"]) {
      expect(promptOf(id)).toContain("never call a print a beat or a miss");
      expect(promptOf(id)).toContain("NO RELEASE WAS HANDED TO THIS RUN");
    }
  });

  it("bans the inline source in both, and points at the Sources block", () => {
    for (const id of ["weekly", "edit"]) {
      expect(promptOf(id)).toContain("NO SOURCE IN A SENTENCE");
      expect(promptOf(id)).toContain("ONE Sources block per note");
    }
  });

  it("gives the weekly the room the paragraphs need", () => {
    const tenant = readFileSync(here("tenant.yaml"), "utf8");
    const capOf = (phase: string): number => {
      const block = tenant.split(`      ${phase}:`)[1] ?? "";
      return Number(/review:\s*(\d+)/u.exec(block)?.[1] ?? "0");
    };
    expect(capOf("weekly")).toBeGreaterThan(900);
    // Item 2: the daily is the reference shape and does not move.
    expect(capOf("daily")).toBe(300);
  });
});

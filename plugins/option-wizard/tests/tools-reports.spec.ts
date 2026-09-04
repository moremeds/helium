/**
 * ow_reports reads the tenant's own past reports off disk. The files are real
 * files in a temp state root — the report file IS the record, so a test that
 * stubbed the filesystem would be testing the stub.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";
import { candidatesFrom } from "../render/index.js";

const stateRoot = mkdtempSync(join(tmpdir(), "ow-reports-"));
const dir = join(stateRoot, "reports");
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function reportsTool(root: string) {
  const found = buildTools({ stateRoot: root, env: {} }).find((t) => t.name === "ow_reports");
  if (found === undefined) throw new Error("no tool ow_reports");
  return found;
}

type Row = {
  date: string;
  phase: string;
  candidates: Array<{ id: string; ticker: string }>;
  steps?: Record<string, string>;
};
type Payload = { dir: string; reports: Row[]; dropped?: string[] };
const parse = async (root: string, args: Record<string, unknown>): Promise<Payload> =>
  JSON.parse(await reportsTool(root).run(args)) as Payload;
const read = async (root: string, args: Record<string, unknown>): Promise<Row[]> =>
  (await parse(root, args)).reports;

/** A report file in the shape the CLI's own writer emits: `## <task> — <role>`
 *  headings, the model's fenced JSON under the one that produced it. */
const reportFile = (steps: Array<[string, string, string]>): string =>
  steps.map(([task, role, body]) => `## ${task} — ${role}\n\n${body}\n`).join("\n");

/** NVDA at its real 2026-09-02 premarket quote (224.41) with the strikes the
 *  run's own designer proposed. Frozen; nothing here is fetched at test time. */
const NVDA_REVIEW = JSON.stringify({
  proposals: [
    {
      ticker: "NVDA",
      invalidation: [{ level: 215, side: "below" }],
      strategy: "call debit spread",
      target: "NVDA 240-243 by 16-Sep",
      legs: [
        { right: "call", expiry: "2026-09-16", strike: 230, action: "buy", ratio: 1, mid: 6.1 },
        { right: "call", expiry: "2026-09-16", strike: 245, action: "sell", ratio: 1, mid: 2.2 },
      ],
      rationale: "Algorithm-supply cycle intact.",
    },
  ],
  riskList: [],
});

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `option-wizard-${yesterday}-close.md`),
    reportFile([["markout", "markout-clerk", "No thesis breached its level."]]),
  );
  writeFileSync(
    join(dir, `option-wizard-${today}-premarket.md`),
    reportFile([
      ["regime", "regime-analyst", "Rates first."],
      ["review", "risk-reviewer", "```json\n" + NVDA_REVIEW + "\n```"],
    ]),
  );
});

describe("ow_reports", () => {
  it("returns both reports newest first", async () => {
    const rows = await read(stateRoot, { days: 10 });
    expect(rows.map((row) => [row.date, row.phase])).toEqual([
      [today, "premarket"],
      [yesterday, "close"],
    ]);
    expect(rows[0]!.candidates.map((c) => c.id)).toEqual([
      `NVDA-${today}-premarket-1`,
    ]);
  });

  it("returns the ledger, not the prose — the proposals, with their ids", async () => {
    // The whole reason this tool changed. It used to return each report's full
    // markdown: 50,912 bytes for a premarket, against core's 8,192-byte tool
    // ceiling that keeps the first 2,000 characters and discards the rest with
    // no summariser wired up. What survived was the run header and the GEX
    // table; the proposals sat at ~15 KB, past the cut. markout was asked to
    // settle proposals by id while holding a ticker table, and it invented six.
    const rows = await read(stateRoot, { days: 1, phase: "premarket" });
    const [row] = rows;
    expect(row!.candidates[0]).toMatchObject({
      ticker: "NVDA",
      invalidation: [{ level: 215, side: "below" }],
    });
    expect(row!.steps).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("Rates first");
  });

  it("adds a named step's prose only when asked for it", async () => {
    const rows = await read(stateRoot, { days: 1, phase: "premarket", steps: ["regime"] });
    expect(rows[0]!.steps?.regime).toContain("Rates first");
  });

  it("an id here is an id the reader was mailed", async () => {
    // The id is a positional counter over the surviving proposals, so it is
    // only meaningful relative to the filter that produced it. Both sides call
    // candidatesFrom over the same immutable file: if this tool re-implemented
    // the filter, one dropped proposal would shift every later id and a
    // settlement would cite an id nobody ever received.
    const rows = await read(stateRoot, { days: 1, phase: "premarket" });
    const mailed = candidatesFrom(
      "```json\n" + NVDA_REVIEW + "\n```",
      today,
      "premarket",
    );
    expect(rows[0]!.candidates).toEqual(mailed.candidates);
  });

  it("names the prose it dropped instead of letting the ceiling cut it silently", async () => {
    const root = mkdtempSync(join(tmpdir(), "ow-reports-big-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    for (const day of ["2026-08-31", "2026-09-01", "2026-09-02"]) {
      writeFileSync(
        join(reports, `option-wizard-${day}-close.md`),
        reportFile([["recap", "recap-writer", "x".repeat(6000)]]),
      );
    }
    const out = await parse(root, { days: 3, phase: "close", steps: ["recap"] });
    // Bounded, and it says so — the difference between a model that reads the
    // ledger it still has and one that fills a silent gap from the nearest
    // table on screen.
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(8192);
    expect(out.dropped?.length).toBeGreaterThan(0);
    expect(out.reports).toHaveLength(3);
  });

  it("filters by phase", async () => {
    const rows = await read(stateRoot, { days: 10, phase: "close" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe(yesterday);
  });

  it("ignores a file that is not one of our reports", async () => {
    writeFileSync(join(dir, "notes.md"), "operator scratch\n");
    const rows = await read(stateRoot, { days: 10 });
    expect(rows).toHaveLength(2);
  });

  it("returns an empty list when the directory does not exist", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ow-reports-empty-"));
    const out = JSON.parse(await reportsTool(empty).run({ days: 10 })) as {
      dir: string;
      reports: Row[];
    };
    expect(out.reports).toEqual([]);
    expect(out.dir).toBe(join(empty, "reports"));
  });

  it("refuses a lookback past the cap rather than pulling a fortnight of prose", async () => {
    await expect(reportsTool(stateRoot).run({ days: 30 })).rejects.toThrow();
  });
  it("counts distinct dates, not wall-clock days, so a zone gap cannot hide a file", async () => {
    // Three dated reports; days: 2 must return the newest two DATES and stop.
    // The old cutoff subtracted milliseconds from this process's clock, which
    // is a different calendar day from the ET-stamped filename for most of the
    // HK evening — the run that needed yesterday's close was the run that lost
    // it.
    const root = mkdtempSync(join(tmpdir(), "ow-reports-span-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    for (const day of ["2026-08-31", "2026-09-01", "2026-09-02"])
      writeFileSync(join(reports, `option-wizard-${day}-close.md`), `# close ${day}\n`);
    expect((await read(root, { days: 2 })).map((row) => row.date)).toEqual([
      "2026-09-02",
      "2026-09-01",
    ]);
  });
});

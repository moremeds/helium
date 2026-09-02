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

const stateRoot = mkdtempSync(join(tmpdir(), "ow-reports-"));
const dir = join(stateRoot, "reports");
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function reportsTool(root: string) {
  const found = buildTools({ stateRoot: root, env: {} }).find((t) => t.name === "ow_reports");
  if (found === undefined) throw new Error("no tool ow_reports");
  return found;
}

type Row = { date: string; phase: string; text: string };
const read = async (root: string, args: Record<string, unknown>): Promise<Row[]> =>
  (JSON.parse(await reportsTool(root).run(args)) as { reports: Row[] }).reports;

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `option-wizard-${yesterday}-close.md`), "# close\n\n## markout\n");
  writeFileSync(join(dir, `option-wizard-${today}-premarket.md`), "# premarket\n\n## 分化\n");
});

describe("ow_reports", () => {
  it("returns both reports newest first", async () => {
    const rows = await read(stateRoot, { days: 10 });
    expect(rows.map((row) => [row.date, row.phase])).toEqual([
      [today, "premarket"],
      [yesterday, "close"],
    ]);
    expect(rows[0].text).toContain("## 分化");
  });

  it("filters by phase", async () => {
    const rows = await read(stateRoot, { days: 10, phase: "close" });
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(yesterday);
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
});

/**
 * `ow_prior_brief` is how the editor writes a DELTA instead of a snapshot.
 *
 * Same discipline as `tools-reports.spec.ts`: real files in a temp state root,
 * because the report file IS the record and a stubbed filesystem would be a
 * test of the stub.
 *
 * The prose in the fixtures is the 2026-09-03 premarket run's own output
 * (`option-wizard-2026-09-03-premarket.md`), trimmed. No market number in this
 * file is invented, and none is asserted as a fact about any day.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTools } from "../tools/index.js";

function priorBriefTool(root: string) {
  const found = buildTools({ stateRoot: root, env: {} }).find(
    (tool) => tool.name === "ow_prior_brief",
  );
  if (found === undefined) throw new Error("no tool ow_prior_brief");
  return found;
}

type Payload = {
  dir: string;
  prior: { day: string; phase: string; file: string; text: string } | null;
  reason?: string;
};

const call = async (
  root: string,
  args: Record<string, unknown> = {},
): Promise<Payload> =>
  JSON.parse(await priorBriefTool(root).run(args)) as Payload;

/** A report file in the shape the CLI's own writer emits. */
const reportFile = (steps: Array<[string, string, string]>): string =>
  steps
    .map(([task, role, body]) => `## ${task} — ${role}\n\n${body}\n`)
    .join("\n");

const EDIT_DOC = JSON.stringify({
  headline: "Rates are still the first cause. No candidate ships today.",
  decision: { Call: "Reject all eight and reprice against today's spot." },
  sections: [
    {
      title: "Macro read",
      body: "The futures-implied path from argon, snapshot 2026-09-02, assigns a 25bp hike probability of 60% for 2026-09-16.",
    },
  ],
});

function root(files: Array<[string, string]>): string {
  const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-brief-"));
  const dir = join(stateRoot, "reports");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files)
    writeFileSync(join(dir, name), body, "utf8");
  return stateRoot;
}

describe("ow_prior_brief", () => {
  it("returns the newest premarket report BEFORE today, never today's own", () => {
    // The failure this guards is not hypothetical: delivery-markdown writes
    // this run's report under today's date, so a tool that took the newest
    // file would hand the editor the brief it is in the middle of writing and
    // get "nothing changed" every single morning.
    const stateRoot = root([
      [
        "option-wizard-2026-09-01-premarket.md",
        reportFile([["edit", "editor", "{}"]]),
      ],
      [
        "option-wizard-2026-09-03-premarket.md",
        reportFile([["edit", "editor", EDIT_DOC]]),
      ],
      [
        "option-wizard-2026-09-04-premarket.md",
        reportFile([
          ["edit", "editor", JSON.stringify({ headline: "TODAY'S OWN." })],
        ]),
      ],
    ]);
    return call(stateRoot, { today: "2026-09-04" }).then((payload) => {
      expect(payload.prior?.day).toBe("2026-09-03");
      expect(payload.prior?.file).toBe("option-wizard-2026-09-03-premarket.md");
      expect(payload.prior?.text).toContain("Rates are still the first cause");
      expect(payload.prior?.text).not.toContain("TODAY'S OWN");
    });
  });

  it("keeps to its own phase and ignores the other four", async () => {
    const stateRoot = root([
      [
        "option-wizard-2026-09-03-close.md",
        reportFile([
          ["edit", "editor", JSON.stringify({ headline: "CLOSE." })],
        ]),
      ],
      [
        "option-wizard-2026-09-02-premarket.md",
        reportFile([["edit", "editor", EDIT_DOC]]),
      ],
    ]);
    const payload = await call(stateRoot, { today: "2026-09-04" });
    expect(payload.prior?.day).toBe("2026-09-02");
    expect(payload.prior?.phase).toBe("premarket");
    expect(payload.prior?.text).not.toContain("CLOSE.");
  });

  it("falls back to the regime step for a report written before the editor existed", async () => {
    // Every report on disk today predates the edit step. Refusing them would
    // make the very first edited brief the one with no yesterday to diff.
    const stateRoot = root([
      [
        "option-wizard-2026-09-03-premarket.md",
        reportFile([["regime", "regime-analyst", EDIT_DOC]]),
      ],
    ]);
    const payload = await call(stateRoot, { today: "2026-09-04" });
    expect(payload.prior?.text).toContain("Rates are still the first cause");
  });

  it("caps the text, so yesterday cannot bury today", async () => {
    // The real 2026-09-03 premarket report is 17 KB. Uncapped, it would arrive
    // in the editor's context ahead of the day's own data — the same failure
    // that made a close run settle six theses that never existed.
    const long = JSON.stringify({
      headline: "H",
      sections: [
        { title: "one", body: "x".repeat(4000) },
        { title: "two", body: "y".repeat(4000) },
        { title: "three", body: "z".repeat(4000) },
        { title: "four", body: "w".repeat(4000) },
      ],
    });
    const stateRoot = root([
      [
        "option-wizard-2026-09-03-premarket.md",
        reportFile([["edit", "editor", long]]),
      ],
    ]);
    const payload = await call(stateRoot, { today: "2026-09-04" });
    expect(payload.prior!.text.length).toBeLessThanOrEqual(2000);
    // Every section still appears — bodies are trimmed individually, so the
    // cap does not simply cut the document off after the first one.
    expect(payload.prior!.text).toContain("four");
  });

  it("answers prior:null with a reason, never an empty brief that reads as a quiet day", async () => {
    const stateRoot = root([
      [
        "option-wizard-2026-09-04-premarket.md",
        reportFile([["edit", "editor", EDIT_DOC]]),
      ],
    ]);
    const payload = await call(stateRoot, { today: "2026-09-04" });
    expect(payload.prior).toBeNull();
    expect(payload.reason).toContain("before 2026-09-04");
  });

  it("treats a missing reports directory as the first ever run, not an outage", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "ow-prior-brief-empty-"));
    const payload = await call(stateRoot, { today: "2026-09-04" });
    expect(payload.prior).toBeNull();
    expect(payload.reason).toContain("no reports directory");
  });
});

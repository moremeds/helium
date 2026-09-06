/**
 * `ow_session_frame` is the deterministic step's only tool, so two properties
 * decide whether the step can run at all: its schema must accept `{}` (that is
 * what the runner hands a tool on a `requires: []` step), and it must never
 * throw — a sibling that could not answer is a printed `skipped` row, not a
 * failed run.
 *
 * No environment key is set here, so every sibling refuses at its own
 * `need(env, …)`. That IS the laptop's shape, and the frame it produces is the
 * one an unconfigured machine gets.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import { SESSION_FRAME_SIBLINGS, buildTools } from "../tools/index.js";
import { SESSION_FRAME_KIND } from "../quality/frame.js";
import { parseReviewConfig } from "../quality/review-config.js";

const TENANT = join(__dirname, "..", "tenant.yaml");
const spec = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT);
const review = parseReviewConfig(spec.extensions);
const expectedRows =
  review.coverage.length + review.sectors.length + review.themes.length;

const tools = buildTools({
  stateRoot: mkdtempSync(join(tmpdir(), "ow-frame-tool-")),
  env: {
    HELIUM_AUDIT_DB: join(
      mkdtempSync(join(tmpdir(), "ow-frame-db-")),
      "audit.db",
    ),
  },
  extensions: spec.extensions,
});
const frameTool = tools.find((tool) => tool.name === "ow_session_frame")!;

describe("ow_session_frame", () => {
  it("is built and takes no parameters", () => {
    expect(frameTool).toBeDefined();
    expect(frameTool.paramsSchema.safeParse({}).success).toBe(true);
    expect(frameTool.mutating).toBe(false);
  });

  it("never throws, and every unanswered sibling is a named skip", async () => {
    const frame = JSON.parse(await frameTool.run({})) as {
      kind: string;
      rows: Array<{ id: string; untested?: string }>;
      coverage: Array<{
        layer: string;
        source: string;
        state: string;
        reason?: string;
      }>;
      mode: string;
      focus: { weekly: unknown[]; notes: string[]; weightsNote: string };
      ledger: { open: unknown[] };
    };
    expect(frame.kind).toBe(SESSION_FRAME_KIND);
    expect(frame.rows.length).toBe(expectedRows);
    expect(frame.rows.every((row) => row.untested !== undefined)).toBe(true);
    expect(frame.mode).toBe("no-data");
    expect(frame.ledger.open).toEqual([]);
    for (const row of frame.coverage) {
      expect(row.state).toBe("skipped");
      expect(row.reason?.length ?? 0).toBeGreaterThan(0);
    }
    expect(frame.focus.weightsNote).toBe("weights: declared prior 2026-09-06");
  });

  it("never lists the positions tool as a source", () => {
    // The /flash page is public. Asserting against the LIST rather than against
    // one absent call is what makes a future edit fail here.
    expect(SESSION_FRAME_SIBLINGS).not.toContain("ow_ib_positions");
    expect(SESSION_FRAME_SIBLINGS).toContain("ow_argon_watchlist");
    for (const name of SESSION_FRAME_SIBLINGS)
      expect(tools.some((tool) => tool.name === name)).toBe(true);
  });
});

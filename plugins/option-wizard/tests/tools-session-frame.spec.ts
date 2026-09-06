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
import {
  EARNINGS_PER_CALL,
  SESSION_FRAME_SIBLINGS,
  buildTools,
} from "../tools/index.js";
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
      rows: Array<{
        id: string;
        untested?: string;
        level?: string;
        rendererFilled?: boolean;
      }>;
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
    // Every row but one. `calls.open` is renderer-filled from the ledger this
    // same function reads, so it answers `0` even on a machine with no keys.
    expect(
      frame.rows
        .filter((row) => row.rendererFilled !== true)
        .every((row) => row.untested !== undefined),
    ).toBe(true);
    const calls = frame.rows.find((row) => row.id === "calls.open")!;
    expect(calls.rendererFilled).toBe(true);
    expect(calls.level).toBe("0");
    expect(calls.untested).toBeUndefined();
    expect(frame.mode).toBe("no-data");
    expect(frame.ledger.open).toEqual([]);
    for (const row of frame.coverage) {
      expect(row.state).toBe("skipped");
      expect(row.reason?.length ?? 0).toBeGreaterThan(0);
    }
    expect(frame.focus.weightsNote).toBe("weights: declared prior 2026-09-06");
  });

  // THE 2026-09-06 DEFECT. The frame handed `ow_uw_earnings` the whole
  // universe in ONE call and zod refused it with `Too big: expected array to
  // have <=12 items`, so the earnings layer was skipped, not one focus row
  // carried a dated event, and no `focus-admit` commitment could mint. The
  // universe here is deliberately one larger than the cap, so a frame that
  // stopped batching would ask for zero tickers, not for fourteen.
  it("batches the earnings lookup at the tool's own cap", async () => {
    const members = Array.from(
      { length: EARNINGS_PER_CALL + 2 },
      (_, index) => `TT${String(index)}`,
    );
    const asked: string[] = [];
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/api/watchlist/chains")
        return json({
          chains: review.sectors.map((chain) => ({ chain, count: 1 })),
        });
      if (url.pathname === "/api/watchlist")
        return json({
          scanned_at_max: "2026-09-05T03:11:02.482278+08:00",
          tickers: members.map((ticker) => ({
            ticker,
            pinned: false,
            iv_rank: 10,
          })),
        });
      const info = /^\/api\/stock\/([^/]+)\/info$/u.exec(url.pathname);
      if (info !== null) {
        asked.push(info[1]!);
        return json({
          data: {
            next_earnings_date: "2026-09-10",
            announce_time: "postmarket",
            issue_type: "Common Stock",
          },
        });
      }
      return new Response("not stubbed", { status: 404 });
    }) as unknown as typeof fetch;

    const wired = buildTools({
      stateRoot: mkdtempSync(join(tmpdir(), "ow-frame-batch-")),
      env: {
        OW_UW_API_KEY: "test-key",
        OW_ARGON_API_BASE: "http://argon.invalid",
        HELIUM_AUDIT_DB: join(
          mkdtempSync(join(tmpdir(), "ow-frame-batch-db-")),
          "audit.db",
        ),
      },
      extensions: spec.extensions,
    }).find((tool) => tool.name === "ow_session_frame")!;
    const frame = JSON.parse(await wired.run({}, { fetchImpl })) as {
      coverage: Array<{ layer: string; state: string; reason?: string }>;
      focus: { weekly: Array<{ nearest?: { day?: string } }> };
    };
    expect([...asked].sort()).toEqual([...members].sort());
    const earnings = frame.coverage.find((row) => row.layer === "earnings")!;
    expect(earnings.state).toBe("ok");
    expect(earnings.reason).toBeUndefined();
    // The point of the fix: an admitted, DATED event on every focus row, which
    // is what a `focus-admit` commitment needs a window to settle over.
    expect(frame.focus.weekly.length).toBeGreaterThan(0);
    for (const row of frame.focus.weekly)
      expect(row.nearest?.day).toBe("2026-09-10");
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

/**
 * The session frame: one computation, three readers.
 *
 * Every payload here is a recorded 2026-09-03 close response (see
 * `fixtures/review/README.md`); the ledger, the state record and the metric
 * rows are seeded into throwaway directories. Nothing reaches the network and
 * no number is invented.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuditStore,
  appendLedger,
  parseTenantYaml,
  type RunReport,
} from "@helium/core";
import { MIN_HISTORY, MOVE_METRIC } from "../quality/history.js";
import { parseReviewConfig } from "../quality/review-config.js";
import {
  SESSION_FRAME_KIND,
  attachThresholds,
  buildFrame,
  frameFrom,
} from "../quality/frame.js";
import type { ChannelInputs } from "../quality/channels.js";
import type { FocusInputs } from "../quality/focus.js";

const FIX = join(__dirname, "fixtures", "review");
const load = (name: string): any =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const TENANT_YAML = join(__dirname, "..", "tenant.yaml");
const review = parseReviewConfig(
  parseTenantYaml(readFileSync(TENANT_YAML, "utf8"), TENANT_YAML).extensions,
);
const expectedRows =
  review.coverage.length + review.sectors.length + review.themes.length;

const macro = load("macro-2026-09-03-close.json");
const policy = load("policy-2026-09-03-close.json");
const gex = load("gex-2026-09-03-close.json");
const tide = load("tide-2026-09-03-close.json");
const spot = load("spot-2026-09-03-close-report.json");

const DAY = "2026-09-03";
const UNIVERSE = (
  load("watchlist-Computer-GPU.json").tickers as Array<{
    ticker: string;
  }>
).map((row) => row.ticker);

const openDaysBetween = (from: string, to: string): number => {
  if (to === from) return 0;
  const forward = to > from;
  const [a, b] = forward ? [from, to] : [to, from];
  const cursor = new Date(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  let count = 0;
  while (cursor.getTime() < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return forward ? count : -count;
};

const inputs = (over: Partial<ChannelInputs> = {}): ChannelInputs => ({
  macro,
  policy,
  gex,
  tide,
  spot,
  day: DAY,
  openCalls: 0,
  ...over,
});

const focusInputs = (over: Partial<FocusInputs> = {}): FocusInputs => ({
  day: DAY,
  universe: UNIVERSE,
  pinned: ["NVDA"],
  themes: [],
  pins: [],
  openDaysBetween,
  ...over,
});

function scratch(): { stateRoot: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "ow-frame-"));
  return {
    stateRoot: join(root, "state"),
    env: { HELIUM_AUDIT_DB: join(root, "audit.db") },
  };
}

/** Twenty stored move rows for every channel, at one magnitude. */
function seedMoves(env: NodeJS.ProcessEnv, value: number): string[] {
  const store = new AuditStore(env.HELIUM_AUDIT_DB!);
  const days: string[] = [];
  try {
    for (let i = 0; i < MIN_HISTORY; i += 1) {
      const day = `2026-08-${String(i + 1).padStart(2, "0")}`;
      days.push(day);
      for (const name of Object.values(MOVE_METRIC))
        store.appendMetric({
          runId: `run-${day}-${name}`,
          name,
          value,
          ts: `${day}T20:15:00.000Z`,
          day,
          label: "close",
        });
    }
  } finally {
    store.close();
  }
  return days;
}

const frameOf = (over: {
  stateRoot: string;
  env: NodeJS.ProcessEnv;
  days?: string[];
  inputs?: ChannelInputs;
  focusInputs?: FocusInputs;
  skipped?: Record<string, string>;
  label?: string;
}) =>
  buildFrame({
    inputs: over.inputs ?? inputs(),
    focusInputs: over.focusInputs ?? focusInputs(),
    days: over.days ?? [],
    stateRoot: over.stateRoot,
    label: over.label ?? "live",
    review,
    ...(over.skipped === undefined ? {} : { skipped: over.skipped }),
    env: over.env,
  });

describe("buildFrame", () => {
  it("marks itself by shape and prints every declared row", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    expect(frame.kind).toBe(SESSION_FRAME_KIND);
    expect(frame.day).toBe(DAY);
    expect(frame.rows.length).toBe(expectedRows);
    expect(
      frame.rows.map((row) => row.id).slice(0, review.coverage.length),
    ).toEqual(review.coverage);
    expect(frame.declared.coverage).toEqual(review.coverage);
    expect(frame.caps.weekly).toEqual(review.caps.weekly);
  });

  it("ranks on a ratio when the medians are small", () => {
    const { stateRoot, env } = scratch();
    const days = seedMoves(env, 0.05);
    expect(frameOf({ stateRoot, env, days }).mode).toBe("ratio");
  });

  it("falls back to persistence when the medians are large", () => {
    const { stateRoot, env } = scratch();
    const days = seedMoves(env, 500);
    expect(frameOf({ stateRoot, env, days }).mode).toBe("persistence");
  });

  it("names one source per layer and copies its own as-of", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    expect(frame.coverage.map((row) => row.layer)).toContain("macro");
    const gexRow = frame.coverage.find((row) => row.layer === "gex");
    // The recorded gex payload is an `{unavailable: "as-of"}` exclusion.
    expect(gexRow?.state).toBe("skipped");
    expect(gexRow?.source).toBe("ow_uw_gex");
    const spotRow = frame.coverage.find((row) => row.layer === "spot");
    expect(spotRow?.state).toBe("ok");
    expect(spotRow?.asOf).toBe(spot.fetchedAt);
  });

  it("says so when there are no prior checks", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    expect(frame.checks.line).toBe("Yesterday: no prior checks.");
    expect(frame.checks.scored).toEqual([]);
    expect(frame.checks.from).toBeUndefined();
  });

  it("scores the prior record's three checks", () => {
    const { stateRoot, env } = scratch();
    const dir = join(stateRoot, "option-wizard", "2026-09-02");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "close.regime.json"),
      JSON.stringify({
        cause: "the long end led",
        tide: "up",
        thesis: "duration is the swing factor into the meeting",
        checks: [
          // DGS10 in the recorded macro payload reads 4.79 on 2026-09-02.
          { series: "DGS10", level: "4.79", text: "10Y holds its level" },
          { series: "DGS2", level: "4.34", text: "front end holds" },
          { series: "NOT_A_SERIES", level: "1", text: "nothing carries this" },
        ],
      }),
      "utf8",
    );
    const frame = frameOf({ stateRoot, env });
    expect(frame.checks.from).toEqual({ day: "2026-09-02", label: "close" });
    expect(frame.checks.scored.length).toBe(3);
    expect(
      frame.checks.scored.find((row) => row.series === "NOT_A_SERIES")?.verdict,
    ).toBe("not-observed");
    expect(frame.checks.line.startsWith("Yesterday:")).toBe(true);
  });

  it("echoes the ledger it was given", () => {
    const { stateRoot, env } = scratch();
    appendLedger(stateRoot, "option-wizard", [
      {
        kind: "commitment",
        commitment: {
          id: "2026-09-01-close-spy-t5",
          runId: "run-a",
          tenant: "option-wizard",
          issuedAt: "2026-09-01T20:15:00.000Z",
          deployment: "test",
          variant: "live",
          payload: { kind: "spy-direction", symbol: "SPY", pDown: 0.45 },
        },
      },
      {
        kind: "commitment",
        commitment: {
          id: "2026-09-02-close-spy-t1",
          runId: "run-b",
          tenant: "option-wizard",
          issuedAt: "2026-09-02T20:15:00.000Z",
          deployment: "test",
          variant: "live",
          payload: { kind: "spy-direction", symbol: "SPY", pDown: 0.52 },
        },
      },
      {
        kind: "receipt",
        receipt: {
          commitmentId: "2026-09-02-close-spy-t1",
          runId: "run-c",
          settledAt: `${DAY}T13:00:00.000Z`,
          status: "hit",
          scores: { brier: 0.2304 },
        },
      },
    ]);
    const frame = frameOf({ stateRoot, env });
    expect(frame.ledger.totalCommitments).toBe(2);
    expect(frame.ledger.firstCommitmentDay).toBe("2026-09-01");
    expect(frame.ledger.open.map((row) => row.id)).toEqual([
      "2026-09-01-close-spy-t5",
    ]);
    expect(frame.ledger.open[0]?.issuedPhase).toBe("close");
    expect(frame.ledger.settledToday.map((row) => row.id)).toEqual([
      "2026-09-02-close-spy-t1",
    ]);
    expect(frame.ledger.settledToday[0]?.scores.brier).toBe(0.2304);
    expect(frame.ledger.unavailable).toBeUndefined();
  });

  it("does not throw when there is no ledger at all", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    expect(frame.ledger.open).toEqual([]);
    expect(frame.ledger.totalCommitments).toBe(0);
    expect(frame.ledger.unavailable).toContain("no ledger");
  });

  it("carries both focus lists and says the weights were declared", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    const weekly = review.focus!.weekly;
    const daily = review.focus!.daily;
    expect(frame.focus.weekly.length).toBe(Math.min(weekly, UNIVERSE.length));
    expect(frame.focus.daily.length).toBe(
      Math.min(daily, frame.focus.weekly.length),
    );
    expect(frame.focus.weightsNote).toBe("weights: declared prior 2026-09-06");
    expect(frame.focus.churn).toBe(0);
  });

  it("keeps the focus list when a feed did not answer, and names the gap", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({
      stateRoot,
      env,
      skipped: { earnings: "ow_uw_earnings: no ticker answered" },
    });
    expect(frame.focus.weekly.length).toBeGreaterThan(0);
    const row = frame.coverage.find((entry) => entry.layer === "earnings");
    expect(row?.state).toBe("skipped");
    expect(row?.reason).toContain("no ticker answered");
  });

  it("survives an unconfigured ow_massive_actions with no corporate points", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({
      stateRoot,
      env,
      skipped: { actions: "ow_massive_actions: MASSIVE_API_KEY is unset" },
    });
    const row = frame.coverage.find((entry) => entry.layer === "actions");
    expect(row?.state).toBe("skipped");
    expect(row?.reason).toContain("MASSIVE_API_KEY");
    for (const focusRow of frame.focus.weekly)
      for (const part of focusRow.parts)
        expect(["corporate", "assignmentRisk"]).not.toContain(part.kind);
    expect(frame.rows.length).toBe(expectedRows);
  });
});

describe("frameFrom", () => {
  const report = (outputs: string[]): RunReport =>
    ({
      steps: [
        {
          id: "frame",
          role: "frame-clerk",
          mode: "deterministic",
          text: "",
          toolOutputs: outputs,
        },
      ],
    }) as unknown as RunReport;

  it("finds the payload by shape", () => {
    const { stateRoot, env } = scratch();
    const frame = frameOf({ stateRoot, env });
    const found = frameFrom(report(['{"other":1}', JSON.stringify(frame)]));
    expect(found?.kind).toBe(SESSION_FRAME_KIND);
    expect(found?.rows.length).toBe(expectedRows);
  });

  it("returns null when the step did not run", () => {
    expect(frameFrom(report(['{"other":1}', "not json"]))).toBeNull();
  });
});

describe("frameFrom reads both places the runner puts a tool result", () => {
  // THE 2026-09-06 ACCEPTANCE DEFECT. `packages/cli/src/runner.ts` pushes a
  // DETERMINISTIC step's report row without `toolOutputs`; the results live in
  // `step.text`, one `<toolName> -> <json>` line per call. The frame step ran,
  // ow_session_frame answered, and the renderer saw nothing — so the weekly
  // reached argon with no review sections and an empty masthead.
  const payload = JSON.stringify({ kind: SESSION_FRAME_KIND, day: "2026-09-06" });

  it("finds the payload in a model step's toolOutputs", () => {
    const report = {
      steps: [{ task: "frame", role: "frame-clerk", mode: "model", text: "", toolOutputs: [payload] }],
    } as never;
    expect(frameFrom(report)?.day).toBe("2026-09-06");
  });

  it("finds the payload in a deterministic step's own text", () => {
    const report = {
      steps: [
        {
          task: "frame",
          role: "frame-clerk",
          mode: "deterministic",
          text: `ow_session_frame -> ${payload}`,
        },
      ],
    } as never;
    expect(frameFrom(report)?.day).toBe("2026-09-06");
  });

  it("ignores a line that is prose with an arrow in it", () => {
    const report = {
      steps: [
        { task: "x", role: "r", mode: "deterministic", text: "the 10Y -> 4.79 today" },
      ],
    } as never;
    expect(frameFrom(report)).toBe(null);
  });
});

describe("attachThresholds — §G.5's scoring bar", () => {
  const row = (ticker: string, day?: string) =>
    ({
      ticker,
      score: 1,
      parts: [],
      daysToNearestEvent: 1,
      ...(day === undefined
        ? {}
        : {
            nearest: {
              ticker,
              kind: "earnings" as const,
              day,
              sessionsAway: 1,
              source: "ow_uw_earnings",
              label: "earnings",
            },
          }),
      openCallIds: [],
      themes: [],
    }) as never;

  const frameWith = (rows: unknown[]) =>
    ({ focus: { weekly: rows, daily: [] } }) as never;

  it("takes the nearest listed expiry at or after the event day", () => {
    const frame = frameWith([row("NVDA", "2026-11-18")]);
    attachThresholds(frame, {
      rows: [
        // A pre-event expiry cannot cover the event and is skipped.
        { ticker: "NVDA", expiry: "2026-11-14", dte: 2, implied_move_perc: 0.031 },
        { ticker: "NVDA", expiry: "2026-11-20", dte: 5, implied_move_perc: 0.046 },
        { ticker: "NVDA", expiry: "2026-12-19", dte: 34, implied_move_perc: 0.092 },
      ],
    });
    const attached = (frame as unknown as { focus: { weekly: Array<{ threshold?: { pct: number; source: string } }> } })
      .focus.weekly[0]!.threshold;
    // 0.046 is UW's FRACTION; the threshold is a percent, so 4.6.
    expect(attached?.pct).toBe(4.6);
    expect(attached?.source).toContain("ow_uw_iv_term implied_move_perc");
    expect(attached?.source).toContain("2026-11-20");
  });

  it("falls back to the realized median and names the substitution", () => {
    const frame = frameWith([row("AVGO", "2026-11-18")]);
    attachThresholds(frame, { rows: [] }, new Map([["AVGO", 2.4]]));
    const attached = (frame as unknown as { focus: { weekly: Array<{ threshold?: { pct: number; source: string } }> } })
      .focus.weekly[0]!.threshold;
    expect(attached?.pct).toBe(2.4);
    expect(attached?.source).toContain("ow_apex_bars");
  });

  it("leaves a name with neither source alone — it prints and mints nothing", () => {
    const frame = frameWith([row("XYZW", "2026-11-18")]);
    attachThresholds(frame, { rows: [] });
    expect(
      (frame as unknown as { focus: { weekly: Array<{ threshold?: unknown }> } })
        .focus.weekly[0]!.threshold,
    ).toBeUndefined();
  });
});

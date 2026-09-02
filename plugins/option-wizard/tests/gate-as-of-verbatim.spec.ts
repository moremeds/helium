/**
 * The `as-of-verbatim` output gate.
 *
 * The fixtures are the real 2026-09-02 intraday failure, not invented ones:
 * Unusual Whales returned `2026-09-02T12:45:00-04:00` with $48.67M of net call
 * premium, and the briefing wrote a clock four hours off. A timestamp is
 * either a verbatim substring of a tool output or it was computed — and
 * computing one is the bug.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-as-of-verbatim
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/as-of-verbatim.js";

const ctx = { runId: "run-1", role: "regime-analyst" };

describe("as-of-verbatim", () => {
  it("passes when the timestamp is verbatim in a tool output", async () => {
    const result = await gate.check(
      { text: "tide last print 2026-09-02T12:45:00-04:00, +$48.67M" },
      {
        ...ctx,
        toolOutputs: [
          '{"timestamp":"2026-09-02T12:45:00-04:00","net_call_premium":48670000}',
        ],
      },
    );
    expect(result.pass).toBe(true);
  });

  it("fails the four-hour shift that shipped on 2026-09-02", async () => {
    const result = await gate.check(
      { text: "tide into 2026-09-02T16:45:00-04:00" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T16:45:00Z"}'] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("2026-09-02T16:45:00-04:00");
  });

  it("passes text with no zoned timestamp", async () => {
    const result = await gate.check(
      { text: "the 2026-09-02 session carries no clock in this line" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00-04:00"}'] },
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("no explicit timestamp");
  });

  it("fails a timestamp when no tool ran at all", async () => {
    const result = await gate.check(
      { text: "tide last print 2026-09-02T12:45:00-04:00" },
      { ...ctx, toolOutputs: [] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("no tool output in this run");
  });
});

it("accepts a timestamp whose only difference is dropped fractional seconds", async () => {
  // TradingView returned `.075Z`; the briefing's prose wrote the same instant
  // without the milliseconds. Same zone, same second — not the bug this gate
  // exists for. Real strings from the 2026-09-02 close run.
  await expect(
    gate.check(
      { text: "rates fetched 2026-09-02T18:40:17Z" },
      {
        ...ctx,
        toolOutputs: ['{"fetchedAt":"2026-09-02T18:40:17.075Z"}'],
      },
    ),
  ).resolves.toMatchObject({ pass: true });
});

it("still refuses a converted zone even when fractions are dropped", async () => {
  await expect(
    gate.check(
      { text: "as of 2026-09-02T16:45:00Z" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00.000000-04:00"}'] },
    ),
  ).resolves.toMatchObject({ pass: false });
});

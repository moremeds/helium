/**
 * Guarded-cron-step coverage. `apply()` itself needs a full cordis `Context`
 * and is exercised via the contract suite / live smoke, not unit tests; this
 * file covers only the small pure helper the synthesis cron's `jsonl.prune()`
 * step is guarded by (fix round 1: an unguarded sync throw there — e.g. a
 * transient FS failure — would otherwise be an unhandled rejection that
 * takes the whole daemon down, since croner@10.0.1 has no `catch` option for
 * a plain sync `Cron(...)` callback).
 * @module dsh-plugin-helium/index.test
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuarded, seniorOutcome } from "./index.js";

describe("runGuarded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the function through to completion", () => {
    let called = false;
    expect(() => {
      runGuarded("x", () => {
        called = true;
      });
    }).not.toThrow();
    expect(called).toBe(true);
  });

  it("catches a throw, logs it under the given label, and never rethrows", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("disk full");
    expect(() => {
      runGuarded("helium.prune", () => {
        throw error;
      });
    }).not.toThrow();
    expect(spy).toHaveBeenCalledWith("helium.prune:", error);
  });
});

describe("seniorOutcome", () => {
  it("reports a quota-exhausted run under its own label with the reset hint, not as a plain error", () => {
    const out = seniorOutcome({
      ok: false,
      classification: "quota-exhausted",
      retryAfter: "2026-08-29T18:00:00Z",
      text: "Claude AI usage limit reached",
    });
    expect(out.outcome).toBe("run_failed");
    expect(out.error).toContain("quota-exhausted");
    expect(out.error).toContain("2026-08-29T18:00:00Z");
  });

  it("omits the reset hint when the provider gave none, rather than inventing one", () => {
    const out = seniorOutcome({ ok: false, classification: "quota-exhausted" });
    expect(out.error).toBe("quota-exhausted");
  });

  it("keeps the completed, timed-out and generic-failure mappings unchanged", () => {
    expect(seniorOutcome({ ok: true, text: "analysis" })).toEqual({
      outcome: "run_completed",
      analysis: "analysis",
    });
    expect(seniorOutcome({ ok: false, classification: "timeout" })).toEqual({
      outcome: "timed_out",
      error: "senior lane exceeded its wall clock",
    });
    expect(
      seniorOutcome({ ok: false, classification: "proxy", text: "tunnel down" }),
    ).toEqual({ outcome: "run_failed", error: "proxy: tunnel down" });
  });
});

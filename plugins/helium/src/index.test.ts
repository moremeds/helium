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
import { runGuarded } from "./index.js";

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

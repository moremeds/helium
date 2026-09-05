/**
 * `helium run` flags. `--replay-from` names the run whose recordings serve
 * this one's live-only tools.
 * @module @helium/cli/args.test
 */
import { describe, expect, it } from "vitest";
import { parseRunArgs } from "./args.js";

describe("--replay-from", () => {
  it("is absent by default", () => {
    expect(parseRunArgs([])).toEqual({ phase: "premarket", variant: "live" });
  });

  it("carries the run id", () => {
    expect(
      parseRunArgs([
        "--as-of",
        "2026-09-03T17:00:00Z",
        "--replay-from",
        "run-abc",
      ]),
    ).toMatchObject({ replayFrom: "run-abc" });
  });

  it("refuses a run id that could climb out of the state root", () => {
    // The value becomes a path segment under <stateRoot>/runs.
    expect(parseRunArgs(["--replay-from", "../../etc"])).toEqual({
      error: "--replay-from is not a run id: ../../etc",
    });
    expect(parseRunArgs(["--replay-from", "a/b"])).toEqual({
      error: "--replay-from is not a run id: a/b",
    });
  });

  it("refuses a missing value", () => {
    expect(parseRunArgs(["--replay-from"])).toEqual({
      error: "--replay-from needs a run id, e.g. --replay-from run-abc123",
    });
  });
});

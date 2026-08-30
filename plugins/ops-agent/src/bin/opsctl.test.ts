import { describe, expect, it } from "vitest";
import { parseOpsctlArgs } from "./opsctl.js";

describe("opsctl arguments", () => {
  it.each(["approve", "record-intervention"] as const)(
    "accepts only an envelope submission for %s",
    (command) => {
      expect(
        parseOpsctlArgs([
          command,
          "--socket",
          "/tmp/opsd.sock",
          "--envelope",
          "/tmp/envelope.json",
        ]),
      ).toEqual({
        command,
        socketPath: "/tmp/opsd.sock",
        envelopePath: "/tmp/envelope.json",
      });
    },
  );

  it.each(["execute", "run", "reload-manifest", "write-event"])(
    "has no %s command",
    (command) => {
      expect(() =>
        parseOpsctlArgs([
          command,
          "--socket",
          "/tmp/opsd.sock",
          "--envelope",
          "/tmp/envelope.json",
        ]),
      ).toThrow(/unknown opsctl command/);
    },
  );

  it("rejects missing and duplicate flags", () => {
    expect(() => parseOpsctlArgs(["approve"])).toThrow(/requires/);
    expect(() =>
      parseOpsctlArgs([
        "approve",
        "--socket",
        "a",
        "--socket",
        "b",
        "--envelope",
        "c",
      ]),
    ).toThrow(/duplicate/);
  });
});

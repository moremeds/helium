import { describe, expect, it } from "vitest";
import { meetsThreshold, parseVerdict } from "../src/verdict.js";

describe("parseVerdict", () => {
  it("reads the last JSON object in the reply", () => {
    const text = [
      'Some prose. {"escalate": false, "severity": "noise", "reason": "warmup"}',
      "Final answer:",
      '{"escalate": true, "severity": "material", "reason": "regime flipped to easing"}',
    ].join("\n");
    expect(parseVerdict(text)).toEqual({
      escalate: true,
      severity: "material",
      reason: "regime flipped to easing",
    });
  });

  it("reads a fenced verdict", () => {
    const text =
      '```json\n{"escalate": false, "severity": "minor", "reason": "noise"}\n```';
    expect(parseVerdict(text)?.severity).toBe("minor");
  });

  it("ignores braces inside strings", () => {
    const text =
      '{"escalate": false, "severity": "noise", "reason": "saw {not json} here"}';
    expect(parseVerdict(text)?.reason).toBe("saw {not json} here");
  });

  it("returns null for prose, malformed JSON and an unknown severity", () => {
    expect(parseVerdict("I think you should escalate this.")).toBeNull();
    expect(parseVerdict('{"escalate": true, "severity":}')).toBeNull();
    expect(
      parseVerdict('{"escalate": true, "severity": "urgent", "reason": "x"}'),
    ).toBeNull();
  });
});

describe("meetsThreshold", () => {
  const v = (severity: string, escalate: boolean) =>
    ({ escalate, severity, reason: "r" }) as never;

  it("escalates at and above the job threshold", () => {
    expect(meetsThreshold(v("material", true), "material")).toBe(true);
    expect(meetsThreshold(v("critical", true), "material")).toBe(true);
  });

  it("does not escalate below the threshold even when the model asked for it", () => {
    expect(meetsThreshold(v("minor", true), "material")).toBe(false);
  });

  it("escalates on severity alone — the gate disposes, not the model", () => {
    expect(meetsThreshold(v("critical", false), "material")).toBe(true);
  });
});

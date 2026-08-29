import { describe, expect, it } from "vitest";
import { decideRuntimeMode, OpsModeSchema } from "./mode.js";

describe("Ops runtime mode", () => {
  it.each(["observe", "suggest", "approve", "auto"])(
    "parses the declared %s mode",
    (mode) => {
      expect(OpsModeSchema.parse(mode)).toBe(mode);
    },
  );

  it("observe records only; suggest may propose but neither may execute", () => {
    expect(
      decideRuntimeMode({
        mode: "observe",
        authority: "auto",
        eligible: true,
        approved: false,
      }),
    ).toEqual({ disposition: "observe", reason: "runtime-observe" });
    expect(
      decideRuntimeMode({
        mode: "suggest",
        authority: "auto",
        eligible: true,
        approved: false,
      }),
    ).toEqual({ disposition: "propose" });
  });

  it("approve mode executes only after a matching approval", () => {
    expect(
      decideRuntimeMode({
        mode: "approve",
        authority: "approve",
        eligible: true,
        approved: false,
      }),
    ).toEqual({ disposition: "propose", reason: "approval-required" });
    expect(
      decideRuntimeMode({
        mode: "approve",
        authority: "approve",
        eligible: true,
        approved: true,
      }),
    ).toEqual({ disposition: "execute" });
  });

  it("auto mode never elevates an approve SOP into automatic execution", () => {
    expect(
      decideRuntimeMode({
        mode: "auto",
        authority: "approve",
        eligible: true,
        approved: false,
      }),
    ).toEqual({ disposition: "propose", reason: "approval-required" });
    expect(
      decideRuntimeMode({
        mode: "auto",
        authority: "approve",
        eligible: true,
        approved: true,
      }),
    ).toEqual({ disposition: "execute" });
    expect(
      decideRuntimeMode({
        mode: "auto",
        authority: "auto",
        eligible: true,
        approved: false,
      }),
    ).toEqual({ disposition: "execute" });
  });

  it.each(["observe", "forbidden"] as const)(
    "never elevates configured %s authority in any runtime mode",
    (authority) => {
      for (const mode of ["observe", "suggest", "approve", "auto"] as const) {
        expect(
          decideRuntimeMode({
            mode,
            authority,
            eligible: true,
            approved: true,
          }).disposition,
        ).toBe("observe");
      }
    },
  );

  it("holds every ineligible SOP without proposing or executing", () => {
    expect(
      decideRuntimeMode({
        mode: "auto",
        authority: "auto",
        eligible: false,
        approved: true,
      }),
    ).toEqual({ disposition: "observe", reason: "policy-ineligible" });
  });
});

/**
 * The advisory gate that tells the reader the regime record did not survive.
 * Advisory for the same reason flash-budget and meta-leak are: a brief with no
 * state record is still a brief worth sending.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-regime-state
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/regime-state.js";

const ctx = { runId: "run-1", role: "editor" } as never;
const BLOCK =
  '```regime-state\n{"cause":"August payrolls printed 162k","ust2y":4.02,' +
  '"ust10y":4.79,"s2s10":77,"tide":"up","thesis":"No cut to give."}\n```';

describe("regime-state gate", () => {
  it("is advisory, output-phase, and guards the one step that writes it", () => {
    expect(gate.id).toBe("regime-state");
    expect(gate.phase).toBe("output");
    expect(gate.advisory).toBe(true);
    // The EDITOR now writes the record: `liftState` runs on every step and a
    // later fence overwrites an earlier one, so exactly one step may emit the
    // block and it must be the last one that knows the three checks.
    expect(gate.appliesTo).toEqual(["editor"]);
  });

  it("passes a step that ends with a valid block", async () => {
    const result = await gate.check(
      { text: `{"headline":"h","sections":[]}\n\n${BLOCK}` },
      ctx,
    );
    expect(result.pass).toBe(true);
  });

  it("refuses with `regime-state: missing` when there is no block", async () => {
    const result = await gate.check(
      { text: '{"headline":"h","sections":[]}' },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("regime-state: missing (no block)");
  });

  it("refuses with `regime-state: missing` and the reason when it is malformed", async () => {
    const result = await gate.check(
      { text: '```regime-state\n{"cause":"x","tide":"sideways"}\n```' },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("regime-state: missing");
    expect(result.reason).toContain("tide");
  });

  it("refuses when the block is not JSON at all", async () => {
    const result = await gate.check(
      { text: "```regime-state\nnot json\n```" },
      ctx,
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("regime-state: missing");
  });
});

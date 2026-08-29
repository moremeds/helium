import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as mutationOwner from "../src/operations/mutation-owner.js";
import type { ComponentSpec } from "../src/operations/component.js";
import {
  HANDOFF_STEPS,
  ROLLBACK_STEPS,
  applyHandoffStep,
  applyRollbackStep,
  canMutate,
  enabledCount,
  isOwnershipContradiction,
  sequenceStates,
  type ControllerProbeOutcome,
  type ControllerSet,
} from "../src/operations/mutation-owner.js";

const component = (
  owner: "opsd" | "external" | "none",
  competingLabels: string[] = [],
): ComponentSpec => ({
  version: 1,
  id: "runtime",
  kind: "container-runtime",
  mutationOwner: {
    owner,
    competingLabels,
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "artifact://ownership/1",
  },
});

const probe = (
  result: ControllerProbeOutcome["result"],
  observedLabels: string[] = [],
): ControllerProbeOutcome => ({
  result,
  observedLabels,
  evidenceRef: "artifact://raw-command/controller-fixture",
});

describe("canMutate", () => {
  it("permits only opsd ownership with a clear probe", () => {
    expect(canMutate(component("opsd"), probe("clear"))).toEqual({ ok: true });
  });

  // owner: "external" makes every mutating SOP behave as forbidden,
  // regardless of the authority the SOP claims for itself.
  it("refuses when another controller owns the component", () => {
    expect(canMutate(component("external"), probe("clear"))).toEqual({
      ok: false,
      reason: "external-owner",
    });
  });

  it("refuses when nobody has been given ownership", () => {
    expect(canMutate(component("none"), probe("clear"))).toEqual({
      ok: false,
      reason: "no-owner",
    });
  });

  it("refuses when a competing controller is loaded", () => {
    expect(canMutate(component("opsd"), probe("competing", ["other.job"]))).toEqual({
      ok: false,
      reason: "competing-controller",
    });
  });

  // Absence of evidence is not evidence of absence. A controller you cannot
  // see is not a controller that is absent.
  it("refuses when ownership cannot be verified at all", () => {
    expect(canMutate(component("opsd"), probe("unknown"))).toEqual({
      ok: false,
      reason: "ownership-unverifiable",
    });
  });

  it("refuses on every non-clear probe result, for every owner", () => {
    for (const owner of ["opsd", "external", "none"] as const) {
      for (const result of ["competing", "unknown"] as const) {
        expect(canMutate(component(owner), probe(result)).ok).toBe(false);
      }
    }
  });
});

describe("ownership contradiction", () => {
  it("flags a recorded opsd ownership contradicted by a competing probe", () => {
    expect(isOwnershipContradiction(component("opsd"), probe("competing"))).toBe(true);
  });

  it("is not a contradiction when we never claimed ownership", () => {
    expect(isOwnershipContradiction(component("external"), probe("competing"))).toBe(
      false,
    );
  });

  // Unloading the other controller would be a mutation performed to make a
  // mutation legal, by a controller just shown not to have exclusive
  // ownership. The contradiction raises an incident; it never self-resolves.
  it("offers no way to resolve itself: the module exports nothing that unloads", () => {
    // Asserted against the real module namespace, not an empty object: the
    // point is that no escape hatch exists, and a test that inspects nothing
    // would report that forever.
    const exported = Object.keys(mutationOwner);
    expect(exported.length).toBeGreaterThan(5);
    for (const name of exported) {
      expect(name.toLowerCase(), `${name} looks like an escape hatch`).not.toMatch(
        /unload|disable|kill|stop|resolve/,
      );
    }
    expect(canMutate(component("opsd"), probe("competing")).ok).toBe(false);
  });
});

describe("handoff sequence", () => {
  const external: ControllerSet = { externalEnabled: true, opsdEnabled: false };

  it("never has two enabled controllers at ANY prefix", () => {
    const states = sequenceStates(external, HANDOFF_STEPS, applyHandoffStep);
    expect(states).toHaveLength(HANDOFF_STEPS.length + 1);
    for (const [i, state] of states.entries()) {
      expect(enabledCount(state), `prefix ${i}`).toBeLessThanOrEqual(1);
    }
  });

  // The crash invariant. Ownership is surrendered before it is claimed, so a
  // crash in the middle leaves the component monitored and non-mutating rather
  // than mutated by two controllers.
  it("leaves zero controllers if it crashes between disabling and enabling", () => {
    const states = sequenceStates(external, HANDOFF_STEPS, applyHandoffStep);
    // states[2] is after disable-external, states[3] after verify-quiescent.
    expect(enabledCount(states[2])).toBe(0);
    expect(enabledCount(states[3])).toBe(0);
  });

  it("ends with exactly one controller, and it is ours", () => {
    const states = sequenceStates(external, HANDOFF_STEPS, applyHandoffStep);
    const final = states.at(-1) as ControllerSet;
    expect(enabledCount(final)).toBe(1);
    expect(final).toEqual({ externalEnabled: false, opsdEnabled: true });
  });
});

describe("rollback sequence", () => {
  const ours: ControllerSet = { externalEnabled: false, opsdEnabled: true };

  it("never has two enabled controllers at ANY prefix", () => {
    for (const [i, state] of sequenceStates(ours, ROLLBACK_STEPS, applyRollbackStep).entries()) {
      expect(enabledCount(state), `prefix ${i}`).toBeLessThanOrEqual(1);
    }
  });

  it("ends with exactly one loaded controller, and it is the external one", () => {
    const final = sequenceStates(ours, ROLLBACK_STEPS, applyRollbackStep).at(
      -1,
    ) as ControllerSet;
    expect(enabledCount(final)).toBe(1);
    expect(final).toEqual({ externalEnabled: true, opsdEnabled: false });
  });

  it("passes through zero controllers rather than through two", () => {
    const states = sequenceStates(ours, ROLLBACK_STEPS, applyRollbackStep);
    expect(states.some((s) => enabledCount(s) === 0)).toBe(true);
    expect(states.every((s) => enabledCount(s) <= 1)).toBe(true);
  });
});

describe("core neutrality of this module", () => {
  it("names no host controller mechanism and no label", () => {
    // Enforced repo-wide by the neutrality contract; asserted here too because
    // this is the module most tempted to reach for a concrete label.
    const text = readFileSync(
      fileURLToPath(new URL("../src/operations/mutation-owner.ts", import.meta.url)),
      "utf8",
    ).toLowerCase();
    for (const token of ["launchctl", "launchd", "systemd", "com.helium", "com.local"]) {
      expect(text, `core must not name ${token}`).not.toContain(token);
    }
  });
});

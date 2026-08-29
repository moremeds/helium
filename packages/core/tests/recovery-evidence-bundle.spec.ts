import { describe, expect, it } from "vitest";
import {
  OPTIONAL_RECOVERY_FIELDS,
  RecoveryEvidenceSchema,
} from "../src/operations/recovery-evidence.js";

const digest = `sha256:${"a".repeat(64)}`;
const hash = "b".repeat(64);

const bundle = () => ({
  assertionId: "recovery-runtime-1",
  componentId: "runtime",
  incidentId: "inc-1",
  observations: [{ ref: "artifact://obs/1", sha256: hash }],
  incidentSnapshot: { ref: "artifact://incident/1", sha256: hash },
  sopId: "restart",
  sopVersion: 1,
  sopDigest: digest,
  authorityManifestEntry: {
    sopId: "restart",
    version: 1,
    digest,
    authority: "auto" as const,
  },
  authority: "auto" as const,
  eligibility: { eligible: true, reasons: [] },
  mutationOwner: {
    owner: "opsd" as const,
    competingLabels: [],
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "artifact://ownership/1",
  },
  controllerProbe: { result: "clear" as const, observedLabels: ["own.label"] },
  lease: { leaseId: "lease-1", operationId: "op-1" },
  intent: {
    actionId: "act-1",
    argv: ["--restart"],
    baseline: {
      capturedAt: "2026-08-25T04:00:00.000Z",
      allPassing: false,
      sampleCount: 2,
    },
  },
  receipt: { exitCode: 0, timedOut: false, outputDigest: digest },
  postconditionSamples: [
    { checkId: "runtime-up", state: "pass" as const, observedAt: "2026-08-25T04:05:00.000Z" },
  ],
  outcome: "succeeded" as const,
  attribution: "automatic" as const,
  verifier: {
    identity: "postcondition-set",
    version: "verify/1",
    decision: "pass" as const,
  },
  replayRef: "artifact://drill/1",
  status: "PROVEN" as const,
  limitation: "Proven against a drill, not a production incident.",
});

describe("RecoveryEvidenceSchema", () => {
  it("accepts a complete recovery bundle", () => {
    expect(RecoveryEvidenceSchema.parse(bundle()).outcome).toBe("succeeded");
  });

  it.each([
    "observations",
    "incidentSnapshot",
    "sopDigest",
    "authorityManifestEntry",
    "mutationOwner",
    "controllerProbe",
    "postconditionSamples",
    "verifier",
    "replayRef",
    "status",
  ])("refuses a bundle missing %s", (field) => {
    const { [field]: _drop, ...without } = bundle() as Record<string, unknown>;
    expect(() => RecoveryEvidenceSchema.parse(without)).toThrow();
  });

  // Absent evidence is declared, never fabricated. A not-needed or operator
  // outcome legitimately has no receipt -- but the bundle must say so, rather
  // than omitting the field and letting a reader assume it was checked.
  it.each(OPTIONAL_RECOVERY_FIELDS)(
    "refuses to omit %s without stating why",
    (field) => {
      const { [field]: _drop, ...without } = bundle() as Record<string, unknown>;
      expect(() => RecoveryEvidenceSchema.parse(without)).toThrow(
        /notApplicableReason/,
      );
    },
  );

  it("accepts an omitted field that states its reason", () => {
    const { intent: _i, receipt: _r, lease: _l, ...base } = bundle();
    const parsed = RecoveryEvidenceSchema.parse({
      ...base,
      outcome: "not-needed",
      attribution: undefined,
      notApplicable: {
        intent: "baseline already satisfied every postcondition; nothing was spawned",
        receipt: "no script ran",
        lease: "no mutation was attempted",
      },
    });
    expect(parsed.outcome).toBe("not-needed");
  });

  it("refuses a succeeded outcome with no receipt", () => {
    const { receipt: _drop, ...without } = bundle();
    expect(() =>
      RecoveryEvidenceSchema.parse({
        ...without,
        notApplicable: { receipt: "claimed missing" },
      }),
    ).toThrow(/requires both an intent and a receipt/);
  });

  // The rule the whole baseline mechanism exists for.
  it("refuses a succeeded outcome whose baseline was already passing", () => {
    const b = bundle();
    expect(() =>
      RecoveryEvidenceSchema.parse({
        ...b,
        intent: { ...b.intent, baseline: { ...b.intent.baseline, allPassing: true } },
      }),
    ).toThrow(/at least one failing postcondition/);
  });

  it("refuses automatic attribution with no recorded intent", () => {
    const { intent: _drop, ...without } = bundle();
    expect(() =>
      RecoveryEvidenceSchema.parse({
        ...without,
        outcome: "uncertain",
        attribution: "automatic",
        notApplicable: { intent: "none recorded" },
      }),
    ).toThrow(/automatic attribution requires a recorded intent/);
  });

  it("reuses the canonical status vocabulary rather than defining one", () => {
    for (const status of ["PLANNED", "PARTIAL", "PROVEN", "FAILED", "BLOCKED"]) {
      expect(() =>
        RecoveryEvidenceSchema.parse({ ...bundle(), status }),
      ).not.toThrow();
    }
    expect(() =>
      RecoveryEvidenceSchema.parse({ ...bundle(), status: "RECOVERED" }),
    ).toThrow();
  });

  it("carries the controller probe result, so an ownership refusal is auditable", () => {
    const parsed = RecoveryEvidenceSchema.parse({
      ...bundle(),
      outcome: "not-needed",
      attribution: undefined,
      controllerProbe: { result: "competing", observedLabels: ["a", "b"] },
    });
    expect(parsed.controllerProbe.result).toBe("competing");
  });
});

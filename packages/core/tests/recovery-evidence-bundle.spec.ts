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
  rawArtifacts: [
    { ref: "artifact://raw-command/controller-1", sha256: hash },
    { ref: "artifact://baseline/1", sha256: hash },
    { ref: "artifact://baseline/2", sha256: hash },
    { ref: "artifact://postcondition/1", sha256: hash },
  ],
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
  controllerProbe: {
    result: "clear" as const,
    observedLabels: ["own.label"],
    evidenceRef: "artifact://raw-command/controller-1",
  },
  lease: { leaseId: "lease-1", operationId: "op-1" },
  baseline: {
    capturedAt: "2026-08-25T04:00:00.000Z",
    allPassing: false,
    samples: [
      { checkId: "runtime-up", state: "fail" as const, observedAt: "2026-08-25T04:00:00.000Z", evidenceRefs: ["artifact://baseline/1"] },
      { checkId: "runtime-ready", state: "fail" as const, observedAt: "2026-08-25T04:00:00.000Z", evidenceRefs: ["artifact://baseline/2"] },
    ],
  },
  intent: {
    actionId: "act-1",
    argv: ["--restart"],
  },
  receipt: {
    exitCode: 0,
    timedOut: false,
    outputDigest: digest,
    evidence: { ref: "artifact://receipt/1", sha256: hash },
  },
  postconditionSamples: [
    {
      checkId: "runtime-up",
      state: "pass" as const,
      observedAt: "2026-08-25T04:05:00.000Z",
      evidenceRefs: ["artifact://postcondition/1"],
    },
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

  it("binds scoped recovery intent to the exact immutable input artifact", () => {
    const scoped = {
      ...bundle(),
      intent: {
        ...bundle().intent,
        scopeId: `lws-${"1".repeat(32)}:sha256:${"2".repeat(64)}`,
        inputArtifacts: [{ ref: "artifact://sha256/manifest", sha256: hash }],
      },
    };
    expect(RecoveryEvidenceSchema.parse(scoped).intent).toMatchObject({
      scopeId: scoped.intent.scopeId,
      inputArtifacts: scoped.intent.inputArtifacts,
    });
    expect(() => RecoveryEvidenceSchema.parse({
      ...scoped,
      intent: { ...scoped.intent, inputArtifacts: undefined },
    })).toThrow(/requires both scopeId and inputArtifacts/);
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
      baseline: {
        ...base.baseline,
        allPassing: true,
        samples: base.baseline.samples.map((sample) => ({ ...sample, state: "pass" as const })),
      },
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
        baseline: { ...b.baseline, allPassing: true },
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

  it("refuses authority evidence that does not match the exact SOP grant", () => {
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      authorityManifestEntry: { ...bundle().authorityManifestEntry, sopId: "other" },
    })).toThrow(/authority manifest entry does not match/);
  });

  it("refuses an intent admitted under unsafe ownership or controller evidence", () => {
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      mutationOwner: { ...bundle().mutationOwner, owner: "external" },
    })).toThrow(/intent requires opsd mutation ownership/);
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      controllerProbe: { ...bundle().controllerProbe, result: "competing" },
    })).toThrow(/intent requires a clear controller probe/);
  });

  it("refuses a succeeded assertion whose process or postconditions did not pass", () => {
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      postconditionSamples: [{ ...bundle().postconditionSamples[0], state: "fail" }],
    })).toThrow(/passing postcondition/);
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      receipt: { ...bundle().receipt, exitCode: 1 },
    })).toThrow(/successful process receipt/);
  });

  it("binds a terminal outcome to its canonical status and verifier decision", () => {
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      outcome: "failed",
      status: "PROVEN",
      verifier: { ...bundle().verifier, decision: "pass" },
    })).toThrow(/failed outcome requires FAILED status and a failing verifier/);
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      outcome: "uncertain",
      status: "PROVEN",
      verifier: { ...bundle().verifier, decision: "pass" },
    })).toThrow(/uncertain outcome requires PARTIAL status and an inconclusive verifier/);
    expect(() => RecoveryEvidenceSchema.parse({
      ...bundle(),
      status: "FAILED",
      verifier: { ...bundle().verifier, decision: "fail" },
    })).toThrow(/proven recovery outcome requires PROVEN status and a passing verifier/);
    expect(() =>
      RecoveryEvidenceSchema.parse({ ...bundle(), status: "RECOVERED" }),
    ).toThrow();
  });

  it("carries the controller probe result, so an ownership refusal is auditable", () => {
    const { intent: _intent, receipt: _receipt, lease: _lease, ...withoutAction } = bundle();
    const parsed = RecoveryEvidenceSchema.parse({
      ...withoutAction,
      outcome: "not-needed",
      attribution: undefined,
      baseline: {
        ...withoutAction.baseline,
        allPassing: true,
        samples: withoutAction.baseline.samples.map((sample) => ({
          ...sample,
          state: "pass" as const,
        })),
      },
      notApplicable: {
        intent: "controller admission refused before intent",
        receipt: "no process was started",
        lease: "no mutation lease was retained",
      },
      controllerProbe: {
        result: "competing",
        observedLabels: ["a", "b"],
        evidenceRef: "artifact://raw-command/controller-2",
      },
    });
    expect(parsed.controllerProbe.result).toBe("competing");
    expect(parsed.controllerProbe.evidenceRef).toBe(
      "artifact://raw-command/controller-2",
    );
  });

  it("refuses a controller admission result with no raw evidence reference", () => {
    const { evidenceRef: _drop, ...controllerProbe } = bundle().controllerProbe;
    expect(() =>
      RecoveryEvidenceSchema.parse({ ...bundle(), controllerProbe }),
    ).toThrow();
  });
});

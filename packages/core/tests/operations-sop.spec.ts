import { describe, expect, it } from "vitest";
import {
  ACTION_OUTCOMES,
  ActionIntentSchema,
  admitIntent,
  assertOutcomeHandled,
  type ActionOutcome,
} from "../src/operations/action.js";
import { CheckRegistry, type CheckDefinition } from "../src/operations/check.js";
import {
  SOP_AUTHORITIES,
  SopDefinitionSchema,
  certifySop,
  type SopDefinition,
} from "../src/operations/sop.js";

const probes = ["fixture.coverage.v1", "fixture.liveness.v1"];
const checks: CheckDefinition[] = [
  {
    id: "coverage-fresh",
    kind: "business",
    probe: { probeId: "fixture.coverage.v1", args: {} },
    expect: { dimension: "freshness", operator: "lte", value: 1 },
    onUnavailable: "unknown",
    timeoutMs: 30_000,
    owner: "operator",
  },
  {
    id: "process-up",
    kind: "liveness",
    probe: { probeId: "fixture.liveness.v1", args: {} },
    expect: { dimension: "readiness", operator: "eq", value: true },
    onUnavailable: "unknown",
    timeoutMs: 30_000,
    owner: "operator",
  },
];
const registry = CheckRegistry.load(checks, probes);

const sop = (overrides: Partial<SopDefinition> = {}): SopDefinition =>
  SopDefinitionSchema.parse({
    version: 1,
    id: "repair-coverage",
    digest: `sha256:${"a".repeat(64)}`,
    componentId: "fixture-service",
    matches: { dimension: "integrity", failureClass: "failed" },
    authority: "approve",
    mutating: true,
    priority: 10,
    action: {
      executorId: "certified-script",
      executable: {
        path: "/opt/ops/repair-coverage.sh",
        identity: { kind: "sha256", value: "b".repeat(64) },
      },
      argvSchemaId: "repair-coverage-argv-v1",
      cwdId: "ops-workdir",
      environmentProfileId: "ops-minimal",
      timeoutMs: 120_000,
    },
    preconditions: ["process-up"],
    postconditions: ["coverage-fresh"],
    graceMs: 60_000,
    maxAttempts: 2,
    cooldownMs: 900_000,
    ...overrides,
  });

describe("SopDefinitionSchema", () => {
  it("admits exactly four authority levels", () => {
    expect([...SOP_AUTHORITIES]).toEqual([
      "observe",
      "auto",
      "approve",
      "forbidden",
    ]);
  });

  it("rejects a free-form command string anywhere in the action", () => {
    // Never represent a command as a string. The executable is a path plus a
    // pinned identity, and the arguments come from a registered argv schema.
    expect(() =>
      SopDefinitionSchema.parse({
        ...sop(),
        action: { ...sop().action, command: "bash -c 'repair || true'" },
      }),
    ).toThrow();
    expect(() =>
      SopDefinitionSchema.parse({ ...sop(), command: "rm -rf /tmp/x" }),
    ).toThrow();
  });

  it("requires at least one postcondition", () => {
    expect(() =>
      SopDefinitionSchema.parse({ ...sop(), postconditions: [] }),
    ).toThrow();
  });

  it("rejects a provider or model key", () => {
    expect(() =>
      SopDefinitionSchema.parse({ ...sop(), model: "forbidden" }),
    ).toThrow();
  });
});

describe("certifySop", () => {
  it("certifies a well-formed mutating SOP with a business postcondition", () => {
    expect(certifySop(sop(), registry)).toEqual({ certified: true, reasons: [] });
  });

  it("refuses an SOP naming a check the registry does not hold", () => {
    const result = certifySop(sop({ postconditions: ["ghost-check"] }), registry);
    expect(result.certified).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/ghost-check/);
  });

  // "The process came back" is exactly the evidence the audited integrity
  // failure would have passed while staying broken.
  it("refuses a mutating SOP whose only postcondition is process liveness", () => {
    const result = certifySop(sop({ postconditions: ["process-up"] }), registry);
    expect(result.certified).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/business/);
  });

  it("allows a non-mutating SOP to have only a liveness postcondition", () => {
    expect(
      certifySop(sop({ mutating: false, postconditions: ["process-up"] }), registry)
        .certified,
    ).toBe(true);
  });

  it("refuses auto authority without a pinned executable identity", () => {
    const unpinned = sop({ authority: "auto" });
    const result = certifySop(
      {
        ...unpinned,
        action: {
          ...unpinned.action,
          executable: { path: unpinned.action.executable.path },
        },
      } as SopDefinition,
      registry,
    );
    expect(result.certified).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/identity/);
  });

  it("allows approve authority without a pinned identity, but never auto", () => {
    const unpinned = sop({ authority: "approve" });
    expect(
      certifySop(
        {
          ...unpinned,
          action: {
            ...unpinned.action,
            executable: { path: unpinned.action.executable.path },
          },
        } as SopDefinition,
        registry,
      ).certified,
    ).toBe(true);
  });
});

describe("ActionOutcome", () => {
  it("is exactly the six values of the action plane, in order", () => {
    expect(ACTION_OUTCOMES).toEqual([
      "succeeded",
      "failed",
      "not-needed",
      "uncertain",
      "superseded-by-operator",
      "external-recovery",
    ]);
  });

  it("is disjoint from the incident plane", () => {
    // @ts-expect-error - an incident state is never an action outcome
    const notAnOutcome: ActionOutcome = "recovered";
    expect(ACTION_OUTCOMES).not.toContain(notAnOutcome);
    // @ts-expect-error - a policy refusal is not an outcome either
    const notEither: ActionOutcome = "rejected";
    expect(ACTION_OUTCOMES).not.toContain(notEither);
  });

  it("is exhaustively handled, so a seventh member fails typecheck", () => {
    function label(outcome: ActionOutcome): string {
      switch (outcome) {
        case "succeeded":
        case "failed":
        case "not-needed":
        case "uncertain":
        case "superseded-by-operator":
        case "external-recovery":
          return outcome;
        default:
          return assertOutcomeHandled(outcome);
      }
    }
    for (const outcome of ACTION_OUTCOMES) {
      expect(label(outcome)).toBe(outcome);
    }
  });
});

describe("ActionIntent", () => {
  const intent = {
    actionId: "act-1",
    incidentId: "inc-1",
    componentId: "fixture-service",
    sopId: "repair-coverage",
    sopVersion: 1,
    sopDigest: `sha256:${"a".repeat(64)}`,
    leaseId: "lease-1",
    mutationOwnerRef: "owner-1",
    baseline: {
      capturedAt: "2026-08-25T04:00:00.000Z",
      samples: [
        {
          checkId: "coverage-fresh",
          state: "fail" as const,
          observedAt: "2026-08-25T04:00:00.000Z",
          evidenceRefs: ["artifact://baseline/1"],
        },
      ],
      allPassing: false,
    },
    argv: ["--partition", "2026-08-24"],
    recordedAt: "2026-08-25T04:00:01.000Z",
  };

  it("requires a baseline; a write-ahead intent without one is invalid", () => {
    const { baseline: _drop, ...without } = intent;
    expect(() => ActionIntentSchema.parse(without)).toThrow();
  });

  it("parses a complete intent", () => {
    expect(ActionIntentSchema.parse(intent).actionId).toBe("act-1");
  });

  it("rejects a free-form command in place of argv", () => {
    expect(() =>
      ActionIntentSchema.parse({ ...intent, argv: "repair --all" }),
    ).toThrow();
  });

  // Without this, an operator fixing the component concurrently hands the
  // controller a free exit-0 plus passing postconditions, and the promotion
  // gate that exists to detect false automation credit is fed by exactly the
  // case it is meant to catch.
  it("terminates as not-needed, before execution, when the baseline already passes", () => {
    const decision = admitIntent(
      ActionIntentSchema.parse({
        ...intent,
        baseline: {
          ...intent.baseline,
          samples: [{ ...intent.baseline.samples[0], state: "pass" as const }],
          allPassing: true,
        },
      }),
    );
    expect(decision).toEqual({
      admit: false,
      outcome: "not-needed",
      reason: "baseline already satisfied every postcondition",
    });
  });

  it("admits an intent whose baseline shows real work to do", () => {
    expect(admitIntent(ActionIntentSchema.parse(intent))).toEqual({ admit: true });
  });

  it("refuses a baseline whose allPassing flag disagrees with its samples", () => {
    expect(() =>
      ActionIntentSchema.parse({
        ...intent,
        baseline: { ...intent.baseline, allPassing: true },
      }),
    ).toThrow(/allPassing/);
  });

  it("treats an unknown baseline sample as not passing", () => {
    const decision = admitIntent(
      ActionIntentSchema.parse({
        ...intent,
        baseline: {
          ...intent.baseline,
          samples: [{ ...intent.baseline.samples[0], state: "unknown" as const }],
          allPassing: false,
        },
      }),
    );
    expect(decision).toEqual({ admit: true });
  });
});

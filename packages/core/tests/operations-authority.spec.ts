import { describe, expect, it } from "vitest";
import {
  arbitrate,
  decideAuthority,
  disposition,
  type AuthorityInput,
} from "../src/operations/authority.js";
import type { Incident } from "../src/operations/incident.js";
import { SopDefinitionSchema, type SopDefinition } from "../src/operations/sop.js";

const now = new Date("2026-08-25T04:00:00.000Z");

const incident: Incident = {
  key: "fixture-service|integrity|failed|fixture-service",
  rootComponentId: "fixture-service",
  symptomComponentIds: [],
  dimension: "integrity",
  failureClass: "failed",
  state: "action-eligible",
  observationIds: ["obs-1"],
  openedAt: "2026-08-25T03:55:00.000Z",
  updatedAt: "2026-08-25T04:00:00.000Z",
};

const sop = (overrides: Partial<SopDefinition> = {}): SopDefinition =>
  SopDefinitionSchema.parse({
    version: 1,
    id: "repair-coverage",
    digest: `sha256:${"a".repeat(64)}`,
    componentId: "fixture-service",
    matches: { dimension: "integrity", failureClass: "failed" },
    authority: "auto",
    mutating: true,
    priority: 10,
    action: {
      executorId: "certified-script",
      executable: {
        path: "/opt/ops/repair.sh",
        identity: { kind: "sha256", value: "b".repeat(64) },
      },
      argvSchemaId: "repair-argv-v1",
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

const input = (overrides: Partial<AuthorityInput> = {}): AuthorityInput => ({
  sop: sop(),
  incident,
  checkResults: { "process-up": "pass" },
  history: [],
  now,
  ...overrides,
});

describe("decideAuthority", () => {
  it("admits a certified auto SOP against a matching action-eligible incident", () => {
    expect(decideAuthority(input())).toEqual({
      eligible: true,
      authority: "auto",
      reasons: [],
    });
  });

  it.each([
    ["forbidden", "authority-forbidden"],
    ["observe", "authority-observe"],
  ])("refuses %s authority outright", (authority, reason) => {
    const decision = decideAuthority(
      input({ sop: sop({ authority: authority as SopDefinition["authority"] }) }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it("refuses an incident that is not action-eligible", () => {
    const decision = decideAuthority(
      input({ incident: { ...incident, state: "open" } }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain("incident-not-action-eligible");
  });

  it.each([
    ["componentId", { componentId: "other-service" }, "component-mismatch"],
    [
      "dimension",
      { matches: { dimension: "readiness", failureClass: "failed" as const } },
      "dimension-mismatch",
    ],
    [
      "failure class",
      { matches: { dimension: "integrity", failureClass: "degraded" as const } },
      "failure-class-mismatch",
    ],
  ])("refuses an SOP whose %s does not match the incident", (_label, patch, reason) => {
    const decision = decideAuthority(input({ sop: sop(patch) }));
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  // Fail-closed: a precondition that could not be evaluated has not passed.
  it.each(["fail", "unknown"])("refuses when a precondition is %s", (state) => {
    const decision = decideAuthority(
      input({ checkResults: { "process-up": state as "fail" | "unknown" } }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/precondition/);
  });

  it("refuses when a precondition has no result at all", () => {
    const decision = decideAuthority(input({ checkResults: {} }));
    expect(decision.eligible).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/precondition/);
  });

  it("refuses once the attempt limit for this incident is reached", () => {
    const attempt = {
      sopId: "repair-coverage",
      incidentId: incident.key,
      at: "2026-08-25T02:00:00.000Z",
      outcome: "failed" as const,
    };
    const decision = decideAuthority(
      input({ history: [attempt, { ...attempt, at: "2026-08-25T02:30:00.000Z" }] }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain("max-attempts");
  });

  it("refuses inside the cooldown window and admits after it", () => {
    const recent = {
      sopId: "repair-coverage",
      incidentId: incident.key,
      at: "2026-08-25T03:55:00.000Z",
      outcome: "failed" as const,
    };
    expect(decideAuthority(input({ history: [recent] })).reasons).toContain(
      "cooldown",
    );
    expect(
      decideAuthority(
        input({ history: [{ ...recent, at: "2026-08-25T03:40:00.000Z" }] }),
      ).eligible,
    ).toBe(true);
  });

  it("refuses inside a maintenance window", () => {
    const decision = decideAuthority(
      input({
        maintenanceWindows: [
          { from: "2026-08-25T03:00:00.000Z", to: "2026-08-25T05:00:00.000Z" },
        ],
      }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain("maintenance-window");
  });

  it("counts a not-needed attempt as an attempt but never as automation credit", () => {
    // not-needed means the component was already healthy. It still consumes an
    // attempt -- otherwise a loop can retry forever -- but the promotion gate
    // must never read it as a success.
    const decision = decideAuthority(
      input({
        history: [
          {
            sopId: "repair-coverage",
            incidentId: incident.key,
            at: "2026-08-25T02:00:00.000Z",
            outcome: "not-needed",
          },
          {
            sopId: "repair-coverage",
            incidentId: incident.key,
            at: "2026-08-25T02:30:00.000Z",
            outcome: "not-needed",
          },
        ],
      }),
    );
    expect(decision.reasons).toContain("max-attempts");
  });
});

describe("approval", () => {
  const approveSop = sop({ authority: "approve" });

  it("requires an approval for approve authority", () => {
    const decision = decideAuthority(input({ sop: approveSop }));
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain("approval-missing");
  });

  it("admits a matching, unexpired approval", () => {
    const decision = decideAuthority(
      input({
        sop: approveSop,
        approval: {
          incidentId: incident.key,
          sopId: approveSop.id,
          sopVersion: approveSop.version,
          sopDigest: approveSop.digest,
          expiresAt: "2026-08-25T05:00:00.000Z",
        },
      }),
    );
    expect(decision).toEqual({ eligible: true, authority: "approve", reasons: [] });
    expect(disposition(decision)).toBe("approval-required");
  });

  it.each([
    ["a different incident", { incidentId: "other-incident" }, "approval-incident-mismatch"],
    ["a different SOP", { sopId: "other-sop" }, "approval-sop-mismatch"],
    ["an older SOP version", { sopVersion: 0 }, "approval-version-mismatch"],
    ["a different digest", { sopDigest: `sha256:${"c".repeat(64)}` }, "approval-digest-mismatch"],
    ["an expired window", { expiresAt: "2026-08-25T03:00:00.000Z" }, "approval-expired"],
  ])("refuses an approval for %s", (_label, patch, reason) => {
    const decision = decideAuthority(
      input({
        sop: approveSop,
        approval: {
          incidentId: incident.key,
          sopId: approveSop.id,
          sopVersion: approveSop.version,
          sopDigest: approveSop.digest,
          expiresAt: "2026-08-25T05:00:00.000Z",
          ...patch,
        },
      }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });
});

describe("disposition", () => {
  it("maps a decision onto the only three values the policy may return", () => {
    expect(disposition({ eligible: true, authority: "auto", reasons: [] })).toBe(
      "eligible",
    );
    expect(disposition({ eligible: true, authority: "approve", reasons: [] })).toBe(
      "approval-required",
    );
    expect(
      disposition({ eligible: false, authority: "auto", reasons: ["cooldown"] }),
    ).toBe("rejected");
  });
});

describe("arbitrate", () => {
  it("selects the higher priority SOP", () => {
    const low = sop({ id: "low", priority: 1 });
    const high = sop({ id: "high", priority: 9 });
    expect(arbitrate([low, high])).toEqual({ selected: high });
  });

  it("breaks a priority tie by match specificity, then by stable id", () => {
    const broad = sop({ id: "broad", priority: 5, exclusiveGroup: undefined });
    const narrow = sop({ id: "narrow", priority: 5, exclusiveGroup: "repair" });
    expect(arbitrate([narrow, broad]).selected?.id).toBe("narrow");
  });

  // Two equally ranked SOPs in one exclusive group is the case where guessing
  // would run the wrong repair. The controller must stop, not pick.
  it("returns ambiguous, selecting neither, for an equally ranked exclusive group", () => {
    const a = sop({ id: "repair-a", priority: 5, exclusiveGroup: "repair" });
    const b = sop({ id: "repair-b", priority: 5, exclusiveGroup: "repair" });
    const result = arbitrate([a, b]);
    expect(result.selected).toBeUndefined();
    expect(result.ambiguous).toEqual(["repair-a", "repair-b"]);
  });

  it("returns nothing for an empty candidate set", () => {
    expect(arbitrate([])).toEqual({ ambiguous: undefined, selected: undefined });
  });
});

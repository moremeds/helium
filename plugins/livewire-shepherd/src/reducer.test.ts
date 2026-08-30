import { describe, expect, it } from "vitest";
import {
  SHEPHERD_STATES,
  ShepherdStateSchema,
  createWorkUnit,
  type ShepherdWorkUnit,
} from "./work-unit.js";
import { reduceShepherd } from "./reducer.js";
import type { ShepherdEvent } from "./events.js";

const at = "2026-08-31T01:00:00.000Z";
let eventNumber = 0;

function identified(): ShepherdWorkUnit {
  return createWorkUnit({
    kind: "security-interval",
    securityId: "sec-apple",
    symbol: "AAPL",
    symbolValidFrom: "1980-12-12T00:00:00.000Z",
    dateFrom: "2026-08-28",
    dateTo: "2026-08-28",
    timeframe: "1d",
    layer: "bronze",
  });
}

function event<T extends ShepherdEvent>(value: Omit<T, "version" | "eventId" | "at">): T {
  eventNumber += 1;
  return {
    version: 1,
    eventId: `event-${eventNumber}`,
    at,
    ...value,
  } as T;
}

function discovered(unit = identified()): ShepherdEvent {
  return event({ type: "work-unit/discovered", payload: { unit } });
}

function transition(
  unit: ShepherdWorkUnit,
  expectedRevision: number,
  from: string,
  to: string,
): ShepherdEvent {
  return event({
    type: "work-unit/transitioned",
    payload: {
      workUnitId: unit.workUnitId,
      expectedRevision,
      revision: expectedRevision + 1,
      from,
      to,
      reason: "test",
    },
  } as Omit<Extract<ShepherdEvent, { type: "work-unit/transitioned" }>, "version" | "eventId" | "at">);
}

describe("Shepherd work-unit contracts", () => {
  it("represents unresolved identities and whole-market partitions without inventing a security", () => {
    const candidate = createWorkUnit({
      kind: "candidate-identity",
      candidateId: "candidate-wiki-bny",
      indexId: "sp500",
      observedSymbol: "BNY",
      sourceRevisionRefs: [{
        ref: "artifact://wikipedia/revision/123",
        hash: `sha256:${"a".repeat(64)}`,
      }],
    });
    const partition = createWorkUnit({
      kind: "market-partition",
      provider: "massive",
      assetClass: "equity",
      marketDate: "2026-08-28",
      timeframe: "1m",
      layer: "bronze",
    });

    expect(candidate.scope.kind).toBe("candidate-identity");
    expect(partition.scope.kind).toBe("market-partition");
    expect(JSON.stringify([candidate, partition])).not.toContain("securityId");
  });

  it("rejects invalid or symbol-only stable identity scopes", () => {
    expect(() => createWorkUnit({
      kind: "security-interval",
      securityId: "sec-apple",
      symbol: "AAPL",
      symbolValidFrom: "2026-08-31T00:00:00.000Z",
      symbolValidTo: "2026-08-30T00:00:00.000Z",
      dateFrom: "2026-08-28",
      dateTo: "2026-08-28",
      timeframe: "1d",
      layer: "bronze",
    })).toThrow(/symbol interval/i);

    expect(() => createWorkUnit({
      kind: "security-interval",
      securityId: "",
      symbol: "AAPL",
      symbolValidFrom: "2026-08-31T00:00:00.000Z",
      dateFrom: "2026-08-28",
      dateTo: "2026-08-27",
      timeframe: "1d",
      layer: "bronze",
    })).toThrow();

    expect(() => createWorkUnit({
      kind: "candidate-identity",
      candidateId: "candidate-bny",
      indexId: "sp500",
      observedSymbol: "BNY",
      securityId: "invented",
      sourceRevisionRefs: [{
        ref: "artifact://wikipedia/revision/123",
        hash: `sha256:${"a".repeat(64)}`,
      }],
    } as never)).toThrow();
  });

  it("has no global BLOCKED state", () => {
    expect(SHEPHERD_STATES).not.toContain("BLOCKED");
    expect(() => ShepherdStateSchema.parse("BLOCKED")).toThrow();
  });
});

describe("reduceShepherd", () => {
  it("rejects duplicate event IDs, stale revisions, and changed scope under one ID", () => {
    const unit = identified();
    const opened = discovered(unit);
    expect(() => reduceShepherd([opened, opened])).toThrow(/duplicate event/i);
    expect(() => reduceShepherd([
      opened,
      transition(unit, 1, "DISCOVERED", "EVIDENCE_PENDING"),
    ])).toThrow(/stale revision/i);

    const changed = { ...unit, scope: { ...unit.scope, symbol: "MSFT" } };
    expect(() => reduceShepherd([opened, discovered(changed as ShepherdWorkUnit)]))
      .toThrow(/scope hash mismatch/i);
  });

  it("starts every newly discovered work unit at revision zero", () => {
    const unit = { ...identified(), revision: 1 };
    expect(() => reduceShepherd([discovered(unit)])).toThrow(/initial revision/i);
  });

  it.each(["AWAITING_PROVIDER", "AWAITING_USER", "UNRESOLVED", "ENGINEERING_ESCALATED"])(
    "keeps %s local to one work unit",
    (state) => {
      const first = identified();
      const second = createWorkUnit({
        kind: "market-partition",
        provider: "massive",
        assetClass: "equity",
        marketDate: "2026-08-29",
        timeframe: "1m",
        layer: "bronze",
      });
      const reduced = reduceShepherd([
        discovered(first),
        discovered(second),
        transition(first, 0, "DISCOVERED", state),
      ]);
      expect(reduced.workUnits[first.workUnitId]?.state).toBe(state);
      expect(reduced.workUnits[second.workUnitId]?.state).toBe("DISCOVERED");
      expect(reduced).not.toHaveProperty("status");
    },
  );

  it("requires independent verification before VERIFIED", () => {
    const unit = identified();
    const beforeVerification = [
      discovered(unit),
      transition(unit, 0, "DISCOVERED", "ADJUDICATING"),
      event({
        type: "claim/recorded",
        payload: {
          workUnitId: unit.workUnitId,
          expectedRevision: 1,
          revision: 2,
          claimId: "claim-1",
          statement: "partition is complete",
          evidence: [{ ref: "artifact://source/a", hash: `sha256:${"a".repeat(64)}` }],
        },
      }),
    ] satisfies ShepherdEvent[];
    expect(() => reduceShepherd([
      ...beforeVerification,
      transition(unit, 2, "ADJUDICATING", "VERIFIED"),
    ])).toThrow(/independent verification/i);

    const reduced = reduceShepherd([
      ...beforeVerification,
      event({
        type: "claim/verified",
        payload: {
          workUnitId: unit.workUnitId,
          expectedRevision: 2,
          revision: 3,
          claimId: "claim-1",
          verifierRole: "independent-verifier",
          decision: "pass",
          evidence: [{ ref: "artifact://verify/a", hash: `sha256:${"b".repeat(64)}` }],
        },
      }),
      transition(unit, 3, "ADJUDICATING", "VERIFIED"),
    ]);
    expect(reduced.workUnits[unit.workUnitId]?.state).toBe("VERIFIED");
  });

  it("does not promote a unit while any recorded claim lacks a passing decision", () => {
    const unit = identified();
    const claim = (claimId: string, expectedRevision: number) => event({
      type: "claim/recorded",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision,
        revision: expectedRevision + 1,
        claimId,
        statement: claimId,
        evidence: [{ ref: `artifact://source/${claimId}`, hash: `sha256:${"a".repeat(64)}` }],
      },
    }) satisfies ShepherdEvent;
    const verified = event({
      type: "claim/verified",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 3,
        revision: 4,
        claimId: "claim-a",
        verifierRole: "independent-verifier",
        decision: "pass",
        evidence: [{ ref: "artifact://verify/claim-a", hash: `sha256:${"b".repeat(64)}` }],
      },
    }) satisfies ShepherdEvent;
    expect(() => reduceShepherd([
      discovered(unit),
      transition(unit, 0, "DISCOVERED", "ADJUDICATING"),
      claim("claim-a", 1),
      claim("claim-b", 2),
      verified,
      transition(unit, 4, "ADJUDICATING", "VERIFIED"),
    ])).toThrow(/every recorded claim/i);
  });

  it("binds a logical evidence ref to exactly one content hash", () => {
    const unit = identified();
    const first = event({
      type: "evidence/attached",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 0,
        revision: 1,
        evidence: { ref: "artifact://team/run/task", hash: `sha256:${"a".repeat(64)}` },
      },
    }) satisfies ShepherdEvent;
    const conflict = event({
      type: "evidence/attached",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 1,
        revision: 2,
        evidence: { ref: "artifact://team/run/task", hash: `sha256:${"b".repeat(64)}` },
      },
    }) satisfies ShepherdEvent;
    expect(() => reduceShepherd([discovered(unit), first, conflict]))
      .toThrow(/evidence hash conflict/i);
  });

  it("persists lease, write-ahead execution intent, and one closing outcome", () => {
    const unit = identified();
    const lease = event({
      type: "attempt/lease-acquired",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 0,
        revision: 1,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        ownerId: "shepherdd-1",
        expiresAt: "2026-08-31T01:05:00.000Z",
      },
    }) satisfies ShepherdEvent;
    const intent = event({
      type: "attempt/execution-intent",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 1,
        revision: 2,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        operation: "probe",
      },
    }) satisfies ShepherdEvent;
    const outcome = event({
      type: "attempt/outcome-recorded",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 2,
        revision: 3,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        outcome: "completed",
        nextState: "EVIDENCE_PENDING",
      },
    }) satisfies ShepherdEvent;
    const reduced = reduceShepherd([discovered(unit), lease, intent, outcome]);
    expect(reduced.workUnits[unit.workUnitId]?.activeLease).toBeUndefined();
    expect(reduced.workUnits[unit.workUnitId]?.attempts["attempt-1"]?.state)
      .toBe("completed");
    expect(reduced.workUnits[unit.workUnitId]?.state).toBe("EVIDENCE_PENDING");
    expect(() => reduceShepherd([discovered(unit), lease, intent, outcome, outcome]))
      .toThrow(/duplicate event/i);
  });

  it("expires only the matching lease after its deadline", () => {
    const unit = identified();
    const lease = event({
      type: "attempt/lease-acquired",
      payload: {
        workUnitId: unit.workUnitId,
        expectedRevision: 0,
        revision: 1,
        attemptId: "attempt-expired",
        leaseId: "lease-expired",
        ownerId: "shepherdd-1",
        expiresAt: "2026-08-31T01:00:01.000Z",
      },
    }) satisfies ShepherdEvent;
    const expired = {
      ...event({
        type: "attempt/lease-expired",
        payload: {
          workUnitId: unit.workUnitId,
          expectedRevision: 1,
          revision: 2,
          attemptId: "attempt-expired",
          leaseId: "lease-expired",
        },
      }),
      at: "2026-08-31T01:00:02.000Z",
    } satisfies ShepherdEvent;
    expect(reduceShepherd([discovered(unit), lease, expired])
      .workUnits[unit.workUnitId]?.attempts["attempt-expired"]?.state).toBe("expired");
    expect(() => reduceShepherd([discovered(unit), lease, { ...expired, at }]))
      .toThrow(/not expired/i);
  });
});

import { describe, expect, it } from "vitest";
import { ExecutionTargetId } from "../src/capabilities.js";
import { LeaseStore, conformanceAtFloor, isConformant } from "../src/execution.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const issue = (store: LeaseStore, overrides = {}) =>
  store.issue({
    targetId: ExecutionTargetId("fake-a"),
    workId: "work-1",
    reservedCost: 1.5,
    expiresAt: "2026-08-29T00:05:00.000Z",
    ...overrides,
  });

describe("LeaseStore", () => {
  it("issues a lease bound to one work order", () => {
    const store = new LeaseStore();
    const lease = issue(store);
    expect(lease.workId).toBe("work-1");
    expect(lease.targetId).toBe(ExecutionTargetId("fake-a"));
  });

  it("refuses to consume a lease for different work", () => {
    const store = new LeaseStore();
    const lease = issue(store);
    expect(() => store.consume(lease.id, "different-work", now)).toThrow(
      /work mismatch/,
    );
  });

  it("consumes exactly once", () => {
    const store = new LeaseStore();
    const lease = issue(store);
    expect(store.consume(lease.id, "work-1", now)).toEqual(lease);
    expect(() => store.consume(lease.id, "work-1", now)).toThrow(/already consumed/);
  });

  it("refuses an unknown lease", () => {
    const store = new LeaseStore();
    expect(() => store.consume("no-such-lease", "work-1", now)).toThrow(/unknown lease/);
  });

  it("refuses an expired lease", () => {
    const store = new LeaseStore();
    const lease = issue(store);
    expect(() =>
      store.consume(lease.id, "work-1", new Date("2026-08-29T00:06:00.000Z")),
    ).toThrow(/expired/);
  });

  it("keeps a reservation without charging it — budget is charged on completion", () => {
    const store = new LeaseStore();
    const lease = issue(store);
    expect(lease.reservedCost).toBe(1.5);
    expect(store.outstanding()).toHaveLength(1);
    store.consume(lease.id, "work-1", now);
    expect(store.outstanding()).toHaveLength(0);
  });
});

describe("conformance records", () => {
  it("admits a record at or above the declared class", () => {
    expect(
      isConformant("process", {
        targetId: ExecutionTargetId("fake-a"),
        provenClass: "process",
        basis: "execution-boundary-conformance",
        recordedAt: now.toISOString(),
      }),
    ).toBe(true);
    expect(
      isConformant("sandboxed", {
        targetId: ExecutionTargetId("fake-a"),
        provenClass: "process",
        basis: "execution-boundary-conformance",
        recordedAt: now.toISOString(),
      }),
    ).toBe(false);
  });

  it("grants the floor without a suite run, because the floor cannot be over-claimed", () => {
    const record = conformanceAtFloor(ExecutionTargetId("fake-b"));
    expect(record.provenClass).toBe("in-process");
    expect(record.basis).toBe("floor");
    expect(isConformant("in-process", record)).toBe(true);
    // The floor proves nothing about a stronger claim.
    expect(isConformant("process", record)).toBe(false);
  });
});

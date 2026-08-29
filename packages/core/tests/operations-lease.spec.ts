import { describe, expect, it } from "vitest";
import {
  ActionLeaseController,
  ActionLeaseTable,
  type ActionLeaseKey,
} from "../src/operations/lease.js";

const digest = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-08-25T04:00:00.000Z");

const key = (overrides: Partial<ActionLeaseKey> = {}): ActionLeaseKey => ({
  componentId: "runtime",
  incidentId: "inc-1",
  sopId: "restart",
  sopDigest: digest,
  attempt: 1,
  ...overrides,
});

const controller = (table: ActionLeaseTable, id: string, at = now) =>
  new ActionLeaseController(table, {
    controllerId: id,
    ttlMs: 600_000,
    now: () => at,
  });

describe("ActionLeaseTable", () => {
  it("admits one controller and refuses the second", () => {
    const table = new ActionLeaseTable();
    expect(controller(table, "a").acquire(key()).ok).toBe(true);
    expect(controller(table, "b").acquire(key())).toMatchObject({
      ok: false,
      reason: "lease-held",
    });
  });

  // Exclusivity is per COMPONENT. Two different SOPs mutating one component at
  // once is the same disaster as one SOP running twice.
  it("refuses a second lease on the same component even for a different SOP", () => {
    const table = new ActionLeaseTable();
    expect(controller(table, "a").acquire(key()).ok).toBe(true);
    expect(
      controller(table, "b").acquire(key({ sopId: "repair", incidentId: "inc-2" })),
    ).toMatchObject({ ok: false, reason: "lease-held" });
  });

  it("admits leases on different components concurrently", () => {
    const table = new ActionLeaseTable();
    expect(controller(table, "a").acquire(key()).ok).toBe(true);
    expect(controller(table, "b").acquire(key({ componentId: "database" })).ok).toBe(
      true,
    );
  });

  it("admits a new lease once the previous one has expired", () => {
    const table = new ActionLeaseTable();
    expect(controller(table, "a", now).acquire(key()).ok).toBe(true);
    const later = new Date(now.getTime() + 600_001);
    expect(controller(table, "b", later).acquire(key({ attempt: 2 })).ok).toBe(true);
  });

  it("refuses an acquire made against a stale revision", () => {
    const table = new ActionLeaseTable();
    const stale = table.revision;
    const first = table.acquire({
      key: key(),
      leaseId: "l1",
      operationId: "op-1",
      now,
      ttlMs: 1000,
    });
    expect(first.ok).toBe(true);
    table.release("l1", "runtime");

    expect(
      table.acquire({
        key: key({ attempt: 2 }),
        leaseId: "l2",
        operationId: "op-2",
        now,
        ttlMs: 1000,
        expectedRevision: stale,
      }),
    ).toEqual({ ok: false, reason: "stale-revision" });
  });

  it("refuses a release from a controller that does not hold the lease", () => {
    const table = new ActionLeaseTable();
    const acquired = table.acquire({
      key: key(),
      leaseId: "l1",
      operationId: "op-1",
      now,
      ttlMs: 1000,
    });
    expect(acquired.ok).toBe(true);
    expect(table.release("someone-else", "runtime")).toEqual({
      ok: false,
      reason: "release-mismatch",
    });
    expect(table.release("l1", "database")).toEqual({
      ok: false,
      reason: "unknown-lease",
    });
    expect(table.release("l1", "runtime")).toEqual({ ok: true });
  });

  it("keeps the operation id stable across a replayed acquire", () => {
    const table = new ActionLeaseTable();
    const a = controller(table, "a").acquire(key());
    if (!a.ok) throw new Error("expected acquire to win");
    table.release(a.lease.leaseId, "runtime");
    const b = controller(table, "a").acquire(key());
    if (!b.ok) throw new Error("expected re-acquire to win");
    expect(b.lease.operationId).toBe(a.lease.operationId);
  });

  it("treats a replayed reservation as a no-op and a conflicting one as corruption", () => {
    const table = new ActionLeaseTable();
    table.reserve("op-1", "runtime|inc-1");
    expect(() => table.reserve("op-1", "runtime|inc-1")).not.toThrow();
    expect(() => table.reserve("op-1", "runtime|inc-2")).toThrow(/different lease/);
  });

  // At most one active lease is the property. Not exactly-once execution:
  // a losing controller does nothing, and a crashed winner reconciles.
  it("never admits two holders, over many contended rounds", () => {
    for (let round = 0; round < 50; round += 1) {
      const table = new ActionLeaseTable();
      const wins = ["a", "b", "c"]
        .map((id) => controller(table, id).acquire(key()))
        .filter((r) => r.ok);
      expect(wins, `round ${round}`).toHaveLength(1);
      expect(table.active("runtime", now)).toBeDefined();
    }
  });
});

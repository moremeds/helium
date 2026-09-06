import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuditStore,
  appendLedger,
  readLedger,
  type Commitment,
} from "@helium/core";
import { runTenant } from "../src/runner.js";
import { tenantFixture } from "./fixtures/tenant.js";

function state(): string {
  return mkdtempSync(join(tmpdir(), "helium-runner-settler-"));
}

const open: Commitment = {
  id: "c1",
  runId: "run-earlier",
  tenant: "fake-tenant",
  issuedAt: "2026-09-04T00:00:00Z",
  deployment: "test",
  variant: "live",
  payload: {},
};

describe("settler at DAG start", () => {
  it("settles outstanding commitments and appends the receipts", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle(items) {
          return items.map((item) => ({
            commitmentId: item.id,
            runId: "run-now",
            settledAt: "2026-09-05T00:00:00Z",
            status: "settled",
            scores: { s: 0.25 },
          }));
        },
      },
    });
    // The runner overwrites whatever runId the settler wrote: the id of the
    // settling run is the runner's fact, not the tenant's.
    expect(readLedger(stateRoot, "fake-tenant").receipts).toEqual([
      {
        commitmentId: "c1",
        runId: report.runId,
        settledAt: "2026-09-05T00:00:00Z",
        status: "settled",
        scores: { s: 0.25 },
      },
    ]);
    audit.close();
  });

  it("records the settler as a zero-token span", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          return [];
        },
      },
    });
    const row = audit
      .runCost(report.runId)
      .find((entry) => entry.toolName === "settler");
    expect(row).toBeDefined();
    expect(row!.inputTokens + row!.outputTokens).toBe(0);
    expect(row!.usd).toBe(0);
    audit.close();
  });

  it("a throwing settler is recorded and does not fail the run", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          throw new Error("lake down");
        },
      },
    });
    expect(report.outcome).toBe("completed");
    expect(report.settlerSkipped?.reason).toContain("lake down");
    expect(readLedger(stateRoot, "fake-tenant").receipts).toEqual([]);
    audit.close();
  });

  it("does not call the settler when nothing is outstanding", async () => {
    const stateRoot = state();
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    let called = 0;
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          called += 1;
          return [];
        },
      },
    });
    expect(called).toBe(0);
    expect(report.settlerSkipped).toBeUndefined();
    audit.close();
  });
});

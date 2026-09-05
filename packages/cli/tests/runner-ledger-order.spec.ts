import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditStore, readLedger } from "@helium/core";
import { runTenant } from "../src/runner.js";
import { tenantFixture } from "./fixtures/tenant.js";

const renderer = () => ({
  text: "brief",
  data: { schemaVersion: 2 },
  commitments: [{ id: "d-premarket-spy-t1", payload: { t1Down: 0.4 } }],
  baselines: [
    { id: "d-premarket-baseline", payload: { neutral: { t1Down: 0.5 } } },
  ],
});

describe("ledger write ordering", () => {
  it("appends commitments and baselines with the run context stamped on", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
    });
    const read = readLedger(stateRoot, "fake-tenant");
    expect(read.commitments).toEqual([
      {
        id: "d-premarket-spy-t1",
        runId: report.runId,
        tenant: "fake-tenant",
        issuedAt: expect.any(String),
        deployment: "test",
        variant: "live",
        payload: { t1Down: 0.4 },
      },
    ]);
    expect(read.baselines.map((b) => b.id)).toEqual(["d-premarket-baseline"]);
    audit.close();
  });

  it("an --as-of run is stamped backtest and carries asOf", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      asOf: new Date("2026-09-04T12:00:00Z"),
      variant: "replay",
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_DEPLOYMENT: "production" },
    });
    const [commitment] = readLedger(stateRoot, "fake-tenant").commitments;
    expect(commitment!.deployment).toBe("backtest");
    expect(commitment!.variant).toBe("replay");
    expect(commitment!.asOf).toBe("2026-09-04T12:00:00.000Z");
    audit.close();
  });

  it("HELIUM_DEPLOYMENT=production with no --as-of is production", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_DEPLOYMENT: "production" },
    });
    expect(
      readLedger(stateRoot, "fake-tenant").commitments[0]!.deployment,
    ).toBe("production");
    audit.close();
  });

  it("the commitment is on disk before any delivery is attempted", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    let atDeliver: number | undefined;
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_TENANT_DELIVERY: "1" },
      channels: [
        {
          id: "file",
          external: false,
          async deliver() {
            atDeliver = readLedger(stateRoot, "fake-tenant").commitments.length;
            return { state: "sent" as const };
          },
        } as never,
      ],
    });
    expect(atDeliver).toBe(1);
    audit.close();
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditStore, appendLedger } from "@helium/core";
import { printScoreboard } from "../src/cli.js";

function ledgerAt(): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-sb-cli-"));
  appendLedger(dir, "option-wizard", [
    {
      kind: "commitment",
      commitment: {
        id: "a",
        runId: "run-a",
        tenant: "option-wizard",
        issuedAt: "2026-09-04T00:00:00Z",
        deployment: "production",
        variant: "live",
        payload: {},
      },
    },
    {
      kind: "commitment",
      commitment: {
        id: "t",
        runId: "run-t",
        tenant: "option-wizard",
        issuedAt: "2026-09-04T00:00:00Z",
        deployment: "test",
        variant: "live",
        payload: {},
      },
    },
    {
      kind: "receipt",
      receipt: {
        commitmentId: "a",
        runId: "run-s",
        settledAt: "2026-09-05T00:00:00Z",
        status: "down",
        scores: { t1Brier: 0.09 },
      },
    },
    {
      kind: "receipt",
      receipt: {
        commitmentId: "t",
        runId: "run-s",
        settledAt: "2026-09-05T00:00:00Z",
        status: "down",
        scores: { t1Brier: 0.81 },
      },
    },
  ]);
  return dir;
}

describe("helium scoreboard", () => {
  it("prints the production ledger and excludes the test run by default", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    expect(printScoreboard(store, dir, ["option-wizard"])).toBe(0);
    spy.mockRestore();
    store.close();
    const text = lines.join("\n");
    expect(text).toContain("mean 0.0900");
    expect(text).not.toContain("0.8100");
  });

  it("returns 2 and says so when the tenant is missing", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(printScoreboard(store, dir, [])).toBe(2);
    spy.mockRestore();
    store.close();
  });

  it("returns 2 on an unknown option", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(printScoreboard(store, dir, ["option-wizard", "--nope"])).toBe(2);
    spy.mockRestore();
    store.close();
  });
});

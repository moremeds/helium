import { describe, expect, it } from "vitest";
import { AuditStore, auditDbPath, type Span } from "../src/index.js";

function span(overrides: Partial<Span> = {}): Span {
  return {
    runId: "run-1",
    spanId: "step:1:1",
    tenant: "fake-tenant",
    role: "prober",
    provider: "p",
    model: "m",
    codeVersion: "test",
    stepNo: 1,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 800,
    contextSize: 1500,
    latencyMs: 2500,
    costUsd: 0.0042,
    summarised: false,
    ts: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("AuditStore", () => {
  it("answers the design §5 query grouped by role, provider, model and tool", () => {
    const store = new AuditStore(":memory:");
    store.appendAll([
      span(),
      span({ spanId: "step:1:2", stepNo: 2, costUsd: 0.01, inputTokens: 10, outputTokens: 5 }),
      span({ spanId: "tool:a", toolName: "fake_probe", inputTokens: 0, outputTokens: 0, costUsd: 0, toolOutputBytes: 42 }),
    ]);
    const rows = store.runCost("run-1");
    expect(rows.map((r) => r.usd)).toEqual([...rows.map((r) => r.usd)].sort((a, b) => b - a));
    const model = rows.find((r) => r.toolName === null)!;
    expect(model.spans).toBe(2);
    expect(model.inputTokens).toBe(1210);
    expect(model.cacheReadTokens).toBe(1600);
    expect(rows.find((r) => r.toolName === "fake_probe")?.spans).toBe(1);
    store.close();
  });

  it("is idempotent on (run_id, span_id) so a re-fold rewrites rather than duplicates", () => {
    const store = new AuditStore(":memory:");
    store.append(span());
    store.append(span({ outputTokens: 999 }));
    expect(store.spans("run-1")).toHaveLength(1);
    expect(store.spans("run-1")[0]?.outputTokens).toBe(999);
    store.close();
  });

  it("totals what a run has spent, for the budget check to read", () => {
    const store = new AuditStore(":memory:");
    store.appendAll([span(), span({ spanId: "step:1:2", costUsd: 0.1, inputTokens: 5, outputTokens: 5 })]);
    expect(store.spent("run-1")).toEqual({ usd: 0.1042, tokens: 1510 });
    store.close();
  });

  it("defaults outside the deploy unit and honours the override", () => {
    expect(auditDbPath({ HELIUM_AUDIT_DB: "/tmp/x.db" } as NodeJS.ProcessEnv)).toBe("/tmp/x.db");
    expect(auditDbPath({} as NodeJS.ProcessEnv)).toMatch(/\.helium\/audit\.db$/);
  });
});

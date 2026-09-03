import { describe, expect, it } from "vitest";
import {
  AuditStore,
  SUMMARISE_OVER_BYTES,
  applyOutputPolicy,
  budgetLine,
  remaining,
  type Span,
} from "../src/index.js";

const BUDGET = { usd: 2, tokens: 400_000 };

function store(spans: Span[]): AuditStore {
  const s = new AuditStore(":memory:");
  s.appendAll(spans);
  return s;
}

function span(id: string, usd: number, tokens: number): Span {
  return {
    runId: "r", spanId: id, tenant: "t", role: "auditor", provider: "p", model: "m",
    stepNo: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0,
    contextSize: tokens, latencyMs: 1, costUsd: usd, summarised: false,
    ts: "2026-09-02T00:00:00.000Z",
  };
}

describe("budget", () => {
  it("reads what is left from the audit table, not from an estimate", () => {
    const s = store([span("a", 0.5, 1000), span("b", 0.25, 500)]);
    expect(remaining(s, "r", BUDGET)).toMatchObject({
      usd: 1.25, tokens: 398_500, spentUsd: 0.75, steps: 2, exhausted: false,
    });
    s.close();
  });

  it("names which ceiling ran out", () => {
    const s = store([span("a", 2.5, 10)]);
    expect(remaining(s, "r", BUDGET)).toMatchObject({ exhausted: true, reason: "usd" });
    s.close();
  });

  it("injects a remaining-budget line the agent can act on", () => {
    const s = store([span("a", 1.8, 10)]);
    const line = budgetLine(remaining(s, "r", BUDGET), BUDGET);
    expect(line).toContain("remaining 0.2000 USD of 2.00 (10%)");
    expect(line).toContain("never silently truncated");
    s.close();
  });

  it("leaves a small tool result untouched", async () => {
    expect(await applyOutputPolicy("small")).toEqual({
      summarised: false, bytes: 5, text: "small",
    });
  });

  it("summarises a tool result over the ceiling and hands over the spill path", async () => {
    // Sized off the ceiling so the case survives the ceiling moving; a literal
    // 9000 stopped exercising the spill the moment it rose past 8 KB.
    const overBytes = SUMMARISE_OVER_BYTES + 1;
    const big = "x".repeat(overBytes);
    const decision = await applyOutputPolicy(big, {
      spill: () => "/tmp/out.txt",
      summarise: async () => "nine thousand x characters",
    });
    expect(decision.summarised).toBe(true);
    expect(decision.bytes).toBe(overBytes);
    expect(decision.text).toBe("nine thousand x characters\n[full output: /tmp/out.txt]");
    expect(decision.spillPath).toBe("/tmp/out.txt");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeamBudgetLedger } from "../src/team/budget.js";
import type { RoleContract, TeamEvent } from "../src/team/events.js";
import { openTeamStore } from "../src/team/store.js";

const noSync = () => {};
const role: RoleContract = {
  roleId: "worker",
  requires: ["research"],
  tools: ["artifact_read"],
  workspace: "isolated",
  maxDepth: 1,
  budgetShare: 1,
};

function ledger(limits = {
  case: { tokens: 10_000, cost: 10, ms: 100_000 },
  team: { tokens: 8_000, cost: 8, ms: 80_000 },
  agents: { worker: { tokens: 6_000, cost: 6, ms: 60_000 } },
}): TeamBudgetLedger {
  const store = openTeamStore(mkdtempSync(join(tmpdir(), "helium-budget-")), "case-budget", {
    sync: noSync,
  });
  const events: TeamEvent[] = [
    { version: 1, eventId: "open", at: "2026-08-30T10:00:00.000Z", caseId: "case-budget", type: "case/opened", payload: { subject: "macro" } },
    { version: 1, eventId: "start", at: "2026-08-30T10:01:00.000Z", caseId: "case-budget", teamRunId: "team-budget", type: "team/started", payload: {} },
    { version: 1, eventId: "worker", at: "2026-08-30T10:02:00.000Z", caseId: "case-budget", teamRunId: "team-budget", type: "agent/rostered", payload: { agentId: "worker", role } },
  ];
  for (const event of events) store.append(event);
  let n = 0;
  return new TeamBudgetLedger(store, "team-budget", limits, {
    now: () => "2026-08-30T10:03:00.000Z",
    eventId: () => `budget-${++n}`,
  });
}

describe("TeamBudgetLedger", () => {
  it("records one idempotent reservation per stable operation id", () => {
    const budget = ledger();
    const reservation = {
      operationId: "op-1",
      agentId: "worker",
      amount: { tokens: 1_000, cost: 1, ms: 1_000 },
    };
    expect(budget.reserve(reservation)).toBe(true);
    expect(budget.reserve(reservation)).toBe(false);
    expect(budget.totals()).toEqual({ tokens: 1_000, cost: 1, ms: 1_000 });
  });

  it("treats reuse of an operation id with different values as corruption", () => {
    const budget = ledger();
    budget.reserve({ operationId: "op-1", agentId: "worker", amount: { tokens: 1, cost: 1, ms: 1 } });
    expect(() => budget.reserve({
      operationId: "op-1",
      agentId: "worker",
      amount: { tokens: 2, cost: 1, ms: 1 },
    })).toThrow(/budget operation id conflict/);
  });

  it("fails closed at the case budget", () => {
    const budget = ledger({
      case: { tokens: 10, cost: 10, ms: 100 },
      team: { tokens: 100, cost: 100, ms: 1_000 },
      agents: { worker: { tokens: 100, cost: 100, ms: 1_000 } },
    });
    budget.reserve({ operationId: "op-1", agentId: "worker", amount: { tokens: 10, cost: 0, ms: 0 } });
    expect(() => budget.reserve({
      operationId: "op-2",
      agentId: "worker",
      amount: { tokens: 1, cost: 0, ms: 0 },
    })).toThrow(/case budget exhausted/);
  });

  it("fails closed at the team budget", () => {
    const budget = ledger({
      case: { tokens: 100, cost: 100, ms: 1_000 },
      team: { tokens: 10, cost: 100, ms: 1_000 },
      agents: { worker: { tokens: 100, cost: 100, ms: 1_000 } },
    });
    expect(() => budget.reserve({
      operationId: "op-1",
      agentId: "worker",
      amount: { tokens: 11, cost: 0, ms: 0 },
    })).toThrow(/team budget exhausted/);
  });

  it("fails closed at the agent budget", () => {
    const budget = ledger({
      case: { tokens: 100, cost: 100, ms: 1_000 },
      team: { tokens: 100, cost: 100, ms: 1_000 },
      agents: { worker: { tokens: 10, cost: 100, ms: 1_000 } },
    });
    expect(() => budget.reserve({
      operationId: "op-1",
      agentId: "worker",
      amount: { tokens: 11, cost: 0, ms: 0 },
    })).toThrow(/agent budget exhausted/);
  });

  it("rejects a charge for an unknown agent", () => {
    const budget = ledger();
    expect(() => budget.reserve({
      operationId: "op-1",
      agentId: "missing",
      amount: { tokens: 1, cost: 0, ms: 0 },
    })).toThrow(/unknown agent/);
  });
});

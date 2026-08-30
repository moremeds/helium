/** Durable, idempotent case/team/agent budget reservations. */
import { randomUUID } from "node:crypto";
import type { BudgetAmount } from "./events.js";
import type { BudgetReservationProjection, TeamRunProjection, TeamState } from "./reducer.js";
import type { TeamStore } from "./store.js";

export interface BudgetLimits {
  case: BudgetAmount;
  team: BudgetAmount;
  agents: Record<string, BudgetAmount>;
}

export interface BudgetReservation {
  operationId: string;
  agentId: string;
  amount: BudgetAmount;
}

export interface TeamBudgetOptions {
  now?: () => string;
  eventId?: () => string;
}

const zero = (): BudgetAmount => ({ tokens: 0, cost: 0, ms: 0 });
const add = (left: BudgetAmount, right: BudgetAmount): BudgetAmount => ({
  tokens: left.tokens + right.tokens,
  cost: left.cost + right.cost,
  ms: left.ms + right.ms,
});
const sameReservation = (
  left: BudgetReservationProjection,
  right: BudgetReservation,
): boolean => left.agentId === right.agentId
  && left.amount.tokens === right.amount.tokens
  && left.amount.cost === right.amount.cost
  && left.amount.ms === right.amount.ms;
const exceeds = (amount: BudgetAmount, limit: BudgetAmount): boolean =>
  amount.tokens > limit.tokens || amount.cost > limit.cost || amount.ms > limit.ms;

export class TeamBudgetLedger {
  readonly #store: TeamStore;
  readonly #teamRunId: string;
  readonly #limits: BudgetLimits;
  readonly #now: () => string;
  readonly #eventId: () => string;

  constructor(
    store: TeamStore,
    teamRunId: string,
    limits: BudgetLimits,
    options: TeamBudgetOptions = {},
  ) {
    this.#store = store;
    this.#teamRunId = teamRunId;
    this.#limits = limits;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventId ?? (() => `budget-${randomUUID()}`);
    this.#team(this.#store.load());
  }

  reserve(reservation: BudgetReservation): boolean {
    const state = this.#store.load();
    const team = this.#team(state);
    if (team.roster[reservation.agentId] === undefined) {
      throw new Error(`unknown agent: ${reservation.agentId}`);
    }
    const agentLimit = this.#limits.agents[reservation.agentId];
    if (agentLimit === undefined) throw new Error(`missing agent budget: ${reservation.agentId}`);
    const existing = team.budgetReservations[reservation.operationId];
    if (existing !== undefined) {
      if (!sameReservation(existing, reservation)) {
        throw new Error(`budget operation id conflict: ${reservation.operationId}`);
      }
      return false;
    }

    const caseNext = add(caseTotals(state), reservation.amount);
    const teamNext = add(teamTotals(team), reservation.amount);
    const agentNext = add(agentTotals(team, reservation.agentId), reservation.amount);
    if (exceeds(caseNext, this.#limits.case)) throw new Error("case budget exhausted");
    if (exceeds(teamNext, this.#limits.team)) throw new Error("team budget exhausted");
    if (exceeds(agentNext, agentLimit)) throw new Error("agent budget exhausted");

    this.#store.append({
      version: 1,
      eventId: this.#eventId(),
      at: this.#now(),
      caseId: team.caseId,
      teamRunId: team.teamRunId,
      type: "budget/reserved",
      payload: reservation,
    });
    return true;
  }

  totals(): BudgetAmount {
    return teamTotals(this.#team(this.#store.load()));
  }

  #team(state: TeamState): TeamRunProjection {
    const team = state.teams[this.#teamRunId];
    if (team === undefined) throw new Error(`unknown team: ${this.#teamRunId}`);
    return team;
  }
}

function sum(reservations: readonly BudgetReservationProjection[]): BudgetAmount {
  return reservations.reduce((total, reservation) => add(total, reservation.amount), zero());
}

function teamTotals(team: TeamRunProjection): BudgetAmount {
  return sum(Object.values(team.budgetReservations));
}

function agentTotals(team: TeamRunProjection, agentId: string): BudgetAmount {
  return sum(Object.values(team.budgetReservations).filter((entry) => entry.agentId === agentId));
}

function caseTotals(state: TeamState): BudgetAmount {
  return sum(Object.values(state.teams).flatMap((team) => Object.values(team.budgetReservations)));
}

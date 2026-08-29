/**
 * Recovery budgets: how often the controller may act at all.
 *
 * A budget is a bound on ATTEMPTS, not on successes. A `not-needed` attempt --
 * the component was already healthy at baseline -- still consumes budget,
 * because otherwise a component that keeps looking healthy at baseline lets
 * the controller loop forever. It is excluded from automation CREDIT
 * elsewhere, which is a different question and a different statistic.
 * @module @helium/core/operations/recovery-budget
 */
import type { AttemptRecord } from "./authority.js";

export interface BudgetPolicy {
  maxAttemptsPerIncident: number;
  maxRunsPerWindow: number;
  windowMs: number;
  cooldownMs: number;
}

export type BudgetCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "max-attempts-per-incident" | "max-runs-per-window" | "cooldown";
    };

export class RecoveryBudget {
  readonly #charges = new Map<string, { incidentId: string; at: string }>();

  constructor(private readonly policy: BudgetPolicy) {}

  check(input: {
    incidentId: string;
    sopId: string;
    history: AttemptRecord[];
    now: Date;
  }): BudgetCheck {
    const at = input.now.getTime();
    const forIncident = input.history.filter(
      (h) => h.incidentId === input.incidentId && h.sopId === input.sopId,
    );

    if (forIncident.length >= this.policy.maxAttemptsPerIncident) {
      return { ok: false, reason: "max-attempts-per-incident" };
    }

    const inWindow = input.history.filter(
      (h) => at - Date.parse(h.at) < this.policy.windowMs,
    );
    if (inWindow.length >= this.policy.maxRunsPerWindow) {
      return { ok: false, reason: "max-runs-per-window" };
    }

    const last = forIncident
      .map((h) => Date.parse(h.at))
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => b - a)[0];
    if (last !== undefined && at - last < this.policy.cooldownMs) {
      return { ok: false, reason: "cooldown" };
    }

    return { ok: true };
  }

  /**
   * Charge one attempt against a stable operation id.
   *
   * Idempotent by that id: replaying a reservation after a crash must not
   * charge twice, or a reconciling controller spends budget it already spent.
   *
   * @returns whether this call was the one that charged.
   * @throws when the same id is replayed for a DIFFERENT incident, which is
   * corruption rather than a retry.
   */
  reserve(operationId: string, charge: { incidentId: string; at: string }): {
    charged: boolean;
  } {
    const existing = this.#charges.get(operationId);
    if (existing === undefined) {
      this.#charges.set(operationId, { ...charge });
      return { charged: true };
    }
    if (existing.incidentId !== charge.incidentId) {
      throw new Error(
        `operation id ${operationId} was already charged to a different incident`,
      );
    }
    return { charged: false };
  }

  chargeCount(): number {
    return this.#charges.size;
  }
}

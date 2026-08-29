/**
 * Transition-only, root-grouped operations alerts.
 *
 * Delivery is injected through the existing write-ahead delivery surface. The
 * alert manager never sends directly and never owns another delivery log. A
 * channel failure becomes a delivery incident; this module has no executor or
 * action surface, so it cannot repeat a recovery action as a side effect of an
 * alert retry.
 * @module dsh-plugin-ops-agent/alerts
 */
import type { Attribution, Incident } from "@helium/core";

export interface AlertMessage {
  dedupeKey: string;
  transition: "raised" | "recovered";
  severity: "info" | "warning" | "critical";
  rootComponentId: string;
  inhibitedSymptoms: string[];
  impact: string;
  nextDecision: string;
  actionAttribution?: Attribution;
  verification?: string;
  summary: string;
}

/** Implemented by the existing delivery write-ahead state machine. */
export interface AlertDelivery {
  deliver(message: AlertMessage): Promise<void>;
}

export interface AlertInput {
  incident: Incident;
  severity: AlertMessage["severity"];
  impact: string;
  inhibitedSymptoms: readonly string[];
  nextDecision: string;
  actionAttribution?: Attribution;
  verification?: string;
}

export type AlertEvaluation =
  | { emitted: true }
  | { emitted: false }
  | {
      emitted: false;
      deliveryIncident: Incident;
      recoveryActionRequested: false;
    };

interface AlertState {
  firstSeenMs: number;
  raised: boolean;
  recovered: boolean;
}

export class AlertManager {
  readonly #states = new Map<string, AlertState>();

  constructor(
    private readonly options: {
      delivery: AlertDelivery;
      forMs: number;
    },
  ) {
    if (!Number.isInteger(options.forMs) || options.forMs < 0) {
      throw new Error("alert forMs must be a non-negative integer");
    }
  }

  async evaluate(input: AlertInput, now: Date): Promise<AlertEvaluation> {
    let state = this.#states.get(input.incident.key);
    if (state === undefined) {
      state = { firstSeenMs: now.getTime(), raised: false, recovered: false };
      this.#states.set(input.incident.key, state);
    }

    if (input.incident.state === "recovered") {
      if (!state.raised || state.recovered) return { emitted: false };
      state.recovered = true;
      return this.#deliver(input, "recovered", now);
    }

    if (state.raised) return { emitted: false };
    if (now.getTime() - state.firstSeenMs < this.options.forMs) {
      return { emitted: false };
    }
    state.raised = true;
    return this.#deliver(input, "raised", now);
  }

  async #deliver(
    input: AlertInput,
    transition: AlertMessage["transition"],
    now: Date,
  ): Promise<AlertEvaluation> {
    const inhibitedSymptoms = [...new Set(input.inhibitedSymptoms)].sort();
    const message: AlertMessage = {
      dedupeKey: input.incident.key,
      transition,
      severity: transition === "recovered" ? "info" : input.severity,
      rootComponentId: input.incident.rootComponentId,
      inhibitedSymptoms,
      impact: input.impact,
      nextDecision: input.nextDecision,
      ...(input.actionAttribution === undefined
        ? {}
        : { actionAttribution: input.actionAttribution }),
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      summary: [
        `transition=${transition}`,
        `root=${input.incident.rootComponentId}`,
        `impact=${input.impact}`,
        `inhibited=${inhibitedSymptoms.join(",") || "none"}`,
        `next=${input.nextDecision}`,
      ].join(" "),
    };

    try {
      await this.options.delivery.deliver(message);
      return { emitted: true };
    } catch {
      return {
        emitted: false,
        deliveryIncident: {
          key: `alert-delivery|${input.incident.key}`,
          rootComponentId: "alert-delivery",
          symptomComponentIds: [input.incident.rootComponentId],
          dimension: "delivery",
          failureClass: "failed",
          state: "open",
          observationIds: [...input.incident.observationIds],
          openedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        recoveryActionRequested: false,
      };
    }
  }
}

/**
 * `promotionMode: delivered` — the only mode whose output leaves the machine.
 *
 * Ordering is the whole contract: the delivery INTENT is recorded through the
 * team's own event log first, then the email is rendered and sent, then the
 * outcome closes the intent. The port is invoked while the team is still
 * running (see team-controller.ts), because core's reducer routes both
 * delivery events through `requireRunningTeam`.
 *
 * Delivery is additionally gated on `HELIUM_TENANT_DELIVERY=1`. A tenant file
 * saying `delivered` is a declaration of intent; the env flag is the operator
 * saying this host may actually send. Without it the run terminates in the
 * review inbox exactly as `review-only` does.
 * @module dsh-plugin-helium/tenant-delivery
 */
import type { ArtifactProjection, TeamRunProjection } from "@helium/core";
import type { Delivery } from "./delivery.js";
import type { TenantDeliveryPolicy, TenantDescriptor } from "./tenants.js";

export interface TenantDeliveryPort {
  deliver(input: {
    teamRunId: string;
    team: TeamRunProjection;
    /**
     * The terminal outcome the controller is about to append. The projection
     * still says "running" at this point, so anything rendered from
     * `team.state` would be wrong in production and right only in a fixture.
     */
    outcome: "completed" | "failed";
    /**
     * Artifact bodies, read by the CONTROLLER from the store it already holds
     * for this case. `TeamController` opens one store per caseId, so a store
     * handed to the port at construction time would belong to whichever run
     * happened to be first. The projection alone carries metadata only.
     */
    artifacts: Record<string, ArtifactProjection & { content: string }>;
    recordIntent(artifactRefs: string[]): string;
    recordOutcome(
      deliveryId: string,
      outcome: "delivered" | "failed" | "uncertain",
    ): void;
  }): Promise<void>;
}

/**
 * The artifact refs this delivery cites, sorted for a stable record. The event
 * schema requires at least one, so a run that produced no artifact still cites
 * the run itself rather than failing validation.
 */
export function deliverableRefs(team: TeamRunProjection): string[] {
  const refs = Object.values(team.artifacts)
    .map((artifact) => artifact.ref)
    .sort();
  return refs.length > 0 ? refs : [`artifact://team-run/${team.teamRunId}`];
}

export function renderTeamEmail(
  tenant: string,
  team: TeamRunProjection,
  outcome: "completed" | "failed",
): string {
  const tasks = Object.values(team.tasks)
    .map((task) => `- ${task.id}: ${task.state}`)
    .sort();
  const artifacts = Object.values(team.artifacts)
    .map(
      (artifact) => `- ${artifact.taskId}: ${artifact.ref} (${artifact.hash})`,
    )
    .sort();
  return [
    `${tenant} — team run ${team.teamRunId}`,
    "",
    `case: ${team.caseId}`,
    // NOT `team.state`: the port fires immediately before the terminal append,
    // so the projection still reads "running".
    `state: ${outcome}`,
    "",
    "Tasks:",
    ...tasks,
    "",
    "Artifacts:",
    ...artifacts,
    "",
  ].join("\n");
}

export class TenantDelivery implements TenantDeliveryPort {
  constructor(
    private readonly opts: {
      tenant: string;
      policy: TenantDeliveryPolicy;
      delivery: Delivery;
      enabled: boolean;
      renderEmail?: TenantDescriptor["renderEmail"];
      now?: () => Date;
    },
  ) {}

  async deliver(
    input: Parameters<TenantDeliveryPort["deliver"]>[0],
  ): Promise<void> {
    if (!this.opts.enabled) return;
    const deliveryId = input.recordIntent(deliverableRefs(input.team));
    try {
      // A tenant that knows its own domain renders its own email; the generic
      // renderer is the fallback, never a wrapper around the override.
      const rendered = this.opts.renderEmail?.({
        tenant: this.opts.tenant,
        teamRunId: input.teamRunId,
        team: input.team,
        artifacts: input.artifacts,
      });
      const result = await this.opts.delivery.deliver({
        tenant: this.opts.tenant,
        deliveryId,
        dedupKey: input.team.caseId,
        runId: input.teamRunId,
        subject:
          rendered?.subject ??
          `${this.opts.policy.email?.subjectPrefix ?? `[helium/${this.opts.tenant}]`} ${input.outcome}`,
        body:
          rendered?.text ??
          renderTeamEmail(this.opts.tenant, input.team, input.outcome),
        ...(this.opts.policy.email === undefined
          ? {}
          : { email: this.opts.policy.email }),
      });
      // Six real delivery states, three outcomes. Only a state that actually
      // sent mail is `delivered`; folding `skipped` and `rate-capped` into
      // `delivered` is how a run that sent nothing came to look successful AND
      // suppressed the human-review fallback.
      input.recordOutcome(
        deliveryId,
        result.state === "sent"
          ? "delivered"
          : result.state === "failed"
            ? "failed"
            : "uncertain",
      );
    } catch {
      // An unresolved intent is worse than a wrong-but-terminal one: the
      // recovery coordinator would close it `uncertain` on the next reconcile
      // anyway, and a throw here would leave the team unable to complete.
      input.recordOutcome(deliveryId, "failed");
    }
  }
}

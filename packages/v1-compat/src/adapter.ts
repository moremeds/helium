/**
 * The v1 compatibility adapter: a `JobSpec` expressed in the model-blind
 * vocabulary, and back again.
 *
 * The round trip is the point. `restoreV1Job(adaptV1Job(job))` must deep-equal
 * `job` for every shipped tenant, which is what proves the new representation
 * carries everything the v1 path actually uses. A one-way shape assertion
 * would pass while quietly dropping a field, and the first symptom would be a
 * production tenant behaving differently.
 *
 * Legacy exact-target hints -- which engine and model v1 named -- ride OUTSIDE
 * the `WorkOrder`, marked `source: "v1-compat"`. They are provider identity,
 * and the whole point of a work order is that it carries none. Resolving a
 * hint to a concrete target is the plugin composition root's job, not the
 * router's.
 * @module @helium/v1-compat/adapter
 */
import { WorkOrderSchema, type WorkOrder } from "@helium/core";
import type { JobScriptAction, JobSpec, Severity, Trigger } from "./job.js";

/** A v1 engine choice, carried beside the work order and never inside it. */
export interface LegacyTargetHint {
  source: "v1-compat";
  lane: "triage" | "senior";
  engine: string;
  model?: string;
}

export interface AdaptedJob {
  name: string;
  enabled: boolean;
  triggers: Trigger[];
  /** Convenience for the golden test; always `triggers.length`. */
  triggerCount: number;
  triage: WorkOrder;
  senior: WorkOrder;
  escalation: { threshold: Exclude<Severity, "noise"> };
  /**
   * Turn caps stay here rather than in `WorkOrder.constraints`: a "turn" is a
   * v1 engine setting, not a property of the work. A latency bound is neutral
   * and does travel in the constraints.
   */
  maxTurns: { triage: number; senior: number };
  budget: { maxTriagePerHour: number; maxSeniorPerDay: number };
  delivery: JobSpec["delivery"];
  session: "fresh";
  memory: "none" | "thesis-file";
  script?: JobScriptAction;
  hints: LegacyTargetHint[];
}

/**
 * Translate one v1 job. Triggers, budgets, prompts, tools and delivery keep
 * their semantics exactly; nothing is redesigned here.
 */
export function adaptV1Job(job: JobSpec): AdaptedJob {
  const constraints = {
    tools: job.tools,
    mutations: job.allowMutations ? ("permitted" as const) : ("forbidden" as const),
    maxLatencyMs: job.timeoutMs,
  };

  const triage: WorkOrder = WorkOrderSchema.parse({
    id: `${job.name}:triage`,
    role: "triage",
    taskClass: "legacy.triage",
    requires: [],
    // The triage lane runs as an in-process agent; the senior lane spawns a
    // child. Declaring that truthfully is what keeps a later selector from
    // routing senior work onto an in-process target.
    constraints: { ...constraints, minIsolationClass: "in-process" },
    inputs: { artifacts: [], prompt: job.prompt },
    acceptance: { outputSchema: "triage-verdict-v1" },
  });

  const senior: WorkOrder = WorkOrderSchema.parse({
    id: `${job.name}:senior`,
    role: "senior",
    taskClass: "legacy.senior",
    requires: [],
    constraints: { ...constraints, minIsolationClass: "process" },
    inputs: { artifacts: [], prompt: job.prompt },
    acceptance: { outputSchema: "senior-analysis-v1" },
  });

  const hints: LegacyTargetHint[] = [
    {
      source: "v1-compat",
      lane: "triage",
      engine: job.engine.triage.engine,
      model: job.engine.triage.model,
    },
    { source: "v1-compat", lane: "senior", engine: job.engine.senior.engine },
  ];

  return {
    name: job.name,
    enabled: job.enabled,
    triggers: job.triggers,
    triggerCount: job.triggers.length,
    triage,
    senior,
    escalation: { threshold: job.escalateWhen },
    maxTurns: job.maxTurns,
    budget: job.budget,
    delivery: job.delivery,
    session: job.session,
    memory: job.memory,
    ...(job.script === undefined ? {} : { script: job.script }),
    hints,
  };
}

/**
 * Rebuild the v1 job. The runtime's `work-order-adapter` mode runs the v1 path
 * on the output of this round trip, so any field the adapter drops changes a
 * golden delivery record and fails the regression suite loudly.
 */
export function restoreV1Job(adapted: AdaptedJob): JobSpec {
  const triageHint = adapted.hints.find((h) => h.lane === "triage");
  const seniorHint = adapted.hints.find((h) => h.lane === "senior");
  if (triageHint === undefined || seniorHint === undefined) {
    throw new Error(`adapted job ${adapted.name} is missing a lane hint`);
  }
  return {
    name: adapted.name,
    enabled: adapted.enabled,
    triggers: adapted.triggers,
    engine: {
      triage: {
        engine: triageHint.engine as "deepseek",
        model: triageHint.model as string,
      },
      senior: { engine: seniorHint.engine as "claude-max" },
    },
    escalateWhen: adapted.escalation.threshold,
    session: adapted.session,
    memory: adapted.memory,
    tools: adapted.senior.constraints.tools,
    allowMutations: adapted.senior.constraints.mutations === "permitted",
    maxTurns: adapted.maxTurns,
    timeoutMs: adapted.senior.constraints.maxLatencyMs as number,
    budget: adapted.budget,
    delivery: adapted.delivery,
    prompt: adapted.senior.inputs.prompt as string,
    ...(adapted.script === undefined ? {} : { script: adapted.script }),
  };
}

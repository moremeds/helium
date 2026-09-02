/**
 * Run one tenant's team once.
 *
 *   tenant discovery -> provider discovery + probe -> capability catalog
 *     -> per task: budget check -> route -> execute -> fold into `span`
 *
 * Two execution modes, and the difference is recorded, never hidden:
 *
 *  - MODEL mode, when a provider probes live. The provider's runtime executes
 *    the step and hands back its session log; core folds that log into spans.
 *    Token counts are whatever the log reported and nothing else.
 *  - TOOL-ONLY mode, when no provider is live. The step's declared tools are
 *    invoked with the task's own prompt as their single string argument, and
 *    each call becomes a tool span with its real latency and output bytes. No
 *    model call happens, so no token count is produced -- and none is invented.
 *
 * A run whose budget cannot cover its next step ends `budget-exhausted`. It is
 * never quietly truncated to fit.
 * @module @helium/cli/runner
 */
import { randomUUID } from "node:crypto";
import {
  AuditStore,
  ExecutionTargetId,
  ProviderRunFailure,
  WorkOrderSchema,
  budgetLine,
  foldSessionLog,
  projection,
  remaining,
  select,
  topologicalOrder,
  type CapabilityCatalog,
  type Channel,
  type EcosystemTool,
  type Gate,
  type LoadedTenant,
  type ModelSelection,
  type Provider,
  type Span,
  type TargetProfile,
  type WorkOrder,
} from "@helium/core";
import {
  discoverChannels,
  discoverProviders,
  loadGates,
  loadTenantTools,
} from "./discovery.js";

export interface StepReport {
  task: string;
  role: string;
  mode: "model" | "tool-only" | "deterministic";
  targetId?: string;
  downgradeReason?: string;
  text: string;
  failure?: string;
  /** Gates that said no. An input refusal means no model call was made. */
  gateRefusals?: Array<{ id: string; reason: string }>;
}

export interface DeliveryReport {
  channel: string;
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail?: string;
}

export interface RunReport {
  runId: string;
  tenant: string;
  mode: "model" | "tool-only";
  providersLive: string[];
  providersSkipped: Array<{ id: string; reason: string }>;
  steps: StepReport[];
  outcome: "completed" | "failed";
  failure?: { class: string; detail: string };
  /** Gates that failed to LOAD. A gate that stopped loading stopped guarding. */
  gatesSkipped: Array<{ id: string; reason: string }>;
  /** One entry per `delivery:` block in tenant.yaml. Empty when none declared. */
  delivery: DeliveryReport[];
}

/**
 * What a step is assumed to cost before it runs, for cheapest-capable ranking
 * only. It is an ESTIMATE and is never written to the audit table; the table
 * only ever records what a session log reported.
 */
const STEP_ESTIMATE = { inputTokens: 8_000, outputTokens: 1_000 };

/**
 * Take every target drawing on one exhausted allowance out of the catalog.
 *
 * Models sharing a `quotaDomain` run out together, so retiring only the model
 * that reported 429 would just route to a sibling on the same spent pool. A
 * model on its own domain — spark, on its separate allowance — is untouched,
 * which is the entire reason the field exists.
 *
 * @returns how many targets were retired.
 */
export function retireQuotaDomain(
  catalog: CapabilityCatalog,
  providers: readonly Provider[],
  quotaDomain: string,
): number {
  let retired = 0;
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.quotaDomain !== quotaDomain) continue;
      const targetId = ExecutionTargetId(`${provider.id}:${model.id}`);
      if (catalog.get(targetId) === undefined) continue;
      catalog.setAvailability(targetId, { state: "quota-exhausted" });
      retired += 1;
    }
  }
  return retired;
}

/** Register every live provider's models as opaque routing targets. */
export function registerProviders(
  catalog: CapabilityCatalog,
  providers: readonly Provider[],
): void {
  for (const provider of providers) {
    for (const model of provider.models) {
      const profile: TargetProfile = {
        targetId: ExecutionTargetId(`${provider.id}:${model.id}`),
        capabilities: [...model.caps],
        // A flat-rate route registers UNPRICED, so the router ranks it last
        // instead of reading 0/token as the cheapest thing on the menu.
        ...(model.unmetered === true
          ? {}
          : {
              price: {
                usdIn: model.usdIn,
                usdOut: model.usdOut,
                ...(provider.overheadTokens === 0
                  ? {}
                  : { overheadInputTokens: provider.overheadTokens }),
              },
            }),
        operations:
          model.maxContextTokens === undefined
            ? {}
            : { maxContextTokens: model.maxContextTokens },
        supports: {
          structuredOutput: model.caps.includes("structured.output"),
          toolIsolation: true,
          mutations: false,
        },
      };
      catalog.register(profile);
    }
  }
}

/** How the runner reaches a live provider's runtime. Supplied by the caller. */
export interface ModelExecutor {
  run(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    structured?: unknown;
    events: Array<{ type: string; seq: number; time: number; data: unknown }>;
  }>;
}

export interface RunOptions {
  tenant: LoadedTenant;
  audit: AuditStore;
  pluginsDir: string;
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  /** Injected in tests; discovered by glob when absent. */
  providers?: Provider[];
  providersSkipped?: Array<{ id: string; reason: string }>;
  tools?: EcosystemTool[];
  /** Injected in tests; loaded from the tenant's `lib/gates/` when absent. */
  gates?: Gate[];
  /** Injected in tests; discovered from `plugins/delivery-*` when absent. */
  channels?: Channel[];
  modelExecutor?: ModelExecutor;
  catalog?: CapabilityCatalog;
  signal?: AbortSignal;
}

/** The single required string parameter of a tool, if it has exactly one. */
function singleStringParam(tool: EcosystemTool): string | undefined {
  const shape = (
    tool.paramsSchema as unknown as { shape?: Record<string, unknown> }
  ).shape;
  if (shape === undefined) return undefined;
  const keys = Object.keys(shape);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * A gate is its own audited step (design §3): it runs BEFORE the model call it
 * guards, so a refusal costs one zero-token span instead of a whole call. The
 * span carries `toolName: "gate:<id>"` so the §5 query separates gate cost from
 * model cost without a second table.
 */
async function runGates(
  gates: readonly Gate[],
  phase: "input" | "output",
  input: unknown,
  ctx: {
    audit: AuditStore;
    runId: string;
    tenant: string;
    role: string;
    taskId: string;
    stepNo: number;
    remainingUsd: number;
  },
): Promise<{ ran: number; refusals: Array<{ id: string; reason: string }> }> {
  const refusals: Array<{ id: string; reason: string }> = [];
  const applicable = gates.filter(
    (gate) =>
      gate.phase === phase &&
      (gate.appliesTo.includes("*") || gate.appliesTo.includes(ctx.role)),
  );
  for (const gate of applicable) {
    const startedAt = Date.now();
    // A gate that THROWS is a refusal, never a pass. Failing open would make a
    // broken guard indistinguishable from a satisfied one.
    let verdict: { pass: boolean; reason: string };
    try {
      verdict = await gate.check(input, {
        runId: ctx.runId,
        role: ctx.role,
        remainingUsd: ctx.remainingUsd,
      });
    } catch (error: unknown) {
      verdict = {
        pass: false,
        reason: `gate threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    ctx.audit.append({
      runId: ctx.runId,
      spanId: `gate:${ctx.taskId}:${gate.id}`,
      tenant: ctx.tenant,
      role: ctx.role,
      provider: "none",
      model: "none",
      stepNo: ctx.stepNo,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costUsd: 0,
      toolName: `gate:${gate.id}`,
      toolOutputBytes: Buffer.byteLength(verdict.reason, "utf8"),
      summarised: false,
      ts: new Date().toISOString(),
    });
    if (!verdict.pass) refusals.push({ id: gate.id, reason: verdict.reason });
  }
  return { ran: applicable.length, refusals };
}

export async function runTenant(options: RunOptions): Promise<RunReport> {
  const env = options.env ?? process.env;
  const runId = options.runId ?? `run-${randomUUID()}`;
  const { spec, manifest } = options.tenant;

  const discovered =
    options.providers === undefined
      ? await discoverProviders(options.pluginsDir)
      : { live: options.providers, skipped: options.providersSkipped ?? [] };
  const tools =
    options.tools ??
    (await loadTenantTools(options.tenant.dir, {
      stateRoot: options.stateRoot,
      env,
    }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const loadedGates =
    options.gates === undefined
      ? await loadGates(options.tenant.dir)
      : { gates: options.gates, skipped: [] };
  const channels =
    options.channels ??
    (spec.delivery.length === 0
      ? []
      : (await discoverChannels(options.pluginsDir)).channels);

  const catalog = options.catalog ?? new (await import("@helium/core")).CapabilityCatalog();
  if (options.catalog === undefined) registerProviders(catalog, discovered.live);

  // A live provider knows how to execute (discovery drops the ones that do
  // not), so model mode no longer waits for an injected executor. The option
  // stays as an override, which is how the tests drive this without a network.
  const mode: "model" | "tool-only" =
    discovered.live.length > 0 ? "model" : "tool-only";

  const report: RunReport = {
    runId,
    tenant: spec.tenant,
    mode,
    providersLive: discovered.live.map((p) => p.id),
    providersSkipped: discovered.skipped,
    steps: [],
    outcome: "completed",
    gatesSkipped: loadedGates.skipped,
    delivery: [],
  };

  const signal = options.signal ?? new AbortController().signal;
  let stepNo = 0;

  tasks: for (const taskId of topologicalOrder(manifest)) {
    const task = manifest.tasks.find((entry) => entry.id === taskId)!;
    const role = manifest.roles[task.role]!;

    const budget = remaining(options.audit, runId, spec.budget);
    if (budget.exhausted) {
      report.outcome = "failed";
      report.failure = {
        class: "budget-exhausted",
        detail: `${spec.tenant} run ${runId} ran out of ${budget.reason} before task ${taskId}`,
      };
      break tasks;
    }

    // Doctrine 4: the agent is TOLD what is left. In model mode this line is
    // what the system-prompt assembly seam injects; here it is prepended to
    // the step prompt so the same text reaches the model either way.
    const line = budgetLine(budget, spec.budget);
    const work: WorkOrder = WorkOrderSchema.parse({
      id: `${runId}:${taskId}`,
      role: task.role,
      taskClass: taskId,
      requires: [...task.requires],
      constraints: {
        tools: [...role.permissions.tools],
        mutations: role.permissions.mutations,
        minIsolationClass: "in-process",
      },
      inputs: {
        artifacts: [],
        prompt: [line, role.persona ?? "", task.prompt ?? taskId]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
      acceptance: { outputSchema: "text" },
    });

    // Input gates guard the STEP, so they run in tool-only mode too: a guard
    // that only exists when a model is live is not a guard.
    const input = await runGates(loadedGates.gates, "input", work, {
      audit: options.audit,
      runId,
      tenant: spec.tenant,
      role: task.role,
      taskId,
      stepNo: stepNo + 1,
      remainingUsd: budget.usd,
    });
    if (input.ran > 0) stepNo += 1;
    if (input.refusals.length > 0) {
      report.steps.push({
        task: taskId,
        role: task.role,
        mode,
        text: "",
        failure: "gate-refused",
        gateRefusals: input.refusals,
      });
      continue;
    }

    // A step that requires no capability is deterministic BY DECLARATION, not
    // by circumstance: it takes the same tool path a provider-less run takes,
    // but says so under its own name so the report never reads as a degraded
    // model run.
    const deterministic = task.requires.length === 0;
    if (mode === "tool-only" || deterministic) {
      stepNo += 1;
      const outputs: string[] = [];
      for (const name of role.permissions.tools) {
        const tool = toolsByName.get(name);
        if (tool === undefined) {
          outputs.push(`${name}: not built by this tenant`);
          continue;
        }
        const key = singleStringParam(tool);
        if (key === undefined) {
          outputs.push(`${name}: skipped, no single string parameter to feed`);
          continue;
        }
        const startedAt = Date.now();
        const value = await tool.run({ [key]: task.prompt ?? taskId });
        const span: Span = {
          runId,
          spanId: `tool:${taskId}:${name}`,
          tenant: spec.tenant,
          role: task.role,
          provider: "none",
          model: "none",
          stepNo,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          contextSize: 0,
          latencyMs: Math.max(0, Date.now() - startedAt),
          costUsd: 0,
          toolName: name,
          toolOutputBytes: Buffer.byteLength(value, "utf8"),
          summarised: false,
          ts: new Date().toISOString(),
        };
        options.audit.append(span);
        outputs.push(`${name} -> ${value}`);
      }
      const text =
        outputs.length === 0
          ? "(no tools declared for this role)"
          : outputs.join("\n");
      const out = await runGates(loadedGates.gates, "output", { text }, {
        audit: options.audit,
        runId,
        tenant: spec.tenant,
        role: task.role,
        taskId,
        stepNo: stepNo + 1,
        remainingUsd: budget.usd,
      });
      if (out.ran > 0) stepNo += 1;
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: deterministic ? "deterministic" : "tool-only",
        text,
        ...(out.refusals.length === 0
          ? {}
          : { failure: "gate-refused", gateRefusals: out.refusals }),
      });
      continue;
    }

    // One re-route per step, and only for a spent quota. A pool that is out
    // stays out for the rest of the run: the vendor's reset hint is opaque, so
    // re-offering a sibling on the same allowance would just spend a second
    // call to learn the same thing.
    let attempt = 0;
    for (;;) {
      const decision = select(work, catalog.snapshot(), {
        budget: projection(budget, STEP_ESTIMATE),
      });
      if (decision.selected === undefined) {
        report.outcome = "failed";
        report.failure = {
          class: decision.failure?.class ?? "capability-shortage",
          detail: decision.failure?.reasons.join("; ") ?? "no target",
        };
        break tasks;
      }

      const [providerId, ...rest] = String(decision.selected).split(":");
      const routedModel = rest.join(":");
      const provider = discovered.live.find((entry) => entry.id === providerId)!;
      // The provider decides effort and its own runtime options; the MODEL is
      // the router's, not a second choice made without the catalog. Letting
      // `select` re-pick here would re-offer a model this run already retired.
      const selection: ModelSelection = {
        ...provider.select({
          role: task.role,
          requires: [...task.requires],
          projectedInputTokens: STEP_ESTIMATE.inputTokens,
          projectedOutputTokens: STEP_ESTIMATE.outputTokens,
        }),
        targetId: decision.selected,
        model: routedModel,
      };
      const model = provider.models.find((entry) => entry.id === selection.model);

      const executor: ModelExecutor =
        options.modelExecutor ?? {
          run: async (order, sel, sig) => provider.run!(order, sel, sig),
        };

      let result: Awaited<ReturnType<ModelExecutor["run"]>>;
      try {
        result = await executor.run(work, selection, signal);
      } catch (error: unknown) {
        const failure =
          error instanceof ProviderRunFailure ? error : undefined;
        const retired =
          failure?.quotaDomain === undefined
            ? 0
            : retireQuotaDomain(catalog, discovered.live, failure.quotaDomain);
        if (retired > 0 && attempt === 0) {
          attempt += 1;
          report.steps.push({
            task: taskId,
            role: task.role,
            mode: "model",
            targetId: String(decision.selected),
            downgradeReason: `quota domain ${failure!.quotaDomain!} exhausted; ${String(retired)} target(s) retired for this run`,
            text: "",
            failure: "quota-exhausted",
          });
          continue;
        }
        report.outcome = "failed";
        report.failure = {
          class: failure?.failureClass ?? "provider-error",
          detail: error instanceof Error ? error.message : String(error),
        };
        break tasks;
      }

      const spans = foldSessionLog(result.events, {
        runId,
        tenant: spec.tenant,
        role: task.role,
        provider: provider.id,
        model: selection.model,
        stepOffset: stepNo,
        ...(model === undefined
          ? {}
          : { price: { usdIn: model.usdIn, usdOut: model.usdOut } }),
      });
      options.audit.appendAll(spans);
      stepNo += spans.filter((span) => span.toolName === undefined).length;

      // Output gates see what the model produced. A refusal here does NOT
      // discard the text — the step ran and was paid for; it marks it so the
      // tenant's renderer can route it (design §7: a failed gate is normal
      // operation, not an error).
      const out = await runGates(loadedGates.gates, "output", result, {
        audit: options.audit,
        runId,
        tenant: spec.tenant,
        role: task.role,
        taskId,
        stepNo: stepNo + 1,
        remainingUsd: budget.usd,
      });
      if (out.ran > 0) stepNo += 1;
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: "model",
        targetId: String(decision.selected),
        ...(decision.downgradeReason === undefined
          ? {}
          : { downgradeReason: decision.downgradeReason }),
        text: result.text,
        ...(out.refusals.length === 0
          ? {}
          : { failure: "gate-refused", gateRefusals: out.refusals }),
      });
      break;
    }
  }

  // Delivery runs even when the run FAILED. Design §7: silence is
  // indistinguishable from a dead cron, which is the failure mode that killed
  // the job this tenant replaces. A degraded report is still a report.
  const brake = env.HELIUM_TENANT_DELIVERY === "1";
  for (const entry of spec.delivery) {
    if (!brake) {
      report.delivery.push({
        channel: entry.channel,
        state: "skipped",
        detail: "operator brake: HELIUM_TENANT_DELIVERY is not 1",
      });
      continue;
    }
    const channel = channels.find((candidate) => candidate.id === entry.channel);
    if (channel === undefined) {
      report.delivery.push({
        channel: entry.channel,
        state: "failed",
        detail: `no delivery-${entry.channel} plugin with a built lib/channel.js`,
      });
      continue;
    }
    const startedAt = Date.now();
    let outcome: DeliveryReport;
    try {
      const result = await channel.deliver(
        {
          tenant: spec.tenant,
          runId,
          subject: deliverySubject(report),
          body: deliveryBody(report),
        },
        entry.config,
      );
      outcome = {
        channel: entry.channel,
        state: result.state,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    } catch (error: unknown) {
      outcome = {
        channel: entry.channel,
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    stepNo += 1;
    options.audit.append({
      runId,
      spanId: `delivery:${entry.channel}`,
      tenant: spec.tenant,
      role: "delivery",
      provider: "none",
      model: "none",
      stepNo,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costUsd: 0,
      toolName: `delivery:${entry.channel}`,
      toolOutputBytes: Buffer.byteLength(outcome.detail ?? outcome.state, "utf8"),
      summarised: false,
      ts: new Date().toISOString(),
    });
    report.delivery.push(outcome);
  }

  return report;
}

/**
 * The email IS the artifact (design §7.1), so rendering it is deterministic
 * template work and never another model call — a role that only reformats an
 * earlier role's output is the kind of ceremony doctrine 6 deletes.
 */
function deliverySubject(report: RunReport): string {
  const day = new Date().toISOString().slice(0, 10);
  const tag =
    report.outcome === "failed"
      ? "[FAILED] "
      : report.mode === "tool-only"
        ? "[DEGRADED] "
        : "";
  return `${tag}helium ${report.tenant} ${day}`;
}

function deliveryBody(report: RunReport): string {
  const lines = [`run ${report.runId}  tenant ${report.tenant}  mode ${report.mode}`];
  for (const skip of report.providersSkipped) {
    lines.push(`provider skipped: ${skip.id} — ${skip.reason}`);
  }
  for (const skip of report.gatesSkipped) {
    lines.push(`gate failed to load: ${skip.id} — ${skip.reason}`);
  }
  for (const step of report.steps) {
    lines.push("", `── ${step.task} (${step.role})`);
    for (const refusal of step.gateRefusals ?? []) {
      lines.push(`   gate ${refusal.id} refused: ${refusal.reason}`);
    }
    if (step.text !== "") lines.push(step.text);
  }
  lines.push("");
  lines.push(
    report.outcome === "completed"
      ? `outcome: completed (${report.steps.length} steps)`
      : `outcome: FAILED ${report.failure?.class} — ${report.failure?.detail}`,
  );
  return lines.join("\n");
}

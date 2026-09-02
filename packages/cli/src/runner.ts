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
      // Only a target that was still SERVING counts. Retiring is idempotent —
      // the entry stays in the catalog, marked unavailable — so counting it
      // again on a second call reports progress that did not happen. The
      // re-route loop uses this number as its termination condition, and an
      // always-positive count is an infinite loop.
      if (!catalog.available(targetId)) continue;
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

/**
 * The arguments a deterministic step can hand a tool, or undefined when it
 * cannot supply what the tool demands.
 *
 * NO ARGUMENTS COMES FIRST. A tool whose parameters are all optional — every
 * IB tool that reads an account, the TradingView list with no colour filter —
 * wants to be called with nothing, and the older rule ("find the one string
 * parameter") skipped every one of them as unfeedable. That skip was silent
 * and total: the tools that need no input are exactly the tools a universe
 * step exists to call.
 */
function toolArgs(tool: EcosystemTool, text: string): Record<string, unknown> | undefined {
  const schema = tool.paramsSchema as unknown as {
    safeParse?: (value: unknown) => { success: boolean };
  };
  if (schema.safeParse?.({})?.success === true) return {};
  const key = singleStringParam(tool);
  return key === undefined ? undefined : { [key]: text };
}

/**
 * The single string parameter of a tool, if it has exactly one and that one
 * actually accepts a string.
 *
 * The type check is not pedantry: this is how the tool-only path feeds a step's
 * prompt to a tool, and a tool whose one parameter is an ARRAY was being handed
 * a string and reported as a tool failure — a validation error dressed up as an
 * unreachable service. Asking the schema whether it accepts a string is
 * version-proof in a way that reaching into zod internals is not.
 */
function singleStringParam(tool: EcosystemTool): string | undefined {
  const shape = (
    tool.paramsSchema as unknown as {
      shape?: Record<string, { safeParse?: (value: unknown) => { success: boolean } }>;
    }
  ).shape;
  if (shape === undefined) return undefined;
  const keys = Object.keys(shape);
  if (keys.length !== 1) return undefined;
  const field = shape[keys[0]!];
  return field?.safeParse?.("probe")?.success === true ? keys[0] : undefined;
}

/**
 * What a step's declared dependencies produced.
 *
 * `dependsOn` used to order the DAG and pass NOTHING: every step ran as an
 * independent subagent with no memory of the run, so a summarising role
 * answered "I don't have access to the prior steps" — verified in a real run.
 * A team lane whose steps cannot hand off is a sequence, not a team.
 *
 * ponytail: whole prior outputs, verbatim. Design §5 wants large tool outputs
 * summarised before they enter a context; when a hand-off first blows a
 * context window, that summariser is where this belongs.
 */
function handoff(
  task: { dependsOn: readonly string[] },
  produced: ReadonlyMap<string, string>,
): string {
  const parts = task.dependsOn
    .map((id) => {
      const text = produced.get(id);
      return text === undefined || text === "" ? undefined : `### ${id}\n${text}`;
    })
    .filter((part) => part !== undefined);
  return parts.length === 0 ? "" : `Output of the steps this one depends on:\n\n${parts.join("\n\n")}`;
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
  // The skip REASONS are kept, not just the channels: a declared channel that
  // did not load is reported with why it did not. "no built lib/channel.js" was
  // once printed for a plugin whose lib/channel.js was sitting right there —
  // the real reason was a bad default export, and the message sent the reader
  // to rebuild something that was already built.
  const loadedChannels =
    options.channels === undefined && spec.delivery.length > 0
      ? await discoverChannels(options.pluginsDir)
      : { channels: options.channels ?? [], skipped: [] as Array<{ id: string; reason: string }> };
  const channels = loadedChannels.channels;

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
  /** Each completed step's output, for the steps that declared they need it. */
  const produced = new Map<string, string>();

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
        artifacts: task.dependsOn.map((id) => `step:${id}`),
        prompt: [line, role.persona ?? "", handoff(task, produced), task.prompt ?? taskId]
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
        const args = toolArgs(tool, task.prompt ?? taskId);
        if (args === undefined) {
          outputs.push(`${name}: skipped, needs parameters this step cannot supply`);
          continue;
        }
        const startedAt = Date.now();
        // A tool that cannot reach its service THROWS, by design — that is how
        // it avoids returning an invented number. Catching it here is what
        // makes spec §7 possible: an unreachable IB Gateway degrades the report
        // it appears in, it does not take the run down. The failure text is
        // recorded as the tool's output so the reason reaches the email.
        let value: string;
        try {
          value = await tool.run(args);
        } catch (error: unknown) {
          value = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
        }
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
      // A step that ran no tool has nothing OF ITS OWN to say — but it is still
      // in the chain, and its output is what every dependent receives instead
      // of its dependencies'. Emitting a placeholder there silently starved
      // every downstream step: a 190-ticker universe reached the screen step
      // and stopped, and the two roles after it correctly reported that nobody
      // had given them anything to work on. Forwarding is not a substitute for
      // the work: the text says plainly that nothing was applied.
      const inherited = handoff(task, produced);
      const text =
        outputs.length > 0
          ? outputs.join("\n")
          : inherited === ""
            ? "(no tools declared for this role, and nothing upstream to forward)"
            : `(no tools declared for this role; forwarding its input unchanged)\n\n${inherited}`;
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
      produced.set(taskId, text);
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

    // Re-route only on a spent quota, and only while each failure RETIRES
    // something. A pool that is out stays out for the rest of the run: the
    // vendor's reset hint is opaque, so re-offering a sibling on the same
    // allowance would just spend a second call to learn the same thing.
    //
    // The loop is bounded by the catalog, not by a counter. Every retry has
    // strictly fewer targets to choose from than the one before it, and `select`
    // fails outright when none are left — so "retired something" is a safe
    // condition, and a fixed budget of one was simply wrong: an account with
    // three separately-metered tiers needs two hops to reach the third.
    for (;;) {
      const decision = select(work, catalog.snapshot(), {
        budget: projection(budget, STEP_ESTIMATE),
      });
      if (decision.selected === undefined) {
        // A capability nothing can serve degrades THIS STEP, not the run. It
        // reads as a run-ending condition only if you assume the shortage is
        // permanent, and the commonest cause is the opposite: a tier that hit
        // its rate limit two lines above and was retired, leaving the one
        // capability only it declared. Losing every other step's work — and
        // the report that carries them — to a transient 429 on one model is
        // the failure mode the delivery block below already refuses to accept.
        report.steps.push({
          task: taskId,
          role: task.role,
          mode: "model",
          text: "",
          failure: decision.failure?.class ?? "capability-shortage",
          downgradeReason: decision.failure?.reasons.join("; ") ?? "no target",
        });
        break;
      }

      const [providerId, ...rest] = String(decision.selected).split(":");
      const routedModel = rest.join(":");
      const provider = discovered.live.find((entry) => entry.id === providerId)!;
      // The provider decides effort and its own runtime options; the MODEL is
      // the router's, not a second choice made without the catalog. Letting
      // `select` re-pick here would re-offer a model this run already retired.
      const chosen = provider.select({
        role: task.role,
        requires: [...task.requires],
        projectedInputTokens: STEP_ESTIMATE.inputTokens,
        projectedOutputTokens: STEP_ESTIMATE.outputTokens,
      });
      const selection: ModelSelection = {
        ...chosen,
        targetId: decision.selected,
        model: routedModel,
        // A provider that executes a tool-using role needs the tool
        // IMPLEMENTATIONS; the work order carries names only. `options` is the
        // provider-opaque bag core never reads into, which makes it the right
        // channel: the dataflow stays explicit and per-step, where a module or
        // process global would leak between concurrent runs.
        options: {
          ...(chosen.options ?? {}),
          ...(role.permissions.tools.length === 0
            ? {}
            : {
                tools: role.permissions.tools
                  .map((name) => toolsByName.get(name))
                  .filter((tool) => tool !== undefined),
              }),
        },
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
        if (retired > 0) {
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
        // Span ids repeat across sessions; the task is what makes them unique
        // within a run. Without this the audit table silently drops every step
        // after the first.
        scope: taskId,
        ...(model === undefined
          ? {}
          : { price: { usdIn: model.usdIn, usdOut: model.usdOut } }),
      });
      options.audit.appendAll(spans);
      stepNo += spans.filter((span) => span.toolName === undefined).length;

      // A model step whose session log reported NO usage did not reach a
      // model. Recording it as completed would put an empty step in the report
      // and nothing in the audit table — the run would look cheap because it
      // silently did less, which is the one thing the audit must never do.
      // Zero tokens is the tell, not the absence of a span: a route that did
      // not serve the request still emits a step span, it just has nothing in
      // it. `spans.some(...)` alone therefore matched a step that never ran.
      const billed = spans.some(
        (span) =>
          span.toolName === undefined &&
          span.inputTokens + span.outputTokens > 0,
      );
      const emptyRun = !billed && result.text.trim() === "";

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
      produced.set(taskId, result.text);
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: "model",
        targetId: String(decision.selected),
        ...(decision.downgradeReason === undefined
          ? {}
          : { downgradeReason: decision.downgradeReason }),
        text: result.text,
        ...(emptyRun
          ? {
              failure: "no-model-output",
              downgradeReason:
                "the session log reported no usage and no text: this step did not reach a model",
            }
          : {}),
        ...(out.refusals.length === 0
          ? {}
          : { failure: "gate-refused", gateRefusals: out.refusals }),
      });
      break;
    }
  }

  // A run whose loop reached the end is not a run that SUCCEEDED. Steps now
  // degrade in place rather than ending the run — a gate refusal, a capability
  // nothing can serve — and without this the report said "completed" over the
  // top of them. The class comes from the first failed step because the first
  // one is usually the cause and the rest the consequence.
  if (report.outcome === "completed") {
    // Keyed by TASK, not by step row: a quota re-route leaves a failed row
    // behind for the attempt that was retired, and the retry that succeeded is
    // a second row for the same task. Counting rows would report a run as
    // failed precisely because the re-route worked.
    const succeeded = new Set(
      report.steps.filter((step) => step.failure === undefined).map((step) => step.task),
    );
    const failed = report.steps.filter(
      (step) => step.failure !== undefined && !succeeded.has(step.task),
    );
    if (failed.length > 0) {
      report.outcome = "failed";
      report.failure = {
        class: failed[0]!.failure!,
        detail: `${String(failed.length)} of ${String(report.steps.length)} steps failed: ${failed
          .map((step) => step.task)
          .join(", ")}`,
      };
    }
  }

  // Delivery runs even when the run FAILED. Design §7: silence is
  // indistinguishable from a dead cron, which is the failure mode that killed
  // the job this tenant replaces. A degraded report is still a report.
  // The brake guards EGRESS, so the channel is resolved first and only then
  // asked whether it leaves the machine. Checking the brake first would have
  // meant an operator must arm outbound mail to get a report written to their
  // own disk — and a channel that never declares itself is treated as external,
  // so forgetting the flag brakes rather than sends.
  const brake = env.HELIUM_TENANT_DELIVERY === "1";
  for (const entry of spec.delivery) {
    const channel = channels.find((candidate) => candidate.id === entry.channel);
    if (channel === undefined) {
      const why = loadedChannels.skipped.find(
        (skip) => skip.id === `delivery-${entry.channel}`,
      )?.reason;
      report.delivery.push({
        channel: entry.channel,
        state: "failed",
        detail: `delivery-${entry.channel} did not load: ${why ?? "no such plugin under plugins/"}`,
      });
      continue;
    }
    if (channel.external !== false && !brake) {
      report.delivery.push({
        channel: entry.channel,
        state: "skipped",
        detail: "operator brake: HELIUM_TENANT_DELIVERY is not 1",
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

/**
 * What a person reads. Not a transcript of the run.
 *
 * The first version pasted every tool's raw output into the body, so a report
 * opened with a 190-element ticker array and an entire IB portfolio in JSON,
 * and the one thing worth reading — what the roles concluded — was somewhere
 * below the fold. A tool that SUCCEEDED gets one line saying so and its size;
 * a tool that FAILED gets its message in full, because that message is the
 * reason a number is missing further down. The raw payloads are not lost: the
 * audit table records every span, and `helium audit <run>` is one line away.
 */
function deliveryBody(report: RunReport): string {
  const lines: string[] = [];
  const failures = report.steps.flatMap((step) => step.gateRefusals ?? []);
  lines.push(
    report.outcome === "completed"
      ? `**Outcome:** completed, ${String(report.steps.length)} steps.`
      : `**Outcome:** FAILED — ${report.failure?.class ?? "unknown"}: ${report.failure?.detail ?? ""}`,
  );
  if (report.mode === "tool-only") {
    lines.push("", "_No live provider: no model ran, so nothing below was reasoned about._");
  }
  for (const skip of report.providersSkipped) lines.push(`- provider unavailable: ${skip.id} — ${skip.reason}`);
  for (const skip of report.gatesSkipped) lines.push(`- **gate failed to load:** ${skip.id} — ${skip.reason}`);
  for (const refusal of failures) lines.push(`- gate \`${refusal.id}\` refused: ${refusal.reason}`);

  for (const step of report.steps) {
    lines.push("", `## ${step.task} — ${step.role}`);
    if (step.targetId !== undefined) lines.push(`\`${step.targetId}\``, "");
    if (step.downgradeReason !== undefined) lines.push(`> ${step.downgradeReason}`, "");
    const summarised = summariseToolLines(step.text);
    if (summarised !== "") lines.push(summarised);
  }
  lines.push("", `Full per-step tokens and cost: \`helium audit ${report.runId}\``);
  return lines.join("\n");
}

/**
 * Collapse the `name -> payload` lines a deterministic step emits.
 *
 * A step that ran no model has no prose of its own — its text IS the tool
 * output — so this is where a report either stays readable or turns into a
 * JSON dump. Anything that is not one of those lines is a role's own writing
 * and passes through untouched.
 */
function summariseToolLines(text: string): string {
  // A role that was asked to answer in JSON answers in JSON, and a bare JSON
  // object pasted into markdown renders as broken prose. Fencing it is the
  // whole fix — core must not know what the object MEANS (doctrine 2), only
  // that it is structured.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return ["```json", trimmed, "```"].join("\n");
    } catch {
      /* not JSON after all; fall through to the tool-line pass */
    }
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\w+) -> (.*)$/s.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const [, name, payload] = match as unknown as [string, string, string];
    out.push(
      payload.startsWith("FAILED:")
        ? `- **${name}** — ${payload.slice("FAILED:".length).trim()}`
        : `- ${name} — ok, ${String(Buffer.byteLength(payload, "utf8"))} bytes`,
    );
  }
  return out.join("\n").trim();
}

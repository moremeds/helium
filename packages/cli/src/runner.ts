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
  type EcosystemTool,
  type LoadedTenant,
  type ModelSelection,
  type Provider,
  type Span,
  type TargetProfile,
  type WorkOrder,
} from "@helium/core";
import { discoverProviders, loadTenantTools } from "./discovery.js";

export interface StepReport {
  task: string;
  role: string;
  mode: "model" | "tool-only";
  targetId?: string;
  downgradeReason?: string;
  text: string;
  failure?: string;
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
  };

  const signal = options.signal ?? new AbortController().signal;
  let stepNo = 0;

  for (const taskId of topologicalOrder(manifest)) {
    const task = manifest.tasks.find((entry) => entry.id === taskId)!;
    const role = manifest.roles[task.role]!;

    const budget = remaining(options.audit, runId, spec.budget);
    if (budget.exhausted) {
      report.outcome = "failed";
      report.failure = {
        class: "budget-exhausted",
        detail: `${spec.tenant} run ${runId} ran out of ${budget.reason} before task ${taskId}`,
      };
      return report;
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

    if (mode === "tool-only") {
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
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: "tool-only",
        text:
          outputs.length === 0
            ? "(no tools declared for this role)"
            : outputs.join("\n"),
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
        return report;
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
        return report;
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

      report.steps.push({
        task: taskId,
        role: task.role,
        mode: "model",
        targetId: String(decision.selected),
        ...(decision.downgradeReason === undefined
          ? {}
          : { downgradeReason: decision.downgradeReason }),
        text: result.text,
      });
      break;
    }
  }

  return report;
}

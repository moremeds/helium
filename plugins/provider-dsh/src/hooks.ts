/**
 * Where Helium attaches to the runtime (design §3), as ONE Cordis plugin.
 *
 * Four seams, all of them the runtime's own waterfall events rather than new
 * machinery of ours. Verified present in the pinned 0.1.2-alpha.3 type
 * declarations:
 *
 *   agent/pre-step         @deepseek-ai/dsh-agent        budget check + input gates
 *   tools/pre-execute      @deepseek-ai/dsh-tools        mutation refusal
 *   tools/post-execute     @deepseek-ai/dsh-tools        output-size policy
 *   system-prompt/assemble @deepseek-ai/dsh-system-prompt remaining-budget line
 *
 * `approval/request` (@deepseek-ai/dsh-user-approval) is the fifth seam the
 * design names. It is NOT installed here: that package is not a dependency of
 * the profile this repo boots, so attaching to it would register a handler for
 * an event nothing emits. A cron run is non-interactive and fails closed by
 * having no approver at all, which is the same outcome without the pretence.
 *
 * Everything numeric this file uses comes from `@helium/core`: the budget is
 * read from the audit table (folded from the session log), and the size policy
 * is core's. This file only wires.
 * @module dsh-plugin-provider-dsh/hooks
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import {
  applyOutputPolicy,
  budgetLine,
  remaining,
  type AuditStore,
  type Gate,
  type TenantBudget,
} from "@helium/core";

export interface HookConfig {
  runId: string;
  role: string;
  /** Both are needed together, and only by the two budget-aware seams. A
   *  caller that has neither — the provider does not: `Provider.run` is handed
   *  a work order, never the run's audit store — installs the other two seams
   *  and nothing pretends to know what the allowance is. */
  audit?: AuditStore;
  budget?: TenantBudget;
  gates?: Gate[];
  /** Byte ceiling over which a tool result is summarised. */
  summariseOverBytes?: number;
  summarise?: (bytes: string) => Promise<string>;
  spill?: (bytes: string) => Promise<string> | string;
  /** Tool names this run must refuse. Declared by the role, not guessed here. */
  mutatingTools?: ReadonlySet<string>;
  /** Called with the real byte count whenever an output was summarised. */
  onSummarised?: (bytes: number) => void;
}

/**
 * Install the seams on a context: all four with a budget, the other two
 * without one.
 *
 * @returns a disposer, so a run's hooks leave with the run.
 */
export function installHeliumHooks(
  ctx: Context,
  config: HookConfig,
): () => void {
  const disposers: Array<() => void> = [];
  const audit = config.audit;
  const budget = config.budget;

  // 1. system-prompt/assemble — the remaining-budget line. Doctrine 4: an
  //    agent that knows it is at 10% behaves differently.
  if (audit !== undefined && budget !== undefined) {
    disposers.push(
      ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const assembled = await next();
        const state = remaining(audit, config.runId, budget);
        const line = budgetLine(state, budget);
        const sections = (assembled as { sections?: unknown }).sections;
        if (Array.isArray(sections)) {
          sections.push({ id: "helium-budget", text: line });
        }
        return assembled;
      }),
    );

    // 2. agent/pre-step — budget check and input gates, BEFORE the model call,
    //    so a refusal costs a gate step rather than a model call.
    disposers.push(
      ctx.on("agent/pre-step", async (payload, next) => {
        const state = remaining(audit, config.runId, budget);
        if (state.exhausted) {
          throw new Error(
            `budget exhausted for run ${config.runId}: out of ${state.reason}`,
          );
        }
        for (const gate of config.gates ?? []) {
          if (gate.phase !== "input") continue;
          if (
            !gate.appliesTo.includes("*") &&
            !gate.appliesTo.includes(config.role)
          ) {
            continue;
          }
          const verdict = await gate.check(payload, {
            runId: config.runId,
            role: config.role,
            remainingUsd: state.usd,
          });
          if (!verdict.pass) {
            throw new Error(
              `gate ${gate.id} refused this step: ${verdict.reason}`,
            );
          }
        }
        return await next();
      }),
    );
  }

  // 3. tools/pre-execute — the mutation refusal. The sandbox write-boundary
  //    guard attaches at this same seam and lands with the sandbox kinds (M3).
  disposers.push(
    ctx.on("tools/pre-execute", async (exec, next) => {
      const decision = await next();
      if (decision.kind !== "allow") return decision;
      if (config.mutatingTools?.has(exec.name) === true) {
        return {
          kind: "deny",
          reason: `mutating tool ${exec.name} refused: this run declared no mutations`,
        };
      }
      return decision;
    }),
  );

  // 4. tools/post-execute — large-output summarisation and the byte count the
  //    audit row records.
  disposers.push(
    ctx.on("tools/post-execute", async (_exec, result, next) => {
      const decision = await next();
      if (decision.kind !== "accept" || result.isError) return decision;
      const text = result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (text === "") return decision;
      const policy = await applyOutputPolicy(text, {
        ...(config.summariseOverBytes === undefined
          ? {}
          : { overBytes: config.summariseOverBytes }),
        ...(config.summarise === undefined
          ? {}
          : { summarise: config.summarise }),
        ...(config.spill === undefined ? {} : { spill: config.spill }),
      });
      if (!policy.summarised) return decision;
      // The FULL bytes stayed in the sandbox; only the summary plus its path
      // enters the caller's context. The audit row keeps the real byte count.
      config.onSummarised?.(policy.bytes);
      return {
        kind: "accept",
        content: [{ type: "text", text: policy.text }],
        ...(decision.additionalContexts === undefined
          ? {}
          : { additionalContexts: decision.additionalContexts }),
      };
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}

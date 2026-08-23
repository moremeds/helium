/**
 * helium — umbrella cordis plugin. Wires each enabled job's state-change
 * triggers onto their own `ctx.effect` interval; other trigger kinds land in
 * later Phase 2 tasks.
 * @module dsh-plugin-helium
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { JsonlWriter, RunLedger, StateStore, loadJobs } from "@helium/core";
import { ConfigSchema, statePaths, type Config } from "./config.js";
import { StateChangePoller, type TriggerEvent } from "./sensor.js";

export const name = "helium";
export const inject = ["agentDefaultModel", "agents", "sessions", "tools"];
export { type Config } from "./config.js";

export function apply(ctx: Context, raw: Config): void {
  const cfg = ConfigSchema.parse(raw);
  const paths = statePaths(cfg);
  const store = new StateStore(paths.state);
  const jsonl = new JsonlWriter(paths.jsonl);
  const ledger = new RunLedger(jsonl);
  ledger.reconcileStartup();

  for (const job of loadJobs(cfg.jobsDir).filter((j) => j.enabled)) {
    const onTrigger = (ev: TriggerEvent): void => {
      jsonl.append("triggers", { ...ev });
    };
    for (const trigger of job.triggers) {
      if (trigger.kind !== "state-change") continue;
      const poller = new StateChangePoller({
        job: job.name,
        trigger,
        store,
        onTrigger,
      });
      ctx.effect(() => {
        const run = (): void => {
          void poller.tick().catch((error: unknown) => {
            console.error(`helium.sensor(${job.name}):`, error);
          });
        };
        const timer = setInterval(run, trigger.intervalMs);
        run();
        return () => {
          clearInterval(timer);
        };
      }, `helium.sensor.poll(${job.name})`);
    }
  }
}

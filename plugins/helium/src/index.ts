/**
 * helium — placeholder cordis plugin. Phase 1 proves the packaging, profile,
 * and deploy loop; the real toolkit/sensor/dispatch/delivery plugins land in
 * phase 2. The optional tick timer exists only so the contract suite can
 * prove `ctx.effect` fires inside a booted profile without any LLM call.
 * @module dsh-plugin-helium
 */
import { appendFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";

export const name = "helium";

export interface Config {
  /** Contract-test hook: when set, append one line every 100 ms to this path. */
  tickFile?: string;
}

/**
 * Mount the plugin.
 * @param ctx - the cordis context this plugin owns.
 * @param config - the row's config, composed from the profile patch layers.
 */
export function apply(ctx: Context, config: Config): void {
  console.log("helium plugin mounted");
  const tickFile = config.tickFile;
  if (tickFile === undefined || tickFile === "") return;
  ctx.effect(() => {
    const timer = setInterval(() => {
      appendFileSync(tickFile, `${new Date().toISOString()}\n`);
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, "helium.contract-tick()");
}

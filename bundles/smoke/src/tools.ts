/** SIMULATED data only: fixed fake prices for fake symbols. Never market data. */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { withAsOf } from "helium-base";

export const name = "smoke-tools";
export const inject = ["tools"];

export const SIMULATED_PRICES: Record<string, number> = { AAA: 100, BBB: 50 };

export function apply(ctx: { tools: { register(t: unknown): void } }): void {
  ctx.tools.register(
    defineTool({
      name: "smoke_quote",
      description: "SIMULATED quote for a smoke-test symbol. Not market data.",
      parameters: {
        symbol: { type: "string", description: "AAA or BBB", required: true },
        date: { type: "string", description: "yyyy-mm-dd; defaults to the run's as-of day" },
      },
      output: { schema: { type: "string" }, render: (_a: unknown, v: string) => [{ type: "text" as const, text: v }] },
      execute: withAsOf(async (args: { symbol: string; date?: string }, asOf: string) => {
        const date = args.date ?? asOf;
        process.stderr.write(`[smoke_quote] symbol=${args.symbol} date=${date} asOf=${asOf}\n`);
        return JSON.stringify({ symbol: args.symbol, date, simulatedPrice: SIMULATED_PRICES[args.symbol] ?? null });
      }),
    }),
  );
}

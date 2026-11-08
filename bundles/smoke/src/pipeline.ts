/**
 * The stage-1 acceptance pipeline, on SIMULATED data:
 * code task -> parallel analysts (one per key) -> judge picks from a
 * code-built menu -> ledger entry -> markdown. The next run settles the
 * previous run's entry before doing anything else.
 */
import { definePipeline, type Run } from "helium-base";

export const name = "smoke-pipeline";

const KEYS = ["AAA", "BBB"];

interface Signal {
  signal: "up" | "down" | "flat";
  reason: string;
}

async function run(run: Run): Promise<void> {
  // Code task: the menu is built by code; the judge can only pick from it.
  const menu = [...KEYS, "none"];
  const signals = await Promise.all(
    KEYS.map((key) =>
      run.agent<Signal>({
        role: "smoke-analyst",
        label: `smoke-analyst:${key}`,
        capability: "reason.quick",
        prompt: `Symbol ${key}. Call smoke_quote once for it (SIMULATED data), then submit a one-word signal and a one-sentence reason.`,
        schema: {
          type: "object",
          properties: { signal: { type: "string", enum: ["up", "down", "flat"] }, reason: { type: "string" } },
          required: ["signal", "reason"],
          additionalProperties: false,
        },
      }),
    ),
  );
  const pick = await run.agent<{ choice: string }>({
    role: "smoke-judge",
    capability: "reason.deep",
    prompt: `Analyst signals (SIMULATED): ${JSON.stringify(Object.fromEntries(KEYS.map((k, i) => [k, signals[i]])))}. Choose one id.`,
    schema: {
      type: "object",
      properties: { choice: { type: "string", enum: menu } },
      required: ["choice"],
      additionalProperties: false,
    },
  });
  if (!menu.includes(pick.choice)) throw new Error(`judge chose ${pick.choice}, not on the menu`);
  run.enter(pick.choice, run.asOf, { choice: pick.choice });
  const rows = KEYS.map((k, i) => `| ${k} | ${signals[i]!.signal} | ${signals[i]!.reason} |`);
  const out = await run.deliver("markdown", {
    subject: `smoke ${run.asOf}`,
    text: ["SIMULATED data.", "", "| key | signal | reason |", "|---|---|---|", ...rows, "", `Judge: **${pick.choice}**`].join("\n"),
  });
  run.log(`markdown ${out.state} ${out.detail}`);
}

export function apply(): void {
  definePipeline({
    name: "smoke",
    channels: ["markdown"],
    async settle(due, r) {
      return due.map((e) => ({ id: e.id, outcome: { settledOn: r.asOf } }));
    },
    run,
  });
}

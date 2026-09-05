/**
 * Two stub tools: no network, no domain, no filesystem.
 *
 * This tenant's job is to be removed and re-added without any edit to
 * `packages/core`, and to give `helium run fake-tenant` something real to
 * execute. A tool that reached a real service would make both drills depend on
 * something other than the seam they test.
 * @module dsh-plugin-tenant-fake/tools
 */
import { z } from "zod";
import type {
  Commitment,
  Receipt,
  Settler,
  ToolVocabularyEntry,
} from "@helium/core";

const ProbeParams = z.object({ q: z.string().min(1) });
const CountParams = z.object({ text: z.string().min(1) });

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["fake_probe", { mutating: false }],
  ["fake_count", { mutating: false }],
]);

export function buildTools(_cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
}) {
  return [
    {
      name: "fake_probe",
      description: "Echo the query back. Test seam only; touches nothing.",
      paramsSchema: ProbeParams,
      mutating: false,
      dshParams: {
        q: { type: "string", required: true, description: "Anything" },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        return JSON.stringify({ echoed: ProbeParams.parse(args).q });
      },
    },
    {
      // Deliberately trivial and deterministic: the point is that a tool call
      // produces a real audit row with real output bytes, not that the answer
      // is interesting.
      name: "fake_count",
      description: "Count the words and characters of a string. Touches nothing.",
      paramsSchema: CountParams,
      mutating: false,
      dshParams: {
        text: { type: "string", required: true, description: "Anything" },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { text } = CountParams.parse(args);
        return JSON.stringify({
          words: text.trim().split(/\s+/u).length,
          characters: text.length,
        });
      },
    },
  ];
}

/**
 * The seam proof for measurement, and nothing more.
 *
 * It settles everything it is handed with one constant score, so CI can prove
 * that a tenant can be measured — and removed — without any edit to
 * `packages/core`. A settler that computed something real would make the drill
 * depend on the computation instead of on the seam.
 */
export function buildSettler(_cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
  variant: string;
  asOf?: Date;
  calendar?: { weekdaysOnly: boolean; closed: string[] };
}): Settler {
  return {
    async settle(open: Commitment[], now: Date): Promise<Receipt[]> {
      return open.map((commitment) => ({
        commitmentId: commitment.id,
        // Overwritten by the runner with the id of the run that settled it.
        runId: "",
        settledAt: now.toISOString(),
        status: "settled",
        scores: { fakeScore: 1 },
      }));
    },
  };
}

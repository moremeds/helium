/**
 * One stub tool, no network, no domain. This tenant's only job is to be
 * removed and re-added in CI without any edit to packages/core or
 * plugins/helium; a tool that reached a real service would make that drill
 * depend on something other than the seam it is testing.
 * @module dsh-plugin-tenant-fake/tools
 */
import { z } from "zod";
import type { ToolVocabularyEntry } from "@helium/core";

const ProbeParams = z.object({ q: z.string().min(1) });

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["fake_probe", { mutating: false }],
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
  ];
}

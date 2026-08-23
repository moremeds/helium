/**
 * The standing-thesis tools: read/write through ThesisStore.
 * @module @helium/core/tools/thesis
 */
import { z } from "zod";
import { ThesisStore } from "../theses.js";
import type { EcosystemTool } from "./types.js";

const ReadParams = z.object({ job: z.string().min(1) });
const WriteParams = z.object({ job: z.string().min(1), content: z.string() });

/** helium-owned state: versioned, capped and diffed, so mutating stays false by design. */
export function thesisTools(stateRoot: string): EcosystemTool[] {
  const store = new ThesisStore(stateRoot);
  return [
    {
      name: "thesis_read",
      description:
        "Read the current thesis for a job. Returns {content} or {content: null}.",
      paramsSchema: ReadParams,
      mutating: false,
      async run(args) {
        const { job } = ReadParams.parse(args);
        return JSON.stringify({ content: store.read(job) });
      },
    },
    {
      name: "thesis_write",
      description:
        "Rewrite the thesis for a job. The write is versioned and capped at 64 KiB; the " +
        "returned unified diff is included in the delivery email. Never edit the file directly.",
      paramsSchema: WriteParams,
      mutating: false,
      async run(args) {
        const { job, content } = WriteParams.parse(args);
        return JSON.stringify(store.write(job, content));
      },
    },
  ];
}

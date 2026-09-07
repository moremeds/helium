/**
 * Three read-only tools, and deliberately no fourth.
 *
 * The reviewer must see the page, the frozen evidence behind it and the rubric
 * — and nothing else. Everything a fourth tool could reach (the run report, the
 * step JSON, the variant label, the author's own self-report) is exactly what
 * the Step 2 rules forbid it to see, so the smallest catalog that can do the
 * job is also the one that enforces the blindness. There is no settler: this
 * tenant promises nothing measurable about the future.
 * @module dsh-plugin-tenant-flash-review/tools
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolVocabularyEntry } from "@helium/core";

/**
 * The per-call ceiling on a recording's `raw`, in bytes.
 *
 * It exists because one recording in the samples is 44 KB of session frame and
 * a reviewer that pulls three of those has spent its context before it reaches
 * the rubric — doctrine 4's "large tool outputs are summarised before they
 * enter a context", applied at the only place that knows the shape. It is a
 * WINDOW, not a truncation: the reply carries `rawBytes` and `nextOffset`, so
 * a reviewer that needs the rest asks for the rest and nothing is silently
 * lost.
 */
export const MAX_RAW_BYTES = 20_000;

/** The page under review: one markdown file, no bigger than a page.
 *  A megabyte at this path is not a page, and reviewing it would blow the
 *  context on the first tool call. */
const MAX_PAGE_BYTES = 400_000;

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["fr_rubric", { mutating: false }],
  ["fr_page", { mutating: false, requiresEnv: "FR_PAGE" }],
  ["fr_evidence", { mutating: false, requiresEnv: "FR_EVIDENCE_DIR" }],
]);

const RubricParams = z.object({});
const PageParams = z.object({});
const EvidenceParams = z.object({
  file: z.string().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

/** One `NNNNN-<tool>.json.gz` under a run's `tool-io/`, as the runner wrote it
 *  (`packages/cli/src/tool-io.ts`). Verified against
 *  `docs/evidence/flash-samples/2026-09-06-weekly/tool-io/` on 2026-09-07:
 *  keys `tool, args, at, raw, rawSha256, rawBytes, context`, plus `error` on a
 *  call that threw. `rawSha256` and `context` are dropped from what the
 *  reviewer sees — neither can be checked against a page and both are pure
 *  context cost. */
interface Recording {
  tool: string;
  args?: unknown;
  at?: string;
  raw?: string;
  rawBytes?: number;
  error?: unknown;
}

/** A file name from the model, resolved under the evidence directory and
 *  refused if it points anywhere else. The reviewer is a model reading names
 *  out of an index it was handed; `..` in one is a bug or a prompt injection,
 *  and in neither case is it a file this tool should open. */
function recordingPath(dir: string, file: string): string {
  const name = basename(file);
  if (name !== file) throw new Error(`fr_evidence: not a recording name: ${file}`);
  return join(dir, name);
}

function readRecording(path: string): Recording {
  const bytes = readFileSync(path);
  const text = path.endsWith(".gz")
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  return JSON.parse(text) as Recording;
}

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key];
  if (value === undefined || value === "")
    throw new Error(`${key} is unset; nothing to review`);
  return value;
}

export function buildTools(cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
}) {
  // The rubric ships WITH the tenant and is read from the tenant's own
  // directory, not from an env path: a reviewer whose standard could be
  // pointed elsewhere per run is not a fixed rubric, which is the one property
  // Step 2 asks of it.
  const rubricPath = join(
    dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    "rubric.md",
  );
  return [
    {
      name: "fr_rubric",
      description:
        "The acceptance rubric: the failure signatures to look for, the positive requirements, and the verdict schema. Read it before the page.",
      paramsSchema: RubricParams,
      mutating: false,
      async run(): Promise<string> {
        return readFileSync(rubricPath, "utf8");
      },
    },
    {
      name: "fr_page",
      description:
        "The page under review, verbatim. One call returns the whole page; there is nothing else to fetch about it.",
      paramsSchema: PageParams,
      mutating: false,
      async run(): Promise<string> {
        const path = requireEnv(cfg.env, "FR_PAGE");
        const size = statSync(path).size;
        if (size > MAX_PAGE_BYTES)
          throw new Error(
            `fr_page: ${path} is ${String(size)} bytes, over the ${String(MAX_PAGE_BYTES)}-byte page ceiling`,
          );
        return readFileSync(path, "utf8");
      },
    },
    {
      name: "fr_evidence",
      description:
        "The frozen tool recordings behind the page. No arguments returns the index (file, tool, bytes, time). `file` returns that recording's arguments and raw response; `offset` continues one that was longer than the per-call byte window.",
      paramsSchema: EvidenceParams,
      mutating: false,
      dshParams: {
        file: {
          type: "string",
          description:
            "A recording file name from the index, e.g. 00005-ow_macro_rates.json.gz. Omit for the index.",
        },
        offset: {
          type: "number",
          description:
            "Byte offset into that recording's raw response. Omit for the start; use the index's nextOffset to continue.",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { file, offset } = EvidenceParams.parse(args);
        const dir = requireEnv(cfg.env, "FR_EVIDENCE_DIR");
        if (file === undefined) {
          const names = readdirSync(dir)
            .filter((name) => name.endsWith(".json.gz") || name.endsWith(".json"))
            .sort();
          const index = names.map((name) => {
            try {
              const record = readRecording(join(dir, name));
              return {
                file: name,
                tool: record.tool,
                at: record.at,
                rawBytes: record.rawBytes ?? (record.raw ?? "").length,
                ...(record.error === undefined ? {} : { error: true }),
              };
            } catch (error: unknown) {
              // An unreadable recording is a FACT about the evidence, not a
              // reason to lose the index: the reviewer has to be able to say
              // "the evidence for this claim could not be read".
              return {
                file: name,
                tool: "unreadable",
                unreadable:
                  error instanceof Error ? error.message : String(error),
              };
            }
          });
          return JSON.stringify({ dir, count: index.length, recordings: index });
        }
        const record = readRecording(recordingPath(dir, file));
        const raw = record.raw ?? "";
        const start = offset ?? 0;
        const window = raw.slice(start, start + MAX_RAW_BYTES);
        const end = start + window.length;
        return JSON.stringify({
          file,
          tool: record.tool,
          at: record.at,
          args: record.args,
          ...(record.error === undefined ? {} : { error: record.error }),
          rawBytes: raw.length,
          offset: start,
          raw: window,
          ...(end < raw.length ? { nextOffset: end, truncated: true } : {}),
        });
      },
    },
  ];
}

/**
 * Four read-only tools, and every one of them reads only the page, the frozen
 * evidence or the rubric.
 *
 * That boundary, not the count, is the rule. Anything a further tool could
 * reach — the run report, the step JSON, the variant label, the author's own
 * self-report — is exactly what the Step 2 rules forbid the reviewer to see,
 * so the catalog stays inside the three things a blind read is allowed. The
 * fourth tool, `fr_dated_events`, is a deterministic view OF the evidence
 * rather than a new source: it was added in calibration round 4 after three
 * rounds proved a model cannot be prompted into an exhaustive enumeration.
 * There is no settler: this tenant promises nothing measurable about the
 * future.
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

/**
 * The ceiling on how many dated items `fr_dated_events` returns.
 *
 * The list exists to be CHECKED, item by item, against the page. A list longer
 * than a reviewer will actually walk is a list it will skim, which is the
 * failure this tool was built to remove.
 */
export const MAX_DATED_EVENTS = 80;

/** Chars of surrounding text kept with each dated token. Enough to tell an
 *  FOMC meeting from an expiry from a bond auction; not enough to become a
 *  second copy of the recording. */
const SNIPPET_CHARS = 160;

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["fr_rubric", { mutating: false }],
  ["fr_page", { mutating: false, requiresEnv: "FR_PAGE" }],
  ["fr_evidence", { mutating: false, requiresEnv: "FR_EVIDENCE_DIR" }],
  ["fr_dated_events", { mutating: false, requiresEnv: "FR_EVIDENCE_DIR" }],
]);

const RubricParams = z.object({});
const PageParams = z.object({});
const EvidenceParams = z.object({
  file: z.string().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});
const DatedEventsParams = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
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

/** One dated token found in one recording. `token` is the text as the
 *  recording wrote it, because the PAGE may write the same day either way —
 *  `2026-09-16` in a JSON block, `9/16` in prose — and a reviewer searching for
 *  only one of the two forms finds nothing. */
export interface DatedEvent {
  date: string;
  token: string;
  tool: string;
  file: string;
  snippet: string;
}

/** `YYYY-MM-DD`, and `M/D` or `M/D/YYYY` with no digit or slash on either side
 *  (so `9/16` matches and `1/2/3/4`, `39758465` and a price ratio do not). */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/gu;
const SLASH_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/gu;

function snippetAround(raw: string, at: number, length: number): string {
  const pad = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  return raw
    .slice(Math.max(0, at - pad), at + length + pad)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SNIPPET_CHARS);
}

function valid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Every dated token one recording carries, deterministically.
 *
 * NO MODEL, no judgement about what is material, no idea what an FOMC is: this
 * hands back tokens and their surroundings and stops. Deciding which of them
 * had to reach the page is the reviewer's job — the point of the split is that
 * the reviewer CHECKS a list it did not build, because three calibration
 * rounds showed a model asked to build the list quietly builds a partial one.
 *
 * A bare `M/D` has no year of its own. It takes the year of the recording's
 * own `at` timestamp, which is the year the run happened in; `yearHint` is
 * that value, and a token that cannot be given a year is dropped rather than
 * guessed into a different one.
 */
export function datedEventsIn(
  record: Recording,
  file: string,
  yearHint?: number,
): DatedEvent[] {
  const raw = record.raw ?? "";
  const found: DatedEvent[] = [];
  for (const match of raw.matchAll(ISO_DATE)) {
    const token = match[0];
    const [year, month, day] = token.split("-").map(Number);
    if (!valid(year!, month!, day!)) continue;
    found.push({
      date: token,
      token,
      tool: record.tool,
      file,
      snippet: snippetAround(raw, match.index, token.length),
    });
  }
  const year =
    yearHint ??
    (record.at === undefined ? undefined : new Date(record.at).getUTCFullYear());
  if (year !== undefined && Number.isFinite(year)) {
    for (const match of raw.matchAll(SLASH_DATE)) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      const explicit = match[3] === undefined ? undefined : Number(match[3]);
      const resolved = explicit ?? year;
      if (!valid(resolved, month, day)) continue;
      found.push({
        date: iso(resolved, month, day),
        token: match[0],
        tool: record.tool,
        file,
        snippet: snippetAround(raw, match.index, match[0].length),
      });
    }
  }
  return found;
}

/**
 * Deduplicate only an identical occurrence, then order by date so the reviewer
 * walks a calendar rather than a directory listing.
 *
 * The snippet is part of the key. One date can carry distinct events in the
 * same recording; collapsing those into a date/token row made a page that
 * named one of them look complete. Repeated copies of the same occurrence
 * still collapse. A capped result is explicitly incomplete, so a reviewer may
 * not treat its returned prefix as an exhaustive calendar.
 */
export function collateDatedEvents(
  events: readonly DatedEvent[],
  window: { from?: string; to?: string },
  offset = 0,
): {
  events: DatedEvent[];
  total: number;
  offset: number;
  nextOffset?: number;
  truncated: boolean;
} {
  const seen = new Set<string>();
  const kept: DatedEvent[] = [];
  for (const event of events) {
    if (window.from !== undefined && event.date < window.from) continue;
    if (window.to !== undefined && event.date > window.to) continue;
    const key = `${event.date}|${event.tool}|${event.file}|${event.token}|${event.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(event);
  }
  kept.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.tool.localeCompare(b.tool) ||
      a.snippet.localeCompare(b.snippet),
  );
  const page = kept.slice(offset, offset + MAX_DATED_EVENTS);
  const nextOffset = offset + page.length;
  return {
    events: page,
    total: kept.length,
    offset,
    ...(nextOffset < kept.length ? { nextOffset } : {}),
    truncated: nextOffset < kept.length,
  };
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
        const rawText = record.raw ?? "";
        const start = offset ?? 0;
        const chunk = rawText.slice(start, start + MAX_RAW_BYTES);
        const end = start + chunk.length;
        return JSON.stringify({
          file,
          tool: record.tool,
          at: record.at,
          args: record.args,
          ...(record.error === undefined ? {} : { error: record.error }),
          rawBytes: rawText.length,
          offset: start,
          raw: chunk,
          ...(end < rawText.length ? { nextOffset: end, truncated: true } : {}),
        });
      },
    },
    {
      // The pre-pass that exists because the reviewer could not be talked into
      // doing it. Three calibration rounds asked a model to enumerate the
      // dated events in the evidence and then check the page against them; all
      // three produced a partial list that happened to omit the one event the
      // page was missing. Extraction is mechanical, so it moved into code, and
      // the model is left with the half only it can do: deciding which dated
      // item a reader had to be told about.
      name: "fr_dated_events",
      description:
        "Every dated token in the frozen recordings, extracted deterministically: date, the token as the recording wrote it (`2026-09-16` or `9/16`), the tool it came from and 160 chars of surrounding text. Narrow with `from`/`to`; when `nextOffset` is returned, call again with that offset and the identical window until it is absent. This is the list to CHECK the page against; do not build your own.",
      paramsSchema: DatedEventsParams,
      mutating: false,
      dshParams: {
        from: {
          type: "string",
          description:
            "Earliest date to return, YYYY-MM-DD. Omit for no lower bound.",
        },
        to: {
          type: "string",
          description:
            "Latest date to return, YYYY-MM-DD. Omit for no upper bound.",
        },
        offset: {
          type: "number",
          description:
            "Event offset for the next page. Omit for the first page; use nextOffset with the same from/to window until no nextOffset is returned.",
        },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { offset = 0, ...window } = DatedEventsParams.parse(args);
        const dir = requireEnv(cfg.env, "FR_EVIDENCE_DIR");
        const all: DatedEvent[] = [];
        const unreadable: Array<{ file: string; reason: string }> = [];
        for (const name of readdirSync(dir)
          .filter((file) => file.endsWith(".json.gz") || file.endsWith(".json"))
          .sort()) {
          try {
            all.push(...datedEventsIn(readRecording(join(dir, name)), name));
          } catch (error: unknown) {
            // Same rule as the index: an unreadable recording is a fact about
            // the evidence the reviewer needs, not a reason to return a list
            // that silently covers less than it claims to.
            unreadable.push({
              file: name,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const collated = collateDatedEvents(all, window, offset);
        return JSON.stringify({
          window,
          total: collated.total,
          offset: collated.offset,
          returned: collated.events.length,
          truncated: collated.truncated,
          ...(collated.nextOffset === undefined
            ? {}
            : { nextOffset: collated.nextOffset }),
          ...(unreadable.length === 0 ? {} : { unreadable }),
          events: collated.events,
        });
      },
    },
  ];
}

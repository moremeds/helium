/**
 * Run one tenant's team once.
 *
 *   tenant discovery -> provider discovery + probe -> capability catalog
 *     -> per task: budget check -> route -> execute -> fold into `span`
 *
 * Two execution modes, and the difference is recorded, never hidden:
 *
 *  - MODEL mode, when a provider probes live. The provider's runtime executes
 *    the step and hands back its session log; core folds that log into spans.
 *    Token counts are whatever the log reported and nothing else.
 *  - TOOL-ONLY mode, when no provider is live. The step's declared tools are
 *    invoked with the task's own prompt as their single string argument, and
 *    each call becomes a tool span with its real latency and output bytes. No
 *    model call happens, so no token count is produced -- and none is invented.
 *
 * A run whose budget cannot cover its next step ends `budget-exhausted`. It is
 * never quietly truncated to fit.
 * @module @helium/cli/runner
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditStore,
  ExecutionTargetId,
  ProviderRunFailure,
  WorkOrderSchema,
  budgetLine,
  foldSessionLog,
  projection,
  remaining,
  select,
  topologicalOrder,
  type CapabilityCatalog,
  type Channel,
  type DeliveryReport,
  type EcosystemTool,
  type Gate,
  type LoadedTenant,
  type ModelSelection,
  type Provider,
  type RenderedReport,
  type RunReport,
  type TenantCalendar,
  type TenantRenderer,
  type Span,
  type TargetProfile,
  type WorkOrder,
} from "@helium/core";
import {
  discoverChannels,
  discoverProviders,
  loadGates,
  loadRenderer,
  loadTenantTools,
  tenantToolGaps,
  type Skipped,
} from "./discovery.js";
import { codeVersion } from "./code-version.js";
import {
  loadRecordings,
  pruneRecordings,
  recordingsDir,
  sha256,
  writeRecording,
  type RecordingIndex,
} from "./tool-io.js";

// These moved to `@helium/core` so a tenant's own renderer can name them
// without depending on the CLI. Re-exported here because every existing
// importer (cli.ts, the tests) reaches them through this module.
export type {
  DeliveryReport,
  RenderedReport,
  RunReport,
  StepReport,
} from "@helium/core";

/**
 * What a step is assumed to cost before it runs, for cheapest-capable ranking
 * only. It is an ESTIMATE and is never written to the audit table; the table
 * only ever records what a session log reported.
 */
const STEP_ESTIMATE = { inputTokens: 8_000, outputTokens: 1_000 };

/**
 * Take every target drawing on one exhausted allowance out of the catalog.
 *
 * Models sharing a `quotaDomain` run out together, so retiring only the model
 * that reported 429 would just route to a sibling on the same spent pool. A
 * model on its own domain — spark, on its separate allowance — is untouched,
 * which is the entire reason the field exists.
 *
 * @returns how many targets were retired.
 */
export function retireQuotaDomain(
  catalog: CapabilityCatalog,
  providers: readonly Provider[],
  quotaDomain: string,
): number {
  let retired = 0;
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.quotaDomain !== quotaDomain) continue;
      const targetId = ExecutionTargetId(`${provider.id}:${model.id}`);
      if (catalog.get(targetId) === undefined) continue;
      // Only a target that was still SERVING counts. Retiring is idempotent —
      // the entry stays in the catalog, marked unavailable — so counting it
      // again on a second call reports progress that did not happen. The
      // re-route loop uses this number as its termination condition, and an
      // always-positive count is an infinite loop.
      if (!catalog.available(targetId)) continue;
      catalog.setAvailability(targetId, { state: "quota-exhausted" });
      retired += 1;
    }
  }
  return retired;
}

/** Register every live provider's models as opaque routing targets. */
export function registerProviders(
  catalog: CapabilityCatalog,
  providers: readonly Provider[],
): void {
  for (const provider of providers) {
    for (const model of provider.models) {
      const profile: TargetProfile = {
        targetId: ExecutionTargetId(`${provider.id}:${model.id}`),
        capabilities: [...model.caps],
        // A flat-rate route registers UNPRICED, so the router ranks it last
        // instead of reading 0/token as the cheapest thing on the menu.
        ...(model.unmetered === true
          ? {}
          : {
              price: {
                usdIn: model.usdIn,
                usdOut: model.usdOut,
                ...(provider.overheadTokens === 0
                  ? {}
                  : { overheadInputTokens: provider.overheadTokens }),
              },
            }),
        operations:
          model.maxContextTokens === undefined
            ? {}
            : { maxContextTokens: model.maxContextTokens },
        supports: {
          structuredOutput: model.caps.includes("structured.output"),
          toolIsolation: true,
          mutations: false,
        },
      };
      catalog.register(profile);
    }
  }
}

/** How the runner reaches a live provider's runtime. Supplied by the caller. */
export interface ModelExecutor {
  run(
    work: WorkOrder,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    structured?: unknown;
    events: Array<{ type: string; seq: number; time: number; data: unknown }>;
  }>;
}

export interface RunOptions {
  tenant: LoadedTenant;
  audit: AuditStore;
  pluginsDir: string;
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  /** Injected in tests; discovered by glob when absent. */
  providers?: Provider[];
  providersSkipped?: Array<{ id: string; reason: string }>;
  tools?: EcosystemTool[];
  /** Injected in tests; loaded from the tenant's `lib/gates/` when absent. */
  gates?: Gate[];
  /** Injected in tests; discovered from `plugins/delivery-*` when absent. */
  channels?: Channel[];
  /** Injected in tests; loaded from the tenant's `lib/render/` when absent.
   *  `null` means "explicitly none", which is how a test asks for the
   *  generic transcript without putting a file on disk. */
  renderer?: TenantRenderer | null;
  modelExecutor?: ModelExecutor;
  catalog?: CapabilityCatalog;
  signal?: AbortSignal;
  /** The run label. Core-neutral; forwarded to prompts, gates and delivery. */
  phase?: string;
  /** Injected in tests so the clock in the step preamble can be frozen. */
  now?: () => Date;
  /**
   * Point-in-time replay: the past instant the run is reproducing. It is NOT a
   * second clock — the caller sets `now` to the same instant — it is the flag
   * the tools read to decide whether they have history for it. Core stays
   * domain-free here: it forwards an instant and a label and never learns what
   * a source is.
   */
  asOf?: Date;
  /** Run flavour label, forwarded to tool construction. Defaults to `live`. */
  variant?: string;
  /**
   * A previous run whose recorded tool responses may serve this one's. Core
   * hands the tenant a lookup and never decides which tools want it — a tool
   * knows what is behind it and the runner does not (doctrine 2).
   */
  replayFrom?: string;
}

/**
 * The arguments a deterministic step can hand a tool, or undefined when it
 * cannot supply what the tool demands.
 *
 * NO ARGUMENTS COMES FIRST. A tool whose parameters are all optional — every
 * IB tool that reads an account, the TradingView list with no colour filter —
 * wants to be called with nothing, and the older rule ("find the one string
 * parameter") skipped every one of them as unfeedable. That skip was silent
 * and total: the tools that need no input are exactly the tools a universe
 * step exists to call.
 */
function toolArgs(
  tool: EcosystemTool,
  text: string,
  handoffText = "",
): Record<string, unknown> | undefined {
  const schema = tool.paramsSchema as unknown as {
    safeParse?: (value: unknown) => { success: boolean };
  };
  if (schema.safeParse?.({})?.success === true) return {};
  const key = singleStringParam(tool);
  if (key !== undefined) return { [key]: text };
  // A tool whose one parameter is an ARRAY of strings — `tickers: string[]`,
  // ow_spot's and ow_argon_levels's shape — could not be fed at all: the
  // single-string path above skips it (an array field rejects a bare
  // string), so a deterministic step naming ow_spot in `tools:` always
  // reported "skipped, needs parameters this step cannot supply". The
  // tickers a step actually has are sitting in ITS OWN prompt or in a
  // dependency's tool output (ow_tv_watchlist's `tickers`, ow_spot's
  // `quotes[].ticker`) — both JSON, both already in this step's context —
  // so they are pulled out of that text rather than invented.
  const arrayKey = singleArrayOfStringsParam(tool);
  if (arrayKey !== undefined) {
    const tickers = tickersFromText(`${handoffText}\n\n${text}`);
    const fitted = fittingSlice(schema, arrayKey, tickers);
    if (fitted !== undefined) return { [arrayKey]: fitted };
  }
  return undefined;
}

/**
 * The array-of-strings parameter of a tool, if it has exactly one param and
 * that param accepts an array (not a bare string — `singleStringParam`
 * already claims those). Detected the same way as `singleStringParam`, by
 * probing the schema rather than reaching into zod internals.
 */
function singleArrayOfStringsParam(tool: EcosystemTool): string | undefined {
  const shape = (
    tool.paramsSchema as unknown as {
      shape?: Record<
        string,
        { safeParse?: (value: unknown) => { success: boolean } }
      >;
    }
  ).shape;
  if (shape === undefined) return undefined;
  const keys = Object.keys(shape);
  if (keys.length !== 1) return undefined;
  const field = shape[keys[0]!];
  if (field?.safeParse?.("probe")?.success === true) return undefined;
  return field?.safeParse?.(["probe"])?.success === true ? keys[0] : undefined;
}

/**
 * Every `"ticker"`/`"tickers"` JSON field found in a blob of tool-output
 * text, deduped and upper-cased. This is deliberately dumb pattern matching
 * over already-produced JSON, not a re-parse of it: the text can be several
 * tools' outputs concatenated, and only the one field name that every ticker
 * list in this file actually uses is worth trusting.
 */
const TICKER_FIELD =
  /"tickers?"\s*:\s*(?:\[([^\]]*)\]|"([A-Za-z][A-Za-z.]{0,9})")/gu;

function tickersFromText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TICKER_FIELD)) {
    const single = match[2];
    if (single !== undefined) {
      found.add(single.toUpperCase());
      continue;
    }
    const arrayBody = match[1];
    if (arrayBody === undefined) continue;
    for (const item of arrayBody.matchAll(/"([A-Za-z][A-Za-z.]{0,9})"/gu)) {
      found.add(item[1]!.toUpperCase());
    }
  }
  return [...found];
}

/**
 * The longest PREFIX of `tickers` (order preserved, so SPY/QQQ-first stays
 * first) that the schema accepts for `key` — a tool's own `.max(N)` is never
 * re-read here, only probed by trying to parse, which stays correct across a
 * zod major version the way reaching into `_def` would not. `undefined` when
 * even one ticker does not fit (an empty-array-forbidding schema, say).
 */
function fittingSlice(
  schema: { safeParse?: (value: unknown) => { success: boolean } },
  key: string,
  tickers: readonly string[],
): string[] | undefined {
  if (tickers.length === 0) return undefined;
  if (schema.safeParse?.({ [key]: tickers })?.success === true)
    return [...tickers];
  let lo = 1;
  let hi = tickers.length;
  let best: string[] | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = tickers.slice(0, mid);
    if (schema.safeParse?.({ [key]: candidate })?.success === true) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The single string parameter of a tool, if it has exactly one and that one
 * actually accepts a string.
 *
 * The type check is not pedantry: this is how the tool-only path feeds a step's
 * prompt to a tool, and a tool whose one parameter is an ARRAY was being handed
 * a string and reported as a tool failure — a validation error dressed up as an
 * unreachable service. Asking the schema whether it accepts a string is
 * version-proof in a way that reaching into zod internals is not.
 */
function singleStringParam(tool: EcosystemTool): string | undefined {
  const shape = (
    tool.paramsSchema as unknown as {
      shape?: Record<
        string,
        { safeParse?: (value: unknown) => { success: boolean } }
      >;
    }
  ).shape;
  if (shape === undefined) return undefined;
  const keys = Object.keys(shape);
  if (keys.length !== 1) return undefined;
  const field = shape[keys[0]!];
  return field?.safeParse?.("probe")?.success === true ? keys[0] : undefined;
}

/**
 * What a step's declared dependencies produced.
 *
 * `dependsOn` used to order the DAG and pass NOTHING: every step ran as an
 * independent subagent with no memory of the run, so a summarising role
 * answered "I don't have access to the prior steps" — verified in a real run.
 * A team lane whose steps cannot hand off is a sequence, not a team.
 *
 * ponytail: whole prior outputs, verbatim. Design §5 wants large tool outputs
 * summarised before they enter a context; when a hand-off first blows a
 * context window, that summariser is where this belongs.
 *
 * Dependencies with no text are dropped, not rendered as an empty section.
 * That is also what makes a phase-skipped dependency harmless: it produced
 * nothing, so it forwards nothing.
 */
function handoff(
  task: { dependsOn: readonly string[] },
  produced: ReadonlyMap<string, string>,
): string {
  const parts = task.dependsOn
    .map((id) => {
      const text = produced.get(id);
      return text === undefined || text === ""
        ? undefined
        : `### ${id}\n${text}`;
    })
    .filter((part) => part !== undefined);
  return parts.length === 0
    ? ""
    : `Output of the steps this one depends on:\n\n${parts.join("\n\n")}`;
}

/**
 * A gate is its own audited step (design §3): it runs BEFORE the model call it
 * guards, so a refusal costs one zero-token span instead of a whole call. The
 * span carries `toolName: "gate:<id>"` so the §5 query separates gate cost from
 * model cost without a second table.
 */
/**
 * The raw strings a model step's tools returned, read out of the same
 * `tool/result` events the fold measures into `toolOutputBytes`. The tool is
 * never re-run to obtain them, and nothing is summarised: a gate comparing the
 * model's text against a paraphrase would pass what it exists to catch.
 *
 * `message.content` comes in three real shapes and this reads all of them.
 * Some runtimes put the tool's own string there. A dsh session.jsonl puts an
 * ARRAY of blocks, and the block's payload sits one level deeper than it
 * looks: verified against a real log on 2026-09-04, it is
 * `[{ type: "tool-result", toolCallId, content: [{ type: "text", text: "…" }] }]`
 * — a tool-result block whose own `content` holds the text blocks. The flatter
 * `[{ type: "tool-result", text: "…" }]` that `fold.spec.ts` froze on
 * 2026-09-02 is the second shape, still accepted here.
 *
 * Reading only the outermost object and stringifying it produced a JSON ARRAY
 * whose first character is `[`, so every reader downstream that parses a tool
 * payload as an OBJECT skipped it in silence: the tenant renderer's spot map,
 * earnings map and settlement ledger, and every gate that checks a model's
 * claim against what it was handed. The tell was a run whose audit table
 * listed seventeen tool calls and whose brief still said "no tool spot; not
 * verified" — blindness that looks exactly like a tool that was never called.
 *
 * A block with no readable text falls back to the block itself rather than
 * being dropped. Losing a payload silently is how this survived a provider.
 */
function blockTexts(block: unknown): string[] {
  if (typeof block === "string") return [block];
  if (block === null || typeof block !== "object") {
    return [JSON.stringify(block ?? null)];
  }
  const row = block as Record<string, unknown>;
  if (typeof row.text === "string") return [row.text];
  if (Array.isArray(row.content)) return row.content.flatMap(blockTexts);
  if (typeof row.content === "string") return [row.content];
  return [JSON.stringify(block)];
}

function toolResultTexts(
  events: readonly { type: string; data: unknown }[],
): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const data = event.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      texts.push(...content.flatMap(blockTexts));
      continue;
    }
    texts.push(JSON.stringify(content ?? null));
  }
  return texts;
}

async function runGates(
  gates: readonly Gate[],
  phase: "input" | "output",
  input: unknown,
  ctx: {
    audit: AuditStore;
    runId: string;
    tenant: string;
    role: string;
    taskId: string;
    stepNo: number;
    remainingUsd: number;
    toolOutputs?: string[];
    toolCalls?: string[];
    stepToolOutputs?: string[];
  },
): Promise<{ ran: number; refusals: Refusal[] }> {
  const refusals: Refusal[] = [];
  const applicable = gates.filter(
    (gate) =>
      gate.phase === phase &&
      (gate.appliesTo.includes("*") || gate.appliesTo.includes(ctx.role)),
  );
  for (const gate of applicable) {
    const startedAt = Date.now();
    // A gate that THROWS is a refusal, never a pass. Failing open would make a
    // broken guard indistinguishable from a satisfied one.
    let verdict: { pass: boolean; reason: string };
    try {
      verdict = await gate.check(input, {
        runId: ctx.runId,
        role: ctx.role,
        remainingUsd: ctx.remainingUsd,
        ...(ctx.toolOutputs === undefined
          ? {}
          : { toolOutputs: ctx.toolOutputs }),
        ...(ctx.toolCalls === undefined ? {} : { toolCalls: ctx.toolCalls }),
        ...(ctx.stepToolOutputs === undefined
          ? {}
          : { stepToolOutputs: ctx.stepToolOutputs }),
      });
    } catch (error: unknown) {
      verdict = {
        pass: false,
        reason: `gate threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    ctx.audit.append({
      runId: ctx.runId,
      spanId: `gate:${ctx.taskId}:${gate.id}`,
      tenant: ctx.tenant,
      role: ctx.role,
      provider: "none",
      model: "none",
      codeVersion: codeVersion(),
      stepNo: ctx.stepNo,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costUsd: 0,
      toolName: `gate:${gate.id}`,
      toolOutputBytes: Buffer.byteLength(verdict.reason, "utf8"),
      summarised: false,
      ts: new Date().toISOString(),
    });
    if (!verdict.pass)
      refusals.push({
        id: gate.id,
        reason: verdict.reason,
        ...(gate.advisory === true && phase === "output"
          ? { advisory: true }
          : {}),
      });
  }
  return { ran: applicable.length, refusals };
}

type Refusal = { id: string; reason: string; advisory?: boolean };

/** The step fields an output gate pass leaves behind. Every refusal is kept
 *  on the step — the audit and the degradation line read them — but only a
 *  non-advisory one marks the step failed (see `Gate.advisory`). */
function refusalFields(
  refusals: Refusal[],
): Pick<RunReport["steps"][number], "failure" | "gateRefusals"> {
  if (refusals.length === 0) return {};
  const gateRefusals = refusals.map(({ id, reason }) => ({ id, reason }));
  return refusals.every((refusal) => refusal.advisory === true)
    ? { gateRefusals }
    : { failure: "gate-refused", gateRefusals };
}

/**
 * `2026-09-03T18:00:12+08:00` in Asia/Hong_Kong. Written out by hand from the
 * parts `Intl` gives, because `toISOString()` is UTC and no runtime formats a
 * zoned offset ISO string directly. The offset is derived, never hardcoded:
 * HK does not observe DST today, and a literal +08:00 would make that a
 * property of this file instead of a property of the zone.
 */
export function zonedNow(now: Date, timeZone = "Asia/Hong_Kong"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  const local = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  const offsetMin = Math.round((local - now.getTime()) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * `2026-09-02` — the calendar date of that instant in `timeZone`. Sliced off
 * `zonedNow` rather than formatted a second time: two date formatters in one
 * process is two places for the day to be decided, and the day is the thing
 * this whole path exists to agree on.
 */
export function zonedDay(now: Date, timeZone: string): string {
  return zonedNow(now, timeZone).slice(0, 10);
}

/**
 * Why `day` is closed for this tenant, or undefined when it is open.
 *
 * `day` is already in the tenant's `reportTimezone`, so both checks are plain
 * string/date arithmetic on a date-only value: parsed as UTC midnight, which is
 * the only reading under which the weekday of `2026-09-07` is a property of the
 * date rather than of the machine running this.
 */
export function calendarSkipReason(
  calendar: TenantCalendar | undefined,
  day: string,
  phase: string,
): string | undefined {
  if (calendar === undefined) return undefined;
  // A label the calendar does not govern runs on every day, closed or not.
  if (calendar.appliesTo !== undefined && !calendar.appliesTo.includes(phase))
    return undefined;
  if (calendar.closed.includes(day)) return `calendar closed ${day}`;
  if (!calendar.weekdaysOnly) return undefined;
  // 0 Sunday, 6 Saturday — the two the modulo picks out.
  return new Date(`${day}T00:00:00Z`).getUTCDay() % 6 === 0
    ? `calendar closed ${day} (weekend)`
    : undefined;
}

/**
 * A tenant-declared fenced block, lifted out of a step's text.
 *
 * Exported because the escaping is the whole risk: `fence` comes out of a YAML
 * file, and an unescaped `.*` in `new RegExp` would delete the step instead of
 * the block. Returns the text unchanged, and no `block`, when the fence is not
 * there — which is every step of every tenant that declares none.
 */
export function splitStateBlock(
  text: string,
  fence: string,
): { text: string; block?: string } {
  const escaped = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(
    `\\n?[ \\t]*\`\`\`${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\`\`\`[ \\t]*(?=\\r?\\n|$)`,
    "u",
  ).exec(text);
  if (found === null) return { text };
  return {
    text: `${text.slice(0, found.index)}${text.slice(
      found.index + found[0].length,
    )}`.trim(),
    block: found[1]!.trim(),
  };
}

/**
 * The block on disk, or nothing. A block that is not a JSON OBJECT is dropped
 * silently HERE — the tenant's own gate is what tells the reader it was
 * malformed, because only the tenant knows what a well-formed one contains.
 * Core's whole test is "can this be stored at all".
 */
function writeStateBlock(args: {
  stateRoot: string;
  tenant: string;
  day: string;
  label: string;
  suffix: string;
  block: string;
}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.block);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return;
  const dir = join(args.stateRoot, args.tenant, args.day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${args.label}.${args.suffix}`),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
}

export async function runTenant(options: RunOptions): Promise<RunReport> {
  const env = options.env ?? process.env;
  const runId = options.runId ?? `run-${randomUUID()}`;
  const phase = options.phase ?? "premarket";
  const { spec, manifest } = options.tenant;
  // ONE day for the whole run, read once at the start: the prompt's clock, the
  // subject, the report file name and the per-day delivery counter are then the
  // same date even for a run that crosses midnight in some zone. Computing it
  // per surface is how a report named for one day gets charged to another.
  const reportZone = spec.reportTimezone ?? "UTC";
  const reportDay = zonedDay(options.now?.() ?? new Date(), reportZone);

  // Before anything is discovered, built or called: the scheduler fires every
  // day and only the tenant knows which of those days it has something to say
  // about. A closed day returns a completed run with no steps and NO delivery —
  // reached before the delivery loop, which otherwise sends even for a failed
  // run. The audit row exists so a silent day is still a day with a record:
  // "nothing ran" and "the cron is dead" have to be distinguishable.
  const closedReason = calendarSkipReason(spec.calendar, reportDay, phase);
  if (closedReason !== undefined) {
    options.audit.append({
      runId,
      spanId: "calendar:closed",
      tenant: spec.tenant,
      role: "calendar",
      provider: "none",
      model: "none",
      codeVersion: codeVersion(),
      stepNo: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: 0,
      costUsd: 0,
      toolName: "calendar:closed",
      toolOutputBytes: Buffer.byteLength(closedReason, "utf8"),
      summarised: false,
      ts: new Date().toISOString(),
    });
    return {
      runId,
      tenant: spec.tenant,
      mode: "tool-only",
      phase,
      day: reportDay,
      providersLive: [],
      providersSkipped: [],
      steps: [],
      outcome: "completed",
      skipped: { reason: closedReason },
      gatesSkipped: [],
      delivery: [],
      toolsUnconfigured: [],
      ...(options.asOf === undefined
        ? {}
        : {
            asOf: options.asOf.toISOString(),
            variant: options.variant ?? "live",
          }),
    };
  }

  const discovered =
    options.providers === undefined
      ? await discoverProviders(options.pluginsDir)
      : { live: options.providers, skipped: options.providersSkipped ?? [] };
  // Which tools have no history for the replayed instant. The tools mark
  // themselves — a tool knows what is behind it and the runner does not
  // (doctrine 2) — and the runner only counts. Written once per tool: the
  // first reason is the one that stands, so a tool called twenty times does
  // not turn into twenty rows.
  const pitUnavailable = new Map<string, string>();
  const pit = {
    markUnavailable(tool: string, reason: string): void {
      if (!pitUnavailable.has(tool)) pitUnavailable.set(tool, reason);
    },
  };
  // Prune BEFORE recording, so a run cannot be pruned by the run that is
  // writing it, and so the walk happens once per run rather than per call.
  // No keep-list here: `pruneRecordings` takes one, and the caller that knows
  // a run is still cited is the one that will pass it.
  pruneRecordings(options.stateRoot);
  const replayIndex: RecordingIndex | undefined =
    options.replayFrom === undefined
      ? undefined
      : loadRecordings(recordingsDir(options.stateRoot, options.replayFrom));
  const tools =
    options.tools ??
    (await loadTenantTools(options.tenant.dir, {
      stateRoot: options.stateRoot,
      env,
      variant: options.variant ?? "live",
      pit,
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
      ...(spec.calendar === undefined ? {} : { calendar: spec.calendar }),
      ...(replayIndex === undefined ? {} : { recordings: replayIndex }),
      ...(Object.keys(spec.extensions).length === 0
        ? {}
        : { extensions: spec.extensions }),
    }));
  // ONE wrapper, installed once, covering both paths a tool can be called on:
  // the deterministic path calls `tool.run` directly and the model path hands
  // these same objects to the provider through `selection.options.tools`.
  // Wrapping at either call site would record half a run.
  const ioDir = recordingsDir(options.stateRoot, runId);
  let ioSeq = 0;
  const recorded = tools.map((tool) => ({
    ...tool,
    run: async (args: Record<string, unknown>): Promise<string> => {
      const at = new Date().toISOString();
      ioSeq += 1;
      const seq = ioSeq;
      try {
        const raw = await tool.run(args);
        try {
          writeRecording(ioDir, seq, {
            tool: tool.name,
            args,
            at,
            raw,
            rawSha256: sha256(raw),
            rawBytes: Buffer.byteLength(raw, "utf8"),
            // Null until a summariser exists: nothing between a tool and a
            // context rewrites the text today. The field is written anyway so
            // a recording made after one lands is still self-describing.
            context: null,
          });
        } catch {
          // A recording that cannot be written must never cost the run the
          // answer it already has.
        }
        return raw;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          writeRecording(ioDir, seq, {
            tool: tool.name,
            args,
            at,
            raw: null,
            rawSha256: null,
            rawBytes: 0,
            context: null,
            error: message,
          });
        } catch {
          // Same rule.
        }
        throw error;
      }
    },
  }));
  const toolsByName = new Map(recorded.map((tool) => [tool.name, tool]));

  const loadedGates =
    options.gates === undefined
      ? await loadGates(options.tenant.dir)
      : { gates: options.gates, skipped: [] };
  // The skip REASONS are kept, not just the channels: a declared channel that
  // did not load is reported with why it did not. "no built lib/channel.js" was
  // once printed for a plugin whose lib/channel.js was sitting right there —
  // the real reason was a bad default export, and the message sent the reader
  // to rebuild something that was already built.
  const loadedChannels =
    options.channels === undefined && spec.delivery.length > 0
      ? await discoverChannels(options.pluginsDir)
      : {
          channels: options.channels ?? [],
          skipped: [] as Array<{ id: string; reason: string }>,
        };
  const channels = loadedChannels.channels;
  // Loaded once per run, not once per channel: two channels must not disagree
  // about what today's report says.
  const loadedRenderer =
    options.renderer === undefined
      ? await loadRenderer(options.tenant.dir)
      : { renderer: options.renderer, skipped: [] as Skipped[] };

  const catalog =
    options.catalog ?? new (await import("@helium/core")).CapabilityCatalog();
  if (options.catalog === undefined)
    registerProviders(catalog, discovered.live);

  // A live provider knows how to execute (discovery drops the ones that do
  // not), so model mode no longer waits for an injected executor. The option
  // stays as an override, which is how the tests drive this without a network.
  const mode: "model" | "tool-only" =
    discovered.live.length > 0 ? "model" : "tool-only";

  const report: RunReport = {
    runId,
    tenant: spec.tenant,
    mode,
    phase,
    day: reportDay,
    providersLive: discovered.live.map((p) => p.id),
    providersSkipped: discovered.skipped,
    steps: [],
    outcome: "completed",
    gatesSkipped: loadedGates.skipped,
    ...(loadedRenderer.skipped[0] === undefined
      ? {}
      : { rendererSkipped: { reason: loadedRenderer.skipped[0].reason } }),
    delivery: [],
    toolsUnconfigured:
      options.tools === undefined
        ? await tenantToolGaps(options.tenant.dir, env)
        : [],
    ...(options.asOf === undefined
      ? {}
      : {
          asOf: options.asOf.toISOString(),
          variant: options.variant ?? "live",
        }),
  };

  // Applied AFTER the output gates and BEFORE anything keeps the text: the
  // gate still sees exactly what the model wrote, and the report file, the
  // renderer, the channels and every later run see it without the block.
  // Stripping later would leave the fence in the markdown report, which is
  // what the tenant's own tools read back.
  const liftState = (text: string): string => {
    if (spec.stateBlock === undefined) return text;
    const split = splitStateBlock(text, spec.stateBlock.fence);
    if (split.block === undefined) return text;
    writeStateBlock({
      stateRoot: options.stateRoot,
      tenant: spec.tenant,
      day: reportDay,
      label: phase,
      suffix: spec.stateBlock.suffix,
      block: split.block,
    });
    return split.text;
  };

  const signal = options.signal ?? new AbortController().signal;
  let stepNo = 0;
  /** Each completed step's output, for the steps that declared they need it. */
  const produced = new Map<string, string>();
  /** Raw tool returns, in call order, for gates that check the model's text
   *  against what it was actually given. Strings only — no summarising here,
   *  because a gate comparing against a summary would pass a hallucination
   *  that the summary happened to paraphrase. */
  const toolOutputs: string[] = [];

  tasks: for (const taskId of topologicalOrder(manifest)) {
    const task = manifest.tasks.find((entry) => entry.id === taskId)!;
    // A task that names phases and does not name THIS one does not run. It is
    // not a failure and it is not a gate refusal: it is a task that belongs to
    // a different time of day. It contributes no `produced` entry, so every
    // dependent sees exactly what it would see if the step had never been
    // written — `handoff` already drops dependencies with no text.
    if (task.phases !== undefined && !task.phases.includes(phase)) continue;
    const role = manifest.roles[task.role]!;

    const budget = remaining(options.audit, runId, spec.budget);
    if (budget.exhausted) {
      report.outcome = "failed";
      report.failure = {
        class: "budget-exhausted",
        detail: `${spec.tenant} run ${runId} ran out of ${budget.reason} before task ${taskId}`,
      };
      break tasks;
    }

    // Doctrine 4: the agent is TOLD what is left. In model mode this line is
    // what the system-prompt assembly seam injects; here it is prepended to
    // the step prompt so the same text reaches the model either way.
    const line = budgetLine(budget, spec.budget);
    // The clock is the harness's own reading, not a model's invention, so it
    // joins `toolOutputs` and is quotable. It says so on the line itself:
    // without that, a model that needs "as of when" converts this to UTC and
    // the as-of gate refuses a value that was true — the conversion, not the
    // timestamp, is the defect the gate exists to catch.
    const at = options.now?.() ?? new Date();
    const clock = [
      `phase: ${phase}`,
      `now: ${zonedNow(at)}`,
      `now (UTC): ${at.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      // The tenant's own zone is the one that answers "what day is it" for the
      // subject matter, and it is the line that was missing: without it a run
      // started at 02:40 in the launcher's zone reads the day as already over,
      // calls the data it is handed stale, and returns nothing.
      ...(spec.reportTimezone === undefined
        ? []
        : [
            `now (${spec.reportTimezone}): ${zonedNow(at, spec.reportTimezone)}`,
          ]),
      `report day: ${reportDay} (${reportZone})`,
      // Spelling out that the lines are one instant is not padding: a run near
      // midnight in one of these zones shows two different calendar dates, and
      // a model that reads them as a contradiction spends the step reasoning
      // about the clock instead of the tape.
      "The `now` lines are the SAME instant written in more than one zone, not",
      "different times, and `report day` is the date this run's output is filed",
      "under — treat it as today. Every line above is quotable verbatim; every",
      "other timestamp you write must be copied character-for-character from a",
      "tool output.",
    ].join("\n");
    toolOutputs.push(clock);
    const work: WorkOrder = WorkOrderSchema.parse({
      id: `${runId}:${taskId}`,
      role: task.role,
      taskClass: taskId,
      requires: [...task.requires],
      constraints: {
        tools: [...role.permissions.tools],
        mutations: role.permissions.mutations,
        minIsolationClass: "in-process",
      },
      inputs: {
        artifacts: task.dependsOn.map((id) => `step:${id}`),
        prompt: [
          clock,
          line,
          role.persona ?? "",
          handoff(task, produced),
          task.prompt ?? taskId,
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
      acceptance: { outputSchema: "text" },
    });

    // Input gates guard the STEP, so they run in tool-only mode too: a guard
    // that only exists when a model is live is not a guard.
    const input = await runGates(loadedGates.gates, "input", work, {
      audit: options.audit,
      runId,
      tenant: spec.tenant,
      role: task.role,
      taskId,
      stepNo: stepNo + 1,
      remainingUsd: budget.usd,
    });
    if (input.ran > 0) stepNo += 1;
    if (input.refusals.length > 0) {
      report.steps.push({
        task: taskId,
        role: task.role,
        mode,
        text: "",
        failure: "gate-refused",
        gateRefusals: input.refusals,
      });
      continue;
    }

    // A step that requires no capability is deterministic BY DECLARATION, not
    // by circumstance: it takes the same tool path a provider-less run takes,
    // but says so under its own name so the report never reads as a degraded
    // model run.
    const deterministic = task.requires.length === 0;
    if (mode === "tool-only" || deterministic) {
      stepNo += 1;
      const outputs: string[] = [];
      /** Tools this step actually invoked — not the ones it was allowed. */
      const stepToolCalls: string[] = [];
      /** Same step scope as `stepToolCalls`: the raw values, not "name -> value". */
      const stepToolOutputs: string[] = [];
      for (const name of role.permissions.tools) {
        const tool = toolsByName.get(name);
        if (tool === undefined) {
          outputs.push(`${name}: not built by this tenant`);
          continue;
        }
        const args = toolArgs(
          tool,
          task.prompt ?? taskId,
          handoff(task, produced),
        );
        if (args === undefined) {
          outputs.push(
            `${name}: skipped, needs parameters this step cannot supply`,
          );
          continue;
        }
        const startedAt = Date.now();
        // A tool that cannot reach its service THROWS, by design — that is how
        // it avoids returning an invented number. Catching it here is what
        // makes spec §7 possible: an unreachable IB Gateway degrades the report
        // it appears in, it does not take the run down. The failure text is
        // recorded as the tool's output so the reason reaches the email.
        let value: string;
        try {
          value = await tool.run(args);
        } catch (error: unknown) {
          value = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
        }
        const span: Span = {
          runId,
          spanId: `tool:${taskId}:${name}`,
          tenant: spec.tenant,
          role: task.role,
          provider: "none",
          model: "none",
          codeVersion: codeVersion(),
          stepNo,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          contextSize: 0,
          latencyMs: Math.max(0, Date.now() - startedAt),
          costUsd: 0,
          toolName: name,
          toolOutputBytes: Buffer.byteLength(value, "utf8"),
          summarised: false,
          ts: new Date().toISOString(),
        };
        options.audit.append(span);
        outputs.push(`${name} -> ${value}`);
        toolOutputs.push(value);
        // Recorded where the call actually happened: the two `continue`s above
        // skip a tool that was declared but never invoked, and counting those
        // would tell a gate a tool ran when nothing called it.
        stepToolCalls.push(name);
        stepToolOutputs.push(value);
      }
      // A step that ran no tool has nothing OF ITS OWN to say — but it is still
      // in the chain, and its output is what every dependent receives instead
      // of its dependencies'. Emitting a placeholder there silently starved
      // every downstream step: a 190-ticker universe reached the screen step
      // and stopped, and the two roles after it correctly reported that nobody
      // had given them anything to work on. Forwarding is not a substitute for
      // the work: the text says plainly that nothing was applied.
      const inherited = handoff(task, produced);
      const text =
        outputs.length > 0
          ? outputs.join("\n")
          : inherited === ""
            ? "(no tools declared for this role, and nothing upstream to forward)"
            : `(no tools declared for this role; forwarding its input unchanged)\n\n${inherited}`;
      const out = await runGates(
        loadedGates.gates,
        "output",
        { text },
        {
          audit: options.audit,
          runId,
          tenant: spec.tenant,
          role: task.role,
          taskId,
          stepNo: stepNo + 1,
          remainingUsd: budget.usd,
          toolOutputs,
          toolCalls: stepToolCalls,
          stepToolOutputs,
        },
      );
      if (out.ran > 0) stepNo += 1;
      const kept = liftState(text);
      produced.set(taskId, kept);
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: deterministic ? "deterministic" : "tool-only",
        text: kept,
        ...refusalFields(out.refusals),
      });
      continue;
    }

    // Re-route only on a spent quota, and only while each failure RETIRES
    // something. A pool that is out stays out for the rest of the run: the
    // vendor's reset hint is opaque, so re-offering a sibling on the same
    // allowance would just spend a second call to learn the same thing.
    //
    // The loop is bounded by the catalog, not by a counter. Every retry has
    // strictly fewer targets to choose from than the one before it, and `select`
    // fails outright when none are left — so "retired something" is a safe
    // condition, and a fixed budget of one was simply wrong: an account with
    // three separately-metered tiers needs two hops to reach the third.
    for (;;) {
      const decision = select(work, catalog.snapshot(), {
        budget: projection(budget, STEP_ESTIMATE),
      });
      if (decision.selected === undefined) {
        // A capability nothing can serve degrades THIS STEP, not the run. It
        // reads as a run-ending condition only if you assume the shortage is
        // permanent, and the commonest cause is the opposite: a tier that hit
        // its rate limit two lines above and was retired, leaving the one
        // capability only it declared. Losing every other step's work — and
        // the report that carries them — to a transient 429 on one model is
        // the failure mode the delivery block below already refuses to accept.
        report.steps.push({
          task: taskId,
          role: task.role,
          mode: "model",
          text: "",
          failure: decision.failure?.class ?? "capability-shortage",
          downgradeReason: decision.failure?.reasons.join("; ") ?? "no target",
        });
        break;
      }

      const [providerId, ...rest] = String(decision.selected).split(":");
      const routedModel = rest.join(":");
      const provider = discovered.live.find(
        (entry) => entry.id === providerId,
      )!;
      // The provider decides effort and its own runtime options; the MODEL is
      // the router's, not a second choice made without the catalog. Letting
      // `select` re-pick here would re-offer a model this run already retired.
      const chosen = provider.select({
        role: task.role,
        requires: [...task.requires],
        projectedInputTokens: STEP_ESTIMATE.inputTokens,
        projectedOutputTokens: STEP_ESTIMATE.outputTokens,
      });
      const selection: ModelSelection = {
        ...chosen,
        targetId: decision.selected,
        model: routedModel,
        // A provider that executes a tool-using role needs the tool
        // IMPLEMENTATIONS; the work order carries names only. `options` is the
        // provider-opaque bag core never reads into, which makes it the right
        // channel: the dataflow stays explicit and per-step, where a module or
        // process global would leak between concurrent runs.
        options: {
          ...(chosen.options ?? {}),
          ...(role.permissions.tools.length === 0
            ? {}
            : {
                tools: role.permissions.tools
                  .map((name) => toolsByName.get(name))
                  .filter((tool) => tool !== undefined),
              }),
        },
      };
      const model = provider.models.find(
        (entry) => entry.id === selection.model,
      );

      const executor: ModelExecutor = options.modelExecutor ?? {
        run: async (order, sel, sig) => provider.run!(order, sel, sig),
      };

      let result: Awaited<ReturnType<ModelExecutor["run"]>>;
      try {
        result = await executor.run(work, selection, signal);
      } catch (error: unknown) {
        const failure = error instanceof ProviderRunFailure ? error : undefined;
        const retired =
          failure?.quotaDomain === undefined
            ? 0
            : retireQuotaDomain(catalog, discovered.live, failure.quotaDomain);
        if (retired > 0) {
          report.steps.push({
            task: taskId,
            role: task.role,
            mode: "model",
            targetId: String(decision.selected),
            downgradeReason: `quota domain ${failure!.quotaDomain!} exhausted; ${String(retired)} target(s) retired for this run`,
            text: "",
            failure: "quota-exhausted",
          });
          continue;
        }
        report.outcome = "failed";
        report.failure = {
          class: failure?.failureClass ?? "provider-error",
          detail: error instanceof Error ? error.message : String(error),
        };
        break tasks;
      }

      const spans = foldSessionLog(result.events, {
        runId,
        tenant: spec.tenant,
        role: task.role,
        provider: provider.id,
        model: selection.model,
        codeVersion: codeVersion(),
        stepOffset: stepNo,
        // Span ids repeat across sessions; the task is what makes them unique
        // within a run. Without this the audit table silently drops every step
        // after the first.
        scope: taskId,
        ...(model === undefined
          ? {}
          : { price: { usdIn: model.usdIn, usdOut: model.usdOut } }),
      });
      options.audit.appendAll(spans);
      const stepToolOutputs = toolResultTexts(result.events);
      toolOutputs.push(...stepToolOutputs);
      // No new plumbing: `foldSessionLog` already turned every tool call in
      // this step's session log into a span carrying its name (a span without
      // one is the model step itself). Reading the names back off the spans is
      // the same fact the audit table stores, so a gate and `helium audit`
      // can never disagree about what the step called.
      const stepToolCalls = spans
        .map((span) => span.toolName)
        .filter((name): name is string => name !== undefined);
      stepNo += spans.filter((span) => span.toolName === undefined).length;

      // A model step whose session log reported NO usage did not reach a
      // model. Recording it as completed would put an empty step in the report
      // and nothing in the audit table — the run would look cheap because it
      // silently did less, which is the one thing the audit must never do.
      // Zero tokens is the tell, not the absence of a span: a route that did
      // not serve the request still emits a step span, it just has nothing in
      // it. `spans.some(...)` alone therefore matched a step that never ran.
      const billed = spans.some(
        (span) =>
          span.toolName === undefined &&
          span.inputTokens + span.outputTokens > 0,
      );
      const emptyRun = !billed && result.text.trim() === "";

      // Output gates see what the model produced. A refusal here does NOT
      // discard the text — the step ran and was paid for; it marks it so the
      // tenant's renderer can route it (design §7: a failed gate is normal
      // operation, not an error).
      const out = await runGates(loadedGates.gates, "output", result, {
        audit: options.audit,
        runId,
        tenant: spec.tenant,
        role: task.role,
        taskId,
        stepNo: stepNo + 1,
        remainingUsd: budget.usd,
        toolOutputs,
        toolCalls: stepToolCalls,
        stepToolOutputs,
      });
      if (out.ran > 0) stepNo += 1;
      const kept = liftState(result.text);
      produced.set(taskId, kept);
      report.steps.push({
        task: taskId,
        role: task.role,
        mode: "model",
        ...(stepToolOutputs.length === 0
          ? {}
          : { toolOutputs: stepToolOutputs }),
        targetId: String(decision.selected),
        ...(decision.downgradeReason === undefined
          ? {}
          : { downgradeReason: decision.downgradeReason }),
        text: kept,
        ...(emptyRun
          ? {
              failure: "no-model-output",
              downgradeReason:
                "the session log reported no usage and no text: this step did not reach a model",
            }
          : {}),
        ...refusalFields(out.refusals),
      });
      break;
    }
  }

  // A run whose loop reached the end is not a run that SUCCEEDED. Steps now
  // degrade in place rather than ending the run — a gate refusal, a capability
  // nothing can serve — and without this the report said "completed" over the
  // top of them. The class comes from the first failed step because the first
  // one is usually the cause and the rest the consequence.
  if (report.outcome === "completed") {
    // Keyed by TASK, not by step row: a quota re-route leaves a failed row
    // behind for the attempt that was retired, and the retry that succeeded is
    // a second row for the same task. Counting rows would report a run as
    // failed precisely because the re-route worked.
    const succeeded = new Set(
      report.steps
        .filter((step) => step.failure === undefined)
        .map((step) => step.task),
    );
    const failed = report.steps.filter(
      (step) => step.failure !== undefined && !succeeded.has(step.task),
    );
    if (failed.length > 0) {
      report.outcome = "failed";
      report.failure = {
        class: failed[0]!.failure!,
        detail: `${String(failed.length)} of ${String(report.steps.length)} steps failed: ${failed
          .map((step) => step.task)
          .join(", ")}`,
      };
    }
  }

  // Delivery runs even when the run FAILED. Design §7: silence is
  // indistinguishable from a dead cron, which is the failure mode that killed
  // the job this tenant replaces. A degraded report is still a report.
  // The brake guards EGRESS, so the channel is resolved first and only then
  // asked whether it leaves the machine. Checking the brake first would have
  // meant an operator must arm outbound mail to get a report written to their
  // own disk — and a channel that never declares itself is treated as external,
  // so forgetting the flag brakes rather than sends.
  // Rendering happens ONCE, before the delivery loop, and a renderer that
  // throws costs the run its rich email and nothing else: delivery still
  // happens with the generic transcript. Losing the send because the pretty
  // version failed would trade a readable email for no email at all.
  // Read AFTER the steps, not at load: a tool that only discovers it has
  // nothing for the instant when it is called (an exhausted window, a source
  // that answers but not that far back) marks itself during the run, and a
  // count taken at build time would report it as available.
  if (options.asOf !== undefined) {
    const served = replayIndex?.served() ?? [];
    report.pitCoverage = {
      total: tools.length,
      // A tool that answered from a recording is available. It marked itself
      // unavailable only if the recording missed too, so the two sets cannot
      // both claim it.
      available: Math.max(0, tools.length - pitUnavailable.size),
      unavailable: [...pitUnavailable.keys()].sort((a, b) =>
        a.localeCompare(b, "en"),
      ),
      ...(served.length === 0 ? {} : { served }),
    };
  }

  let rendered: RenderedReport | undefined;
  if (loadedRenderer.renderer !== null) {
    try {
      rendered = loadedRenderer.renderer(report, spec);
    } catch (error: unknown) {
      report.rendererSkipped = {
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Written AFTER rendering and BEFORE delivery: the renderer is what
  // computes them, and the header line the channels carry is built from
  // `report.metrics`. Core stores name, value, day and label, and reads none
  // of them.
  //
  // `label: phase` is the RUN label — premarket, close. The header's display
  // key is `metric.short`, a different field on a different type, so there is
  // no collision to keep straight. The row is keyed by what the run WAS; the
  // header prints how the number READS. Without `day` and `label` this table
  // is keyed only by a UUID, and the weekly review would have to parse its own
  // numbers back out of a rendered markdown header.
  if (rendered?.metrics !== undefined && rendered.metrics.length > 0) {
    report.metrics = rendered.metrics;
    const measuredAt = new Date().toISOString();
    for (const metric of rendered.metrics)
      options.audit.appendMetric({
        runId,
        name: metric.name,
        value: metric.value,
        ts: measuredAt,
        day: report.day,
        label: phase,
      });
  }

  // Local-run inspection only: the runner otherwise renders HTML and lets it
  // fall on the floor (only the .md transcript is written to disk). Opt-in
  // via a domain-free env var so a laptop run can dump the exact HTML a
  // delivery channel would have sent, without adding a persistence path core
  // doesn't already have a reason to want.
  const renderDumpDir = env.HELIUM_RENDER_DUMP;
  if (renderDumpDir !== undefined && rendered?.html !== undefined) {
    mkdirSync(renderDumpDir, { recursive: true });
    const dumpPath = join(
      renderDumpDir,
      `${report.tenant}-${report.day}-${report.phase}.html`,
    );
    writeFileSync(dumpPath, rendered.html, "utf8");
  }

  const brake = env.HELIUM_TENANT_DELIVERY === "1";
  for (const entry of spec.delivery) {
    const channel = channels.find(
      (candidate) => candidate.id === entry.channel,
    );
    if (channel === undefined) {
      const why = loadedChannels.skipped.find(
        (skip) => skip.id === `delivery-${entry.channel}`,
      )?.reason;
      report.delivery.push({
        channel: entry.channel,
        state: "failed",
        detail: `delivery-${entry.channel} did not load: ${why ?? "no such plugin under plugins/"}`,
      });
      continue;
    }
    if (channel.external !== false && !brake) {
      report.delivery.push({
        channel: entry.channel,
        state: "skipped",
        detail: "operator brake: HELIUM_TENANT_DELIVERY is not 1",
      });
      continue;
    }
    const startedAt = Date.now();
    let outcome: DeliveryReport;
    try {
      const result = await channel.deliver(
        {
          tenant: spec.tenant,
          runId,
          subject: deliverySubject(report, reportDay, env),
          body: deliveryBody(report),
          day: reportDay,
          phase: report.phase,
          codeVersion: codeVersion(),
          ...(rendered === undefined ? {} : { rendered }),
        },
        entry.config,
      );
      outcome = {
        channel: entry.channel,
        state: result.state,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    } catch (error: unknown) {
      outcome = {
        channel: entry.channel,
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    stepNo += 1;
    options.audit.append({
      runId,
      spanId: `delivery:${entry.channel}`,
      tenant: spec.tenant,
      role: "delivery",
      provider: "none",
      model: "none",
      codeVersion: codeVersion(),
      stepNo,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costUsd: 0,
      toolName: `delivery:${entry.channel}`,
      toolOutputBytes: Buffer.byteLength(
        outcome.detail ?? outcome.state,
        "utf8",
      ),
      summarised: false,
      ts: new Date().toISOString(),
    });
    report.delivery.push(outcome);
  }

  return report;
}

/**
 * The email IS the artifact (design §7.1), so rendering it is deterministic
 * template work and never another model call — a role that only reformats an
 * earlier role's output is the kind of ceremony doctrine 6 deletes.
 */
function deliverySubject(
  report: RunReport,
  day: string,
  env: NodeJS.ProcessEnv,
): string {
  // Default-to-TEST is deliberate: a mail is marked real ONLY when the
  // operator has said so on the machine that sends it. Forgetting to set
  // HELIUM_DEPLOYMENT must produce a test-looking mail from production, never
  // a real-looking mail from a laptop — the failure has to fall on the side
  // that gets ignored, not the side that gets traded.
  const test = env.HELIUM_DEPLOYMENT === "production" ? "" : "[TEST] ";
  const tag =
    report.outcome === "failed"
      ? "[FAILED] "
      : report.mode === "tool-only"
        ? "[DEGRADED] "
        : "";
  // The tenant name is already the subject prefix configured in tenant.yaml
  // ("[option-wizard]"), so repeating it here read as "[option-wizard] helium
  // option-wizard 2026-09-03". Phase and date are what tell two of the day's
  // five emails apart.
  return `${test}${tag}${report.phase} ${day}`;
}

/**
 * What a person reads. Not a transcript of the run.
 *
 * The first version pasted every tool's raw output into the body, so a report
 * opened with a 190-element ticker array and an entire IB portfolio in JSON,
 * and the one thing worth reading — what the roles concluded — was somewhere
 * below the fold. A tool that SUCCEEDED gets one line saying so and its size;
 * a tool that FAILED gets its message in full, because that message is the
 * reason a number is missing further down. The raw payloads are not lost: the
 * audit table records every span, and `helium audit <run>` is one line away.
 */
function deliveryBody(report: RunReport): string {
  const lines: string[] = [];
  const failures = report.steps.flatMap((step) => step.gateRefusals ?? []);
  lines.push(
    report.outcome === "completed"
      ? `**Outcome:** completed, ${String(report.steps.length)} steps.`
      : `**Outcome:** FAILED — ${report.failure?.class ?? "unknown"}: ${report.failure?.detail ?? ""}`,
  );
  if (report.mode === "tool-only") {
    lines.push(
      "",
      "_No live provider: no model ran, so nothing below was reasoned about._",
    );
  }
  // A replay must be unmistakable in the artifact itself. A report file that
  // reads like today's, written from a week-old instant, is the one failure
  // mode of this feature that nothing downstream can catch.
  if (report.asOf !== undefined) {
    lines.push(
      "",
      `- as-of: \`${report.asOf}\``,
      `- variant: \`${report.variant ?? "live"}\``,
    );
    if (report.pitCoverage !== undefined) {
      const { available, total, unavailable, served } = report.pitCoverage;
      lines.push(
        `- pit coverage: ${String(available)}/${String(total)}` +
          (served === undefined || served.length === 0
            ? ""
            : ` (from recordings: ${served.join(", ")})`) +
          (unavailable.length === 0
            ? ""
            : ` (unavailable: ${unavailable.join(", ")})`),
      );
    }
  }
  // One line, on every run, not only on a replay: a number nobody sees on an
  // ordinary day is a number nobody notices moving.
  if (report.metrics !== undefined && report.metrics.length > 0) {
    lines.push(
      `- quality: ${report.metrics
        .map((metric) => `${metric.short}=${formatMetric(metric.value)}`)
        .join(" ")}`,
    );
  }
  for (const skip of report.providersSkipped)
    lines.push(`- provider unavailable: ${skip.id} — ${skip.reason}`);
  for (const skip of report.gatesSkipped)
    lines.push(`- **gate failed to load:** ${skip.id} — ${skip.reason}`);
  if (report.rendererSkipped !== undefined) {
    lines.push(
      `- **renderer failed to load:** ${report.rendererSkipped.reason}`,
    );
  }
  for (const gap of report.toolsUnconfigured)
    lines.push(`- **tool unconfigured:** ${gap}`);
  for (const refusal of failures)
    lines.push(`- gate \`${refusal.id}\` refused: ${refusal.reason}`);

  for (const step of report.steps) {
    lines.push("", `## ${step.task} — ${step.role}`);
    if (step.targetId !== undefined) lines.push(`\`${step.targetId}\``, "");
    if (step.downgradeReason !== undefined)
      lines.push(`> ${step.downgradeReason}`, "");
    const summarised = summariseToolLines(step.text);
    if (summarised !== "") lines.push(summarised);
  }
  lines.push(
    "",
    `Full per-step tokens and cost: \`helium audit ${report.runId}\``,
  );
  return lines.join("\n");
}

/**
 * An integer prints bare, a fraction to two places, an uncomputed number as
 * `n/a`. Two places because the header is scanned, not computed from; the
 * audit table keeps the full value.
 */
function formatMetric(value: number | null): string {
  if (value === null) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Collapse the `name -> payload` lines a deterministic step emits.
 *
 * A step that ran no model has no prose of its own — its text IS the tool
 * output — so this is where a report either stays readable or turns into a
 * JSON dump. Anything that is not one of those lines is a role's own writing
 * and passes through untouched.
 */
function summariseToolLines(text: string): string {
  // A role that was asked to answer in JSON answers in JSON, and a bare JSON
  // object pasted into markdown renders as broken prose. Fencing it is the
  // whole fix — core must not know what the object MEANS (doctrine 2), only
  // that it is structured.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return ["```json", trimmed, "```"].join("\n");
    } catch {
      /* not JSON after all; fall through to the tool-line pass */
    }
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\w+) -> (.*)$/s.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const [, name, payload] = match as unknown as [string, string, string];
    out.push(
      payload.startsWith("FAILED:")
        ? `- **${name}** — ${payload.slice("FAILED:".length).trim()}`
        : `- ${name} — ok, ${String(Buffer.byteLength(payload, "utf8"))} bytes`,
    );
  }
  return out.join("\n").trim();
}

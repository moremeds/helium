/**
 * The One Thing document: what the editor returns, parsed and reported on.
 *
 * SCHEMA HALF. Nothing here renders, writes a file or reads a run label — it
 * takes the editor's JSON and answers two questions: what came back, and what
 * is wrong with it. A missing or malformed field is a PROBLEM STRING, never a
 * throw and never a padded value: the document still renders, and the renderer
 * prints one flag line per problem beside the section it belongs to.
 *
 * **The four beats of `oneThing` are ordered so the trim takes the right
 * thing.** `trim()` cuts at the last sentence end inside the budget, so
 * whichever beat is written LAST is the one that disappears when the paragraph
 * runs long. What moved comes first, why this one second, the mechanism third
 * and who is hurt last — because a reader who loses the fourth beat still has
 * a usable item, and one who loses the first has nothing.
 * @module dsh-plugin-tenant-option-wizard/render/one-thing
 */

export interface ChangeMyMind {
  text: string;
  series: string;
  threshold: string;
  horizon: string;
}

export interface OneThingCheck {
  series: string;
  level: string;
  text: string;
}

export interface OneThingDoc {
  headline: string;
  /** Four beats in order: what moved · why this one (the renderer's supplied
   *  phrase) · mechanism · who is hurt. */
  oneThing: string;
  /** Dropped wholesale when the triple is incomplete — never padded. */
  changeMyMind?: ChangeMyMind;
  checks: OneThingCheck[];
  everythingElse: string[];
  rationales: Array<{ id: string; text: string }>;
}

/** Exactly three checks, because the next run scores exactly three. */
const CHECKS = 3;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Parse an editor document. Returns whatever was well-formed plus one problem
 * string per fault. `null` only when the input is not an object at all.
 */
export function parseOneThingDoc(value: unknown): {
  doc: OneThingDoc | null;
  problems: string[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { doc: null, problems: ["document is not an object"] };
  const row = value as Record<string, unknown>;
  const problems: string[] = [];

  const headline = text(row.headline);
  if (headline === undefined) problems.push("headline: missing");
  const oneThing = text(row.oneThing);
  if (oneThing === undefined) problems.push("oneThing: missing");

  let changeMyMind: ChangeMyMind | undefined;
  const change = row.changeMyMind;
  if (change !== undefined && change !== null && typeof change === "object") {
    const cell = change as Record<string, unknown>;
    const missing = (
      ["text", "series", "threshold", "horizon"] as const
    ).filter((key) => text(cell[key]) === undefined);
    if (missing.length === 0) {
      changeMyMind = {
        text: cell.text as string,
        series: cell.series as string,
        threshold: cell.threshold as string,
        horizon: cell.horizon as string,
      };
    } else {
      // The whole object goes, and the renderer prints one flag line. A view
      // with a price that kills it is only useful if all three of the price,
      // the series and the deadline are there.
      problems.push(`changeMyMind: missing ${missing.join(", ")}`);
    }
  }

  const checks: OneThingCheck[] = [];
  if (Array.isArray(row.checks)) {
    for (const entry of row.checks) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const series = text(cell.series);
      const level = text(cell.level);
      const body = text(cell.text);
      if (series === undefined || level === undefined || body === undefined) {
        problems.push("checks: an entry is missing series, level or text");
        continue;
      }
      checks.push({ series, level, text: body });
    }
  }
  if (checks.length !== CHECKS)
    problems.push(`checks: ${String(checks.length)} of ${String(CHECKS)}`);

  const everythingElse = Array.isArray(row.everythingElse)
    ? row.everythingElse.filter(
        (line: unknown): line is string => text(line) !== undefined,
      )
    : [];

  const rationales: Array<{ id: string; text: string }> = [];
  if (Array.isArray(row.rationales))
    for (const entry of row.rationales) {
      const cell = (entry ?? {}) as Record<string, unknown>;
      const id = text(cell.id);
      const body = text(cell.text);
      if (id === undefined || body === undefined) continue;
      rationales.push({ id, text: body });
    }

  return {
    doc: {
      headline: headline ?? "",
      oneThing: oneThing ?? "",
      ...(changeMyMind === undefined ? {} : { changeMyMind }),
      checks,
      everythingElse,
      rationales,
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// rendering half
// ---------------------------------------------------------------------------

/**
 * The lead item, the footer and the metric rows, from the frame the
 * deterministic step already computed.
 *
 * It does NOT re-extract channels and does NOT recompute a score: the frame is
 * the single computation, and a second one is how the prompt and the audit
 * table end up disagreeing. It touches no filesystem — the checks reach disk
 * through the editor's fence and the runner's `liftState`, never from here.
 */
export interface LeadFields {
  oneThing?: { title: string; body: string; why: string; checksLine: string };
  footer: { coverage: string[]; asOf: string[]; notes: string[] };
  faults?: string[];
}

/** The fixed title. The model does not name its own lead item: five different
 *  titles across five runs is five documents, not one publication. */
export const ONE_THING_TITLE = "The one thing";

const NO_DATA = "no-data";

/** `select.mode` as a number, because the audit table stores numbers. */
const MODE_CODE: Record<string, number> = {
  ratio: 0,
  persistence: 1,
  invalidation: 2,
  [NO_DATA]: 3,
};

/** What the frame needs to look like for this module. Structural, not
 *  imported as a class: `quality/frame.ts` owns the shape and this reads it. */
export interface LeadFrame {
  mode: string;
  why: string;
  streak?: number;
  ranked: Array<{
    id: string;
    series: string;
    /** The channel's own number, as its source spelled it. Read back as a
     *  string and parsed only where a `LEVEL_METRIC` row needs it. */
    level?: string;
    move?: string;
    score: number | null;
    medianSource: 0 | 1 | null;
    asOf?: string;
    excluded?: string;
    delta?: number;
  }>;
  checks: {
    line: string;
    scored: Array<{ verdict: string }>;
  };
  coverage: Array<{
    layer: string;
    source: string;
    asOf?: string;
    state: string;
    reason?: string;
  }>;
  focus?: { notes?: string[] };
  notes?: string[];
}

export function leadFields(args: {
  frame: LeadFrame;
  body: string;
  problems: readonly string[];
}): LeadFields {
  const { frame } = args;
  const coverage = frame.coverage.map((row) =>
    row.state === "skipped"
      ? `${row.layer} — ${row.source}: ${row.reason ?? "skipped"}`
      : `${row.layer} — ${row.source}`,
  );
  // Each source's OWN as-of string, copied. Never reformatted and never
  // converted: a timestamp a reader can look up is one nobody rewrote.
  const asOf = frame.coverage
    .filter((row) => row.asOf !== undefined)
    .map((row) => `${row.source} — ${row.asOf!}`);
  const notes = [
    ...(frame.notes ?? []),
    ...(frame.focus?.notes ?? []),
    ...frame.coverage
      .filter((row) => row.state === "skipped")
      .map((row) => `no answer from ${row.source}: ${row.reason ?? "skipped"}`),
  ];
  const faults = args.problems.map((problem) =>
    problem.startsWith("changeMyMind")
      ? `invalidation incomplete — ${problem}`
      : problem,
  );
  return {
    // A day nothing could be ranked has no lead item, and saying so is the
    // footer's job. Inventing one would be the harness's opinion.
    ...(frame.mode === NO_DATA || args.body.trim() === ""
      ? {}
      : {
          oneThing: {
            title: ONE_THING_TITLE,
            body: args.body,
            why: frame.why,
            checksLine: frame.checks.line,
          },
        }),
    footer: { coverage, asOf, notes },
    ...(faults.length === 0 ? {} : { faults }),
  };
}

/**
 * The channel rows, one per run, `null` for every excluded channel.
 *
 * `null` is "not computable this run" and is NOT zero
 * (`packages/core/src/audit.ts` says so on `MetricRow`) — a zero denominator
 * makes a missing history look like the biggest move of the year.
 *
 * The MOVE row names are `quality/history.ts`'s `MOVE_METRIC`, not a second
 * list: those are exactly the names `channelHistory` reads back as next
 * session's denominator, so a name that drifted here would silently give every
 * channel a day-one median forever.
 */
export function channelMetrics(args: {
  frame: LeadFrame;
  moveMetric: Readonly<Record<string, string>>;
  /** `quality/history.ts`'s `LEVEL_METRIC` — the three channels whose payload
   *  carries no prior of its own, so the d1 has to be read back out of this
   *  table next session. Nothing wrote these rows until 2026-09-06, which is
   *  why `policy.path` and `flow` printed a level and never a move. */
  levelMetric?: Readonly<Record<string, string | undefined>>;
  order: readonly string[];
  proseWords: number;
  invalidationComplete: boolean;
}): Array<{ name: string; short: string; value: number | null }> {
  const { frame } = args;
  const byId = new Map(frame.ranked.map((row) => [row.id, row]));
  const rows: Array<{ name: string; short: string; value: number | null }> = [];
  const shorts: Record<string, string> = {
    rates: "r10",
    curve: "r2s10",
    policy: "pol",
    credit: "cr",
    vol: "vol",
    dealer: "dlr",
    flow: "flw",
    event: "evt",
  };
  for (const id of args.order) {
    const row = byId.get(id);
    const name = args.moveMetric[id];
    if (name === undefined) continue;
    rows.push({
      name,
      short: shorts[id] ?? id,
      value:
        row === undefined ||
        row.excluded !== undefined ||
        row.delta === undefined
          ? null
          : row.delta,
    });
  }
  // The LEVEL rows. Written even for an EXCLUDED channel: "no prior
  // observation for the policy path" is exactly the state this row exists to
  // end, and refusing to store the level would keep it excluded for ever.
  for (const id of args.order) {
    const name = args.levelMetric?.[id];
    if (name === undefined) continue;
    const level = Number(byId.get(id)?.level);
    rows.push({
      name,
      short: `${shorts[id] ?? id}.l`,
      value: Number.isFinite(level) ? level : null,
    });
  }
  for (const id of args.order) {
    const row = byId.get(id);
    rows.push({
      name: `channel.${id}.score`,
      short: `${id}.s`,
      value: row?.score ?? null,
    });
    rows.push({
      name: `channel.${id}.medianSource`,
      short: `${id}.m`,
      value: row?.medianSource ?? null,
    });
  }
  const top = frame.ranked.find((row) => row.score !== null);
  rows.push({
    name: "select.top.score",
    short: "top",
    value: top?.score ?? null,
  });
  rows.push({
    name: "select.mode",
    short: "mode",
    value: MODE_CODE[frame.mode] ?? null,
  });
  rows.push({
    name: "select.streak.sessions",
    short: "strk",
    value: frame.streak ?? null,
  });
  const scored = frame.checks.scored;
  rows.push({ name: "checks.scored", short: "scd", value: scored.length });
  rows.push({
    name: "checks.hit",
    short: "hit",
    value: scored.filter((row) => row.verdict === "hit").length,
  });
  rows.push({
    name: "checks.miss",
    short: "mss",
    value: scored.filter((row) => row.verdict === "miss").length,
  });
  rows.push({
    name: "checks.notObserved",
    short: "nob",
    value: scored.filter((row) => row.verdict === "not-observed").length,
  });
  rows.push({
    name: "brief.proseWords",
    short: "words",
    value: args.proseWords,
  });
  // `invalidation-triple` was CONSIDERED AS A GATE AND REJECTED (doctrine 6):
  // the renderer already drops the incomplete object, already flags it in
  // `view.faults` beside `staleness`, and this row already answers "how often
  // did the editor skip the horizon" with a SELECT. Nothing breaks without the
  // gate, and a gate with no caught defect behind it is ceremony. Build it only
  // if this row shows the field missing on more than one run in twenty.
  rows.push({
    name: "brief.invalidationComplete",
    short: "inv",
    value: args.invalidationComplete ? 1 : 0,
  });
  return rows;
}

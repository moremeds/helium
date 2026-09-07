/**
 * How this tenant checks what it promised, against the lake.
 *
 * Order of the rules matters and is the design (§5 D3): coverage first, then
 * entry, then resolution, then direction, then the score. Coverage first
 * because "we cannot see" and "it did not happen" are different answers and
 * only one of them is a verdict — a lake gap that reads as `not-entered` is a
 * measurement that quietly rewards the model for the pipeline being broken.
 *
 * The `-entry` / `-result` rules below are implemented and tested, and V0
 * emits no candidate forecast commitment for them to settle: the candidate
 * numbers come from the candidate-selection team being built separately, and
 * they light up the day it emits them.
 * @module dsh-plugin-tenant-option-wizard/eval/settle
 */
import { createHash } from "node:crypto";
import { readLedger, type Commitment, type Receipt, type Settler } from "@helium/core";
import { settleFocus, settleVerdict } from "./verdict.js";
import {
  apexBarSource,
  MIN_RTH_BARS,
  missingWeekdays,
  rthSessions,
  type Bar,
  type BarSource,
  type TenantCalendar,
} from "./bars.js";

/** The tenant whose ledger the verdict settler reads its later observations
 *  from. The same literal `quality/frame.ts` and `ow_review_window` use. */
const TENANT = "option-wizard";

type Side = "above" | "below";
type Level = { level: number; side: Side };
type Resolution = "targetFirst" | "invalidationFirst" | "unresolved";

export function binaryBrier(p: number, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}

export function threeClassBrier(
  p: Record<Resolution, number>,
  outcome: Resolution,
): number {
  const classes: Resolution[] = [
    "targetFirst",
    "invalidationFirst",
    "unresolved",
  ];
  return classes.reduce(
    (total, key) => total + (p[key] - (key === outcome ? 1 : 0)) ** 2,
    0,
  );
}

function touches(bar: Bar, level: Level): boolean {
  return level.side === "above"
    ? bar.high >= level.level
    : bar.low <= level.level;
}

/** Exported so `eval/verdict.ts`'s focus settler hashes its evidence the same
 *  way this one does. One definition, because two settlers that disagreed
 *  about what a bar hash is would make two receipts incomparable. */
export function hashBars(bars: readonly Bar[]): string {
  return createHash("sha256")
    .update(
      bars
        .map(
          (bar) =>
            `${bar.time}|${String(bar.high)}|${String(bar.low)}|${String(bar.close)}`,
        )
        .join("\n"),
    )
    .digest("hex");
}

/** Exported for the same reason as `hashBars`: one shape for "not yet". */
export function pending(
  commitment: Commitment,
  now: Date,
  reason: string,
): Receipt {
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: "pending",
    scores: {},
    detail: { reason },
  };
}

/**
 * Every ET session in `[from, to]` that the lake can answer for, and the ones
 * it cannot. A weekday with no 1d bar, or a session with fewer than
 * MIN_RTH_BARS 1m bars, is a GAP — not a quiet market.
 */
function coverage(
  daily: readonly Bar[],
  minute: Map<string, Bar[]>,
  from: string,
  to: string,
  calendar?: TenantCalendar,
): { sessions: string[]; short: string[]; missing: string[] } {
  const sessions = daily
    .map((bar) => bar.time)
    .filter((date) => date >= from && date <= to)
    .sort();
  // `from` itself is EXCLUDED from the tape check: the reference-close session
  // is the anchor, not a session anything is evaluated on — the entry window
  // and the resolution walk both start strictly after it — and a source that
  // serves the anchor's daily close without its 1m tape is not a gap.
  const short = sessions.filter(
    (date) => date > from && (minute.get(date)?.length ?? 0) < MIN_RTH_BARS,
  );
  // The calendar cross-check. Without it a lake that lost a whole day looks
  // identical to a market that was shut: both are "no bar", and one of them
  // must not be scored.
  const missing = missingWeekdays(sessions, from, to, calendar);
  return { sessions, short, missing };
}

async function settleSpy(
  commitment: Commitment,
  now: Date,
  source: BarSource,
  calendar?: TenantCalendar,
): Promise<Receipt> {
  const payload = commitment.payload as {
    horizonBars: number;
    symbol: string;
    referenceClose: { date: string; value: number };
    pDown: number;
  };
  // Deliberately generous: the window is counted in BARS, so ask for enough
  // calendar days that the n-th bar is certainly inside it, then count.
  const from = payload.referenceClose.date;
  const to = new Date(
    Date.parse(`${from}T00:00:00Z`) + (payload.horizonBars + 10) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const daily = await source.bars1d(payload.symbol, from, to);
  const after = daily
    .filter((bar) => bar.time > from)
    .sort((a, b) => a.time.localeCompare(b.time));
  // Same cross-check as the candidate path, and it must run BEFORE the count:
  // counting bars over a window with a hole in it settles `t5` against what is
  // really the sixth session.
  const gaps = missingWeekdays(
    daily.map((bar) => bar.time),
    from,
    after[payload.horizonBars - 1]?.time ?? from,
    calendar,
  );
  if (gaps.length > 0)
    return pending(
      commitment,
      now,
      `lake gap: open weekday(s) with no daily bar: ${gaps.join(", ")}`,
    );
  const bar = after[payload.horizonBars - 1];
  if (bar === undefined)
    return pending(
      commitment,
      now,
      `only ${String(after.length)} daily bar(s) after ${from}; need ${String(payload.horizonBars)}`,
    );
  const down = bar.close < payload.referenceClose.value;
  const key = `t${String(payload.horizonBars)}Brier`;
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: down ? "down" : "up",
    scores: { [key]: binaryBrier(payload.pDown, down ? 1 : 0) },
    evidenceHash: hashBars([bar]),
    detail: {
      settledOn: bar.time,
      close: bar.close,
      referenceClose: payload.referenceClose,
      // Raw, never adjusted. SPY goes ex around the third Friday of September,
      // inside the first live window; recording it is what lets a later reader
      // see the distortion rather than a corrected number that hides it.
      priceBasis: "raw, not dividend-adjusted",
    },
  };
}

async function settleCandidate(
  commitment: Commitment,
  now: Date,
  source: BarSource,
  calendar?: TenantCalendar,
): Promise<Receipt> {
  const payload = commitment.payload as {
    symbol: string;
    entry?: Level & { deadlineBars: number };
    referenceClose: { date: string; value: number };
    invalidation: Level[];
    target?: Level;
    resolutionDeadline: string;
    forecast: {
      pTrigger: number;
      givenTrigger: Record<Resolution, number>;
    };
  };
  const from = payload.referenceClose.date;
  const to = payload.resolutionDeadline;
  const [daily, minute] = await Promise.all([
    source.bars1d(payload.symbol, from, to),
    source.bars1m(payload.symbol, from, to),
  ]);
  const sessions = rthSessions(minute);
  const {
    sessions: known,
    short,
    missing,
  } = coverage(daily, sessions, from, to, calendar);
  if (known.length === 0 || short.length > 0 || missing.length > 0)
    return pending(
      commitment,
      now,
      missing.length > 0
        ? `lake gap: open weekday(s) with no daily bar: ${missing.join(", ")}`
        : short.length > 0
          ? `sessions short of ${String(MIN_RTH_BARS)} RTH bars: ${short.join(", ")}`
          : `no daily bar between ${from} and ${to}`,
    );
  // The spine of both walks is the RTH TAPE, not the daily list: a level is
  // touched inside a minute bar, and a session the lake has minute bars for is
  // a session this settler can answer about. The daily rows above stay what
  // COVERAGE is judged on — they are the lake's own word on which days exist,
  // which is what the calendar cross-check needs.
  const after = [...sessions.keys()]
    .filter((date) => date > from && date <= to)
    .sort();
  const used: Bar[] = [];

  // 2. Entry. No `entry` field means the thesis was live from issue.
  let entered: { bar: Bar; session: string; index: number } | undefined;
  if (payload.entry === undefined) {
    const first = after[0];
    const bars = first === undefined ? [] : (sessions.get(first) ?? []);
    if (bars[0] === undefined)
      return pending(commitment, now, "no session after the reference close yet");
    entered = { bar: bars[0], session: first!, index: 0 };
  } else {
    const window = after.slice(0, payload.entry.deadlineBars);
    if (window.length < payload.entry.deadlineBars)
      return pending(
        commitment,
        now,
        `only ${String(window.length)} of ${String(payload.entry.deadlineBars)} deadline sessions exist`,
      );
    outer: for (const session of window) {
      const bars = sessions.get(session) ?? [];
      for (const [index, bar] of bars.entries()) {
        used.push(bar);
        if (touches(bar, payload.entry)) {
          entered = { bar, session, index };
          break outer;
        }
      }
    }
    if (entered === undefined)
      return {
        commitmentId: commitment.id,
        runId: "",
        settledAt: now.toISOString(),
        status: "not-entered",
        scores: { triggerBrier: binaryBrier(payload.forecast.pTrigger, 0) },
        evidenceHash: hashBars(used),
        detail: { deadlineSessions: window },
      };
  }

  const scores: Record<string, number> = {
    triggerBrier: binaryBrier(payload.forecast.pTrigger, 1),
  };

  // 3. Resolution, STRICTLY after the entry bar: a level touched by the bar
  // that filled the entry is not a move the thesis made.
  let outcome: Resolution | "ambiguous" = "unresolved";
  let resolvedAt: string | undefined;
  const walk = after.slice(after.indexOf(entered.session));
  scan: for (const [order, session] of walk.entries()) {
    const bars = (sessions.get(session) ?? []).slice(
      order === 0 ? entered.index + 1 : 0,
    );
    for (const bar of bars) {
      used.push(bar);
      const hitStop = payload.invalidation.some((level) => touches(bar, level));
      const hitTarget =
        payload.target !== undefined && touches(bar, payload.target);
      if (hitStop && hitTarget) {
        outcome = "ambiguous";
        resolvedAt = bar.time;
        break scan;
      }
      if (hitStop) {
        outcome = "invalidationFirst";
        resolvedAt = bar.time;
        break scan;
      }
      if (hitTarget) {
        outcome = "targetFirst";
        resolvedAt = bar.time;
        break scan;
      }
    }
  }
  // Nothing touched yet and the deadline has not passed: still open. Measured
  // against the last session actually WALKED, for the same reason the walk
  // uses the tape: a deadline is reached by sessions that were examined.
  if (outcome === "unresolved" && after.at(-1)! < payload.resolutionDeadline)
    return pending(commitment, now, `open; sessions through ${after.at(-1)!}`);

  if (outcome !== "ambiguous")
    scores.resolutionBrier = threeClassBrier(
      payload.forecast.givenTrigger,
      outcome,
    );

  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: outcome,
    scores,
    evidenceHash: hashBars(used),
    detail: {
      enteredAt: entered.bar.time,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      sessions: known,
      priceBasis: "raw, not dividend-adjusted",
    },
  };
}

/**
 * @param source Null when no bar source is configured. The BAR-BACKED kinds
 * then pend and the ledger-backed ones still settle — a verdict is scored
 * against the next stored observation of its own row and needs no market data,
 * so an unset apex base must not stop it.
 * @param all Every commitment in the ledger, open or settled. A verdict's next
 * dated observation is usually a commitment that has ALREADY settled, so the
 * open set alone cannot supply it.
 */
export async function settleAll(
  open: Commitment[],
  now: Date,
  source: BarSource | null,
  calendar?: TenantCalendar,
  all?: readonly Commitment[],
): Promise<Receipt[]> {
  const out: Receipt[] = [];
  const NO_BARS = "OW_APEX_API_BASE is unset; nothing was checked";
  // The ledger's rows UNION the open set, deduplicated by id: a verdict's next
  // observation is usually already settled (so it is in `all` and not in
  // `open`), but on a machine whose ledger could not be read the open set is
  // still evidence we hold.
  const byId = new Map<string, Commitment>();
  for (const row of [...(all ?? []), ...open]) byId.set(row.id, row);
  const later = [...byId.values()];
  for (const commitment of open) {
    const kind = (commitment.payload as { kind?: unknown }).kind;
    try {
      if (kind === "spy-direction")
        out.push(
          source === null
            ? pending(commitment, now, NO_BARS)
            : await settleSpy(commitment, now, source, calendar),
        );
      else if (kind === "candidate-entry" || kind === "candidate-result")
        out.push(
          source === null
            ? pending(commitment, now, NO_BARS)
            : await settleCandidate(commitment, now, source, calendar),
        );
      else if (kind === "coverage-verdict")
        out.push(
          settleVerdict({
            commitment,
            later,
            now,
            ...(calendar === undefined ? {} : { calendar }),
          }),
        );
      else if (kind === "focus-admit")
        out.push(
          source === null
            ? pending(commitment, now, NO_BARS)
            : await settleFocus({
                commitment,
                now,
                source,
                ...(calendar === undefined ? {} : { calendar }),
              }),
        );
      // A kind this build does not know is left ALONE, not settled: a newer
      // renderer's commitment must not be closed off by an older settler.
    } catch (error: unknown) {
      out.push(
        pending(
          commitment,
          now,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return out;
}

/**
 * The tenant's declaration, built the way `buildTools` is.
 *
 * A FACTORY, not a constant: the API base is an env key the manifest declares
 * (`tenant.yaml:32`) and the host forwards through `cfg.env`, and the calendar
 * is the tenant's own `calendar:` block. Reading `process.env` here would take
 * both from behind the host's back — the exact seam `TenantToolConfig` exists
 * to be.
 *
 * Reads apex; writes nothing anywhere (doctrine 5: outside a sandbox, never
 * touch the production lake).
 */
export function buildSettler(cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
  variant: string;
  asOf?: Date;
  calendar?: TenantCalendar;
}): Settler {
  return {
    async settle(open: Commitment[], now: Date): Promise<Receipt[]> {
      const base = cfg.env.OW_APEX_API_BASE;
      // The guard NARROWED (2026-09-06): it used to pend everything, which
      // would have made a coverage verdict unscorable on a machine with no
      // apex — and a verdict settles from the ledger, not from bars.
      const source =
        base === undefined || base === "" ? null : apexBarSource(base);
      // The ledger's own rows are the verdict settler's evidence. An absent or
      // unreadable ledger is not an error here: `settleAll` then falls back to
      // the open set, and a verdict with no later observation simply pends.
      let all: readonly Commitment[] | undefined;
      try {
        all = readLedger(cfg.stateRoot, TENANT).commitments;
      } catch {
        all = undefined;
      }
      return settleAll(open, now, source, cfg.calendar, all);
    },
  };
}

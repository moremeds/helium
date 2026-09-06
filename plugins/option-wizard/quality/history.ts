/**
 * The denominator: what a channel's move usually looks like.
 *
 * This is the ONLY module in `quality/` that touches the audit store. It opens
 * a short-lived read-only connection, reads it, and closes it in a `finally` —
 * a leaked handle leaks one per run, forever. `tools/index.ts`'s `qualityByDay`
 * is the shape being copied.
 *
 * The runner already holds the same SQLite file open through `options.audit`.
 * Two connections to one WAL database in one process is supported; this one is
 * short-lived and never writes, and no second long-lived handle is added.
 *
 * A failure here is a `note`, never a throw: a laptop with no `audit.db` still
 * gets a ranking, scored from the channels' own series instead.
 */
import { AuditStore } from "@helium/core";
import { seriesHistory, type Channel, type ChannelId, type ChannelInputs } from "./channels.js";

export interface ChannelHistory {
  /** Absolute moves, newest first. */
  moves: number[];
  /** 0 = derived from the channel's own daily series; 1 = accumulated metric
   *  rows. Recorded because a day-one ratio takes its numerator from a live
   *  level and its denominator from whichever of these answered, and a number
   *  with an unstated denominator is a number nobody can check. */
  medianSource: 0 | 1;
}

/** Below this, a median is not a median — it is two rows and a hope. */
export const MIN_HISTORY = 20;

/**
 * The metric row each channel's MOVE is stored under. Distinct from the
 * `channel.<id>.*` LEVEL metrics `quality/channels.ts` reads for a d1: a level
 * answers "what was it yesterday", a move answers "how big is big".
 */
export const MOVE_METRIC: Record<ChannelId, string> = {
  rates: "channel.rates.d10y_bp",
  curve: "channel.curve.d2s10s_bp",
  policy: "channel.policy.dprob_pp",
  credit: "channel.credit.dhy_bp",
  vol: "channel.vol.dvix_pt",
  dealer: "channel.dealer.dflip_pt",
  flow: "channel.flow.dnet_premium_usd",
  event: "channel.event.count",
};

/** Yields are stored in percent and moved in basis points; everything else
 *  moves in its own unit. One place, so the series-derived denominator and the
 *  metric-derived one are on the same scale. */
const MOVE_SCALE: Partial<Record<ChannelId, number>> = {
  rates: 100,
  curve: 100,
  credit: 100,
};

function movesFromSeries(
  inputs: ChannelInputs,
  id: ChannelId,
): number[] {
  const levels = seriesHistory(inputs, id);
  const scale = MOVE_SCALE[id] ?? 1;
  const moves: number[] = [];
  for (let i = 0; i + 1 < levels.length; i += 1) {
    const move = Math.abs((levels[i]! - levels[i + 1]!) * scale);
    if (Number.isFinite(move)) moves.push(move);
  }
  return moves;
}

export function channelHistory(args: {
  channels: Channel[];
  inputs: ChannelInputs;
  days: string[];
  env?: NodeJS.ProcessEnv;
}): { history: Map<ChannelId, ChannelHistory>; note?: string } {
  const { channels, inputs, days } = args;
  const env = args.env ?? process.env;
  const history = new Map<ChannelId, ChannelHistory>();
  const stored = new Map<string, number[]>();
  let note: string | undefined;
  if (days.length > 0) {
    let store: AuditStore | undefined;
    try {
      store = AuditStore.open(env);
      const from = days[0]!;
      const to = days.at(-1)!;
      // metricsBetween returns oldest first; the caller wants newest first.
      for (const row of store.metricsBetween(
        from <= to ? from : to,
        from <= to ? to : from,
      )) {
        if (row.value === null || !Number.isFinite(row.value)) continue;
        const list = stored.get(row.name) ?? [];
        list.push(Math.abs(row.value));
        stored.set(row.name, list);
      }
      for (const list of stored.values()) list.reverse();
    } catch (error: unknown) {
      note = `channel history unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      store?.close();
    }
  }
  for (const channel of channels) {
    const rows = stored.get(MOVE_METRIC[channel.id]) ?? [];
    if (rows.length >= MIN_HISTORY) {
      history.set(channel.id, {
        moves: rows.slice(0, MIN_HISTORY),
        medianSource: 1,
      });
      continue;
    }
    const derived = movesFromSeries(inputs, channel.id);
    if (derived.length > 0) {
      history.set(channel.id, {
        moves: derived.slice(0, MIN_HISTORY),
        medianSource: 0,
      });
      continue;
    }
    // Neither source answered. An EMPTY moves array, never a zero: a zero
    // denominator makes a missing history look like the biggest move of the
    // year.
    history.set(channel.id, { moves: [], medianSource: rows.length > 0 ? 1 : 0 });
  }
  return note === undefined ? { history } : { history, note };
}

/**
 * Rank the channels against their own history and say, in one supplied phrase,
 * why the leader leads.
 *
 * Pure — it imports `./channels.js` and `./history.js` for types and nothing
 * else. The `why` string is FORMATTED HERE, not by the model: the model copies
 * it verbatim, which is what keeps the one number in the lead sentence exactly
 * the one the metric row carries (doctrine 4).
 */
import type { Channel } from "./channels.js";
import { MIN_HISTORY, MOVE_METRIC, type ChannelHistory } from "./history.js";
import type { ChannelId } from "./channels.js";

export type SelectMode = "ratio" | "persistence" | "invalidation" | "no-data";

export interface Ranked {
  channel: Channel;
  score: number | null;
  medianSource: 0 | 1 | null;
}

export interface Selection {
  mode: SelectMode;
  ranked: Ranked[];
  /** The phrase the model is HANDED and must copy. */
  why: string;
  streak?: number;
  breach?: {
    series: string;
    threshold: string;
    horizon: string;
    level: string;
  };
}

/** At or above this, the leader's move is the story. Below it, nothing stood
 *  out and the document says so instead of inventing a headline. */
export const RATIO_THRESHOLD = 2.0;
/** A dated event landing today scores this much with no history at all — it is
 *  a fact about the calendar, not a measurement. */
export const EVENT_SCORE = 2.0;

/** The median of an empty array is `undefined`, NOT 0. A zero denominator
 *  makes a missing history look like the biggest move of the year. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `>4.85`, `>=4.85`, `<3.5`. A threshold with no operator cannot be breached
 *  by this code, and says so by returning undefined rather than guessing a
 *  direction. */
function breached(threshold: string, level: number): boolean | undefined {
  const match = /^\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(threshold);
  if (match === null) return undefined;
  const bound = Number(match[2]);
  if (!Number.isFinite(bound)) return undefined;
  switch (match[1]) {
    case ">":
      return level > bound;
    case ">=":
      return level >= bound;
    case "<":
      return level < bound;
    default:
      return level <= bound;
  }
}

/** How many trailing days in a row the winner carried the largest absolute
 *  value. Walked newest-first and stopped at the first day it did not. */
function streakOf(
  metricName: string,
  trail: ReadonlyArray<{ day: string; values: Record<string, number | null> }>,
): number {
  let streak = 0;
  for (const entry of trail) {
    const mine = entry.values[metricName];
    if (mine === undefined || mine === null || !Number.isFinite(mine)) break;
    const best = Math.max(
      ...Object.values(entry.values)
        .filter((v): v is number => v !== null && Number.isFinite(v))
        .map((v) => Math.abs(v)),
    );
    if (Math.abs(mine) < best) break;
    streak += 1;
  }
  return streak;
}

export function select(args: {
  channels: Channel[];
  history: Map<ChannelId, ChannelHistory>;
  standing?: { series: string; threshold: string; horizon: string };
  trail?: Array<{ day: string; values: Record<string, number | null> }>;
}): Selection {
  const { channels, history, standing, trail } = args;

  // A view with a price that kills it is the only claim already paid for, so a
  // breached standing invalidation wins outright — ahead of any ratio.
  if (standing !== undefined) {
    const hit = channels.find((c) => c.series === standing.series);
    const level = hit?.level === undefined ? undefined : Number(hit.level);
    if (
      hit !== undefined &&
      level !== undefined &&
      Number.isFinite(level) &&
      breached(standing.threshold, level) === true
    ) {
      return {
        mode: "invalidation",
        ranked: [{ channel: hit, score: null, medianSource: null }],
        why: `the standing invalidation was breached: ${standing.series} at ${hit.level} against ${standing.threshold} over ${standing.horizon}`,
        breach: {
          series: standing.series,
          threshold: standing.threshold,
          horizon: standing.horizon,
          level: hit.level!,
        },
      };
    }
  }

  // Excluded channels are dropped BEFORE scoring: a channel with no move has
  // no ratio, and ranking it last would still put it in a table that is meant
  // to be the numbers we actually have.
  const scorable = channels.filter((c) => c.magnitude !== undefined);
  if (scorable.length === 0) {
    return { mode: "no-data", ranked: [], why: "" };
  }

  const ranked: Ranked[] = scorable.map((channel) => {
    const entry = history.get(channel.id);
    const mid = median(entry?.moves ?? []);
    if (entry !== undefined && entry.moves.length >= MIN_HISTORY && mid !== undefined && mid > 0) {
      return {
        channel,
        score: channel.magnitude! / mid,
        medianSource: entry.medianSource,
      };
    }
    // Too little history to normalise against. A sign flip or a dated event
    // landing today is still a fact worth ranking on; anything else scores
    // null and sorts last, rather than borrowing a denominator it does not
    // have.
    if (channel.signFlip === true || channel.id === "event") {
      return { channel, score: EVENT_SCORE, medianSource: entry?.medianSource ?? null };
    }
    return { channel, score: null, medianSource: null };
  });

  ranked.sort((a, b) => {
    if (a.score === null && b.score === null)
      return a.channel.order - b.channel.order;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    if (a.score !== b.score) return b.score - a.score;
    return a.channel.order - b.channel.order;
  });

  const top = ranked[0]!;
  if (top.score === null) {
    return {
      mode: "no-data",
      ranked,
      why: "",
    };
  }
  if (top.score >= RATIO_THRESHOLD) {
    const sessions = history.get(top.channel.id)?.moves.length ?? 0;
    return {
      mode: "ratio",
      ranked,
      why: `largest normalised move of the session, ${top.score.toFixed(1)}x its ${sessions}-session median`,
    };
  }
  const streak =
    trail === undefined
      ? 0
      : streakOf(MOVE_METRIC[top.channel.id], trail);
  return {
    mode: "persistence",
    ranked,
    why: `no single move stood out; ${top.channel.series} has led for ${streak} sessions`,
    streak,
  };
}

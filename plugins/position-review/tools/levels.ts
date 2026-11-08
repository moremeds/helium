/**
 * Every number the position report prints is derived here, in plain code.
 * The model picks a level from the candidates and copies the figures; it never
 * computes one (operator rule: the LLM does no arithmetic).
 *
 * Pure functions, no I/O, so the test can pin each one with a hand-checkable case.
 * @module position-review/levels
 */

export interface DailyBar { time: string; open: number; high: number; low: number; close: number; volume?: number }
export interface MinuteBar { time: string; high: number; low: number; close: number; volume: number }

// ---------- technicals (daily bars, oldest first) ----------

export function sma(bars: DailyBar[], n: number): number | undefined {
  if (bars.length < n) return undefined;
  return bars.slice(-n).reduce((s, b) => s + b.close, 0) / n;
}

/** Wilder ATR. */
export function atr(bars: DailyBar[], n = 14): number | undefined {
  if (bars.length < n + 1) return undefined;
  const tr = bars.slice(1).map((b, i) => {
    const prev = bars[i]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (const x of tr.slice(n)) a = (a * (n - 1) + x) / n;
  return a;
}

/** Pivot lows/highs: a bar whose low (high) is the extreme of `k` bars on each side. */
export function swings(bars: DailyBar[], k = 3): { lows: DailyBar[]; highs: DailyBar[] } {
  const lows: DailyBar[] = [];
  const highs: DailyBar[] = [];
  for (let i = k; i < bars.length - k; i += 1) {
    const win = bars.slice(i - k, i + k + 1);
    if (win.every((b) => b.low >= bars[i]!.low)) lows.push(bars[i]!);
    if (win.every((b) => b.high <= bars[i]!.high)) highs.push(bars[i]!);
  }
  return { lows, highs };
}

// ---------- volume profile (1m bars) ----------

export interface Profile { poc: number; vah: number; val: number; hvn: number[]; lvn: number[]; bucket: number }

/** Each bar's volume spread evenly over its high–low range, bucketed by `bucket`. */
export function volumeProfile(bars: MinuteBar[], bucket: number): Profile | undefined {
  const vol = new Map<number, number>();
  for (const b of bars) {
    if (!(b.volume > 0)) continue;
    const lo = Math.floor(b.low / bucket);
    const hi = Math.floor(b.high / bucket);
    const share = b.volume / (hi - lo + 1);
    for (let i = lo; i <= hi; i += 1) vol.set(i, (vol.get(i) ?? 0) + share);
  }
  if (vol.size === 0) return undefined;
  const keys = [...vol.keys()].sort((a, b) => a - b);
  const lo = keys[0]!;
  const v = Array.from({ length: keys.at(-1)! - lo + 1 }, (_, i) => vol.get(lo + i) ?? 0);
  const at = (i: number) => (lo + i + 0.5) * bucket;
  const p = v.indexOf(Math.max(...v));
  // Value area: grow from the POC toward the larger neighbour until 70% of volume.
  const total = v.reduce((s, x) => s + x, 0);
  let [a, b, got] = [p, p, v[p]!];
  while (got < 0.7 * total && (a > 0 || b < v.length - 1)) {
    const down = a > 0 ? v[a - 1]! : -1;
    const up = b < v.length - 1 ? v[b + 1]! : -1;
    if (up >= down) got += v[++b]!; else got += v[--a]!;
  }
  // Nodes on a 5-bucket smoothed curve so one noisy bucket is not a "node".
  const s = v.map((_, i) => {
    const w = v.slice(Math.max(0, i - 2), i + 3);
    return w.reduce((x, y) => x + y, 0) / w.length;
  });
  const hvn: number[] = [];
  const lvn: number[] = [];
  for (let i = 1; i < s.length - 1; i += 1) {
    if (s[i]! > s[i - 1]! && s[i]! >= s[i + 1]!) hvn.push(at(i));
    if (s[i]! < s[i - 1]! && s[i]! <= s[i + 1]!) lvn.push(at(i));
  }
  return { poc: at(p), vah: at(b), val: at(a), hvn, lvn, bucket };
}

// ---------- GEX by side (per-strike rows) ----------

export interface GexRow { strike: number; callGamma: number; putGamma: number }
export interface GexLevels {
  callWall?: number; putWall?: number; flip?: number; accelerator?: number; netTotal: number;
}

/**
 * Walls are picked PER SIDE (call side above spot, put side below), which is
 * the side constraint argon's levels lack. `flip` is where cumulative net gamma,
 * summed from the lowest strike up, changes sign — an approximation, not a
 * re-priced gamma curve. `accelerator` is the most negative net-gamma strike
 * below spot.
 */
export function gexLevels(rows: GexRow[], spot: number): GexLevels {
  const r = [...rows].sort((a, b) => a.strike - b.strike);
  const above = r.filter((x) => x.strike >= spot);
  const below = r.filter((x) => x.strike <= spot);
  const maxBy = <T>(xs: T[], f: (x: T) => number) =>
    xs.reduce<T | undefined>((m, x) => (m === undefined || f(x) > f(m) ? x : m), undefined);
  let cum = 0;
  let flip: number | undefined;
  for (let i = 0; i < r.length; i += 1) {
    const before = cum;
    cum += r[i]!.callGamma + r[i]!.putGamma;
    if (i > 0 && Math.sign(before) !== Math.sign(cum) && before !== 0) flip = r[i]!.strike;
  }
  const acc = maxBy(below, (x) => -(x.callGamma + x.putGamma));
  return {
    callWall: maxBy(above, (x) => x.callGamma)?.strike,
    putWall: maxBy(below, (x) => Math.abs(x.putGamma))?.strike,
    flip,
    accelerator: acc !== undefined && acc.callGamma + acc.putGamma < 0 ? acc.strike : undefined,
    netTotal: cum,
  };
}

// ---------- option pricing ----------

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26, |error| < 7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

/** Black–Scholes European price; `t` in years, q = 0 (SPX dividend ignored: ceiling, label it). */
export function bs(right: "P" | "C", s: number, k: number, t: number, iv: number, r = 0.04): number {
  if (t <= 0 || iv <= 0) return Math.max(0, right === "P" ? k - s : s - k);
  const d1 = (Math.log(s / k) + (r + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  const d2 = d1 - iv * Math.sqrt(t);
  return right === "C"
    ? s * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2)
    : k * Math.exp(-r * t) * normCdf(-d2) - s * normCdf(-d1);
}

/** IV backed out of a mark by bisection; undefined when the mark is outside the model's range. */
export function impliedVol(right: "P" | "C", mark: number, s: number, k: number, t: number, r = 0.04): number | undefined {
  let [lo, hi] = [0.01, 3];
  if (mark < bs(right, s, k, t, lo, r) || mark > bs(right, s, k, t, hi, r)) return undefined;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (bs(right, s, k, t, mid, r) < mark) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- positions ----------

/** One option leg; `qty` signed (short = negative), multiplier 100. */
export interface Leg { right: "P" | "C"; strike: number; expiry: string; qty: number; iv: number }

/** Mark-to-market of the legs at a hypothetical spot, same instant, IV shifted by `ivShift` (vol points / 100). */
export function legsValue(legs: Leg[], spot: number, asOf: Date, ivShift = 0): number {
  return legs.reduce((sum, l) => {
    const t = (Date.parse(`${l.expiry}T21:00:00Z`) - asOf.getTime()) / (365 * 86_400_000);
    return sum + l.qty * 100 * bs(l.right, spot, l.strike, t, l.iv + ivShift);
  }, 0);
}

/**
 * The spot at which the MTM drop from `spotNow` equals `cushion`, by bisection
 * down to `floor`. For defined-risk verticals IB's maintenance margin is the
 * width and does not grow as spot falls, so excess liquidity falls by about the
 * MTM loss — an approximation the report must label.
 */
export function spotWhereLossReaches(
  legs: Leg[], spotNow: number, cushion: number, asOf: Date, floor: number, ivShift = 0,
): number | undefined {
  const base = legsValue(legs, spotNow, asOf);
  const loss = (s: number) => base - legsValue(legs, s, asOf, ivShift);
  if (loss(floor) < cushion) return undefined;
  let [lo, hi] = [floor, spotNow];
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (loss(mid) >= cushion) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

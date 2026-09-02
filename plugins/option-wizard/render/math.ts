/**
 * Expiry payoff for a multi-leg defined-risk structure. Pure arithmetic: no
 * I/O, no dependency, no model.
 *
 * Why the renderer computes this instead of printing what a role wrote: on
 * 2026-09-02 five of five proposals carried a `limitPrice` that disagreed with
 * their own rationale, one printed its max loss as its max gain (6x), and one
 * put spread was described in the wrong direction. Every one of those numbers
 * is derivable from the legs and the NBBO mids, so the reader gets the derived
 * one and the prose stays prose.
 *
 * The payoff is piecewise linear with kinks exactly at the strikes, so
 * evaluating at {0, every strike} finds the true extrema of the BOUNDED part,
 * and the sign of the slope above the highest strike decides whether an
 * unbounded part exists at all. Nothing is sampled or approximated.
 * @module dsh-plugin-tenant-option-wizard/render/math
 */

export interface Leg {
  right: "call" | "put";
  action: "buy" | "sell";
  strike: number;
  expiry: string;
  ratio?: number;
  /** NBBO mid, per share, as read from the chain. Never estimated. */
  mid?: number;
}

export interface PnlPoint {
  pct: -20 | -10 | -5 | 5 | 10 | 20;
  spot: number;
  pnl: number;
}

export interface Priced {
  kind: "priced";
  /** Per share. Positive is a credit received, negative a debit paid. */
  net: number;
  /** Per contract (x100). `null` means unbounded. */
  maxGain: number | null;
  /** Per contract (x100), as a POSITIVE magnitude. `null` means unbounded. */
  maxLoss: number | null;
  breakevens: number[];
  pnlAt: PnlPoint[];
}

export interface Unpriced {
  kind: "unpriced";
  reason: string;
}

export interface Invalid {
  kind: "invalid";
  reason: string;
}

export type Pricing = Priced | Unpriced | Invalid;

/** Every US equity option this tenant deals in. */
const MULTIPLIER = 100;
const PCTS = [-20, -10, -5, 5, 10, 20] as const;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const qty = (leg: Leg): number => leg.ratio ?? 1;
/** +1 long, -1 short. */
const side = (leg: Leg): number => (leg.action === "buy" ? 1 : -1);

/** The widest strike span, per share. Zero for a single-strike structure. */
export function width(legs: Leg[]): number {
  const strikes = legs.map((leg) => leg.strike);
  return round2(Math.max(...strikes) - Math.min(...strikes));
}

/** Intrinsic value of the whole structure at expiry, per share, signed. */
function intrinsic(legs: Leg[], spot: number): number {
  return legs.reduce((total, leg) => {
    const payoff =
      leg.right === "call"
        ? Math.max(spot - leg.strike, 0)
        : Math.max(leg.strike - spot, 0);
    return total + side(leg) * qty(leg) * payoff;
  }, 0);
}

/** P&L per contract at an expiry spot, including the premium paid or received. */
function pnlAtSpot(legs: Leg[], net: number, spot: number): number {
  return round2((intrinsic(legs, spot) + net) * MULTIPLIER);
}

export function priceStructure(legs: Leg[], spot: number): Pricing {
  if (legs.length === 0)
    return { kind: "invalid", reason: "结构不合规：没有任何腿" };

  // Defined-risk only. This duplicates the ib-preflight gate on purpose: the
  // renderer is the LAST reader-facing check, and a structure that slipped past
  // the gate must not reach the reader looking like a trade.
  for (const right of ["call", "put"] as const) {
    const net = legs
      .filter((leg) => leg.right === right)
      .reduce((total, leg) => total + side(leg) * qty(leg), 0);
    if (net < 0) {
      return {
        kind: "invalid",
        reason: `结构不合规：${right} 腿净空头，短腿无同权利的长腿覆盖`,
      };
    }
  }

  if (new Set(legs.map((leg) => leg.expiry)).size > 1) {
    return {
      kind: "unpriced",
      reason: "未定价：多个到期日，无法按单一到期损益计算",
    };
  }

  const missing = legs.find(
    (leg) => leg.mid === undefined || !Number.isFinite(leg.mid),
  );
  if (missing !== undefined) {
    return {
      kind: "unpriced",
      reason: `未定价：${missing.right} ${String(missing.strike)} 缺少 mid`,
    };
  }

  // Sell brings cash in, buy takes it out.
  const net = round2(
    legs.reduce((total, leg) => total - side(leg) * qty(leg) * (leg.mid ?? 0), 0),
  );

  const strikes = [...new Set(legs.map((leg) => leg.strike))].sort(
    (a, b) => a - b,
  );
  const bounded = [0, ...strikes];
  const boundedPnl = bounded.map((point) => pnlAtSpot(legs, net, point));

  // Above the highest strike every call is exercised or expired, so the slope
  // is constant: the signed call quantity. Puts contribute nothing there. Below
  // the lowest strike the domain itself is bounded (spot >= 0), so the S = 0
  // evaluation already holds that end.
  const slopeUp = legs
    .filter((leg) => leg.right === "call")
    .reduce((total, leg) => total + side(leg) * qty(leg), 0);

  const maxGain = slopeUp > 0 ? null : Math.max(...boundedPnl);
  const worst = Math.min(...boundedPnl);
  const maxLoss = slopeUp < 0 ? null : worst < 0 ? round2(-worst) : 0;

  // One extra point past the last strike so a crossing on the final ray is
  // found too. With slopeUp === 0 the ray is flat and no crossing can hide
  // there, so the extra point costs nothing.
  const scan = [...bounded, strikes[strikes.length - 1]! * 2 + 100];
  const scanPnl = scan.map((point) => pnlAtSpot(legs, net, point));
  const breakevens: number[] = [];
  for (let i = 0; i < scan.length - 1; i += 1) {
    const a = scanPnl[i]!;
    const b = scanPnl[i + 1]!;
    if (a === 0) breakevens.push(round2(scan[i]!));
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      breakevens.push(
        round2(scan[i]! + ((scan[i + 1]! - scan[i]!) * -a) / (b - a)),
      );
    }
  }
  if (scanPnl[scanPnl.length - 1]! === 0)
    breakevens.push(round2(scan[scan.length - 1]!));

  return {
    kind: "priced",
    net,
    maxGain,
    maxLoss,
    breakevens: [...new Set(breakevens)].sort((a, b) => a - b),
    pnlAt: PCTS.map((pct) => {
      const at = round2(spot * (1 + pct / 100));
      return { pct, spot: at, pnl: pnlAtSpot(legs, net, at) };
    }),
  };
}

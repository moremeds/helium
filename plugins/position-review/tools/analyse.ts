/**
 * Raw broker snapshot -> every figure the report may print. The model copies
 * these; it computes none (operator rule: the LLM does no arithmetic).
 * @module position-review/analyse
 */
import {
  atr, bs, impliedVol, legsValue, sma, spotWhereLossReaches, swings, volumeProfile,
  type DailyBar, type Leg, type MinuteBar,
} from "./levels.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw broker JSON, narrowed field by field */
type Raw = any;

// +5 vol points. Either direction can be worse: higher IV raises a near-the-money
// spread's value but LOWERS a deep in-the-money one, so the table shows both and the worse.
const IV_SHOCK = 0.05;
const r2 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const mid = (q: Raw): number | undefined =>
  q?.bid > 0 && q?.ask > 0 ? (q.bid + q.ask) / 2 : (q?.last ?? q?.close ?? undefined);
const isoExpiry = (e: string) => `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
/** `expiry` is ISO YYYY-MM-DD. */
const years = (expiry: string, asOf: Date) =>
  (Date.parse(`${expiry}T21:00:00Z`) - asOf.getTime()) / (365 * 86_400_000);

/** Split levels by the sign of the estimated P&L there. A null/NaN P&L goes to `unclassified`. */
export function sideCandidates<T extends { estPnlAtLevel: number | null | undefined }>(levels: T[]) {
  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  return {
    stopCandidates: levels.filter((c) => ok(c.estPnlAtLevel) && c.estPnlAtLevel < 0),
    takeProfitCandidates: levels.filter((c) => ok(c.estPnlAtLevel) && c.estPnlAtLevel > 0),
    unclassified: levels.filter((c) => !ok(c.estPnlAtLevel)),
  };
}

/** Levels shared by every underlying: daily technicals + a daily-bar volume profile. */
function technicals(bars: DailyBar[], spot: number, bucket: number) {
  const recent = bars.slice(-130);
  const sw = swings(recent, 3);
  const last = bars.at(-1);
  const prof = volumeProfile(
    bars.slice(-60).map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })),
    bucket,
  );
  return {
    lastBar: last ? { date: last.time, close: last.close, high: last.high, low: last.low } : null,
    sma20: r2(sma(bars, 20)), sma50: r2(sma(bars, 50)), sma200: r2(sma(bars, 200)),
    atr14: r2(atr(bars, 14)),
    high52w: r2(Math.max(...bars.map((b) => b.high))), low52w: r2(Math.min(...bars.map((b) => b.low))),
    swingLowsBelow: sw.lows.filter((b) => b.low < spot).slice(-4).map((b) => ({ date: b.time, low: b.low })),
    swingHighsAbove: sw.highs.filter((b) => b.high > spot).slice(-4).map((b) => ({ date: b.time, high: b.high })),
    volumeProfile60d: prof && (bars.slice(-60).some((b) => (b.volume ?? 0) > 0)
      ? { poc: r2(prof.poc), vah: r2(prof.vah), val: r2(prof.val), bucket, basis: "daily bars, volume spread over each bar's range" }
      : null),
  };
}

export function analyse(raw: Raw, asOf: Date) {
  const ib = raw.ib ?? {};
  const errors = { ...raw.errors, ...(ib.errors ?? {}) };
  const quotes = new Map<number, Raw>((ib.quotes ?? []).map((q: Raw) => [q.conId, q]));
  const uq = new Map<string, Raw>((ib.underlying_quotes ?? []).map((q: Raw) => [q.symbol, q]));
  // A daily bar dated after the run's UTC date is a partial / pre-open print
  // (seen: TSE 6981 "2026-11-09" on Sunday 2026-11-08 UTC); levels use completed bars only.
  const today = asOf.toISOString().slice(0, 10);
  const partial: string[] = [];
  const hist: Record<string, DailyBar[]> = Object.fromEntries(
    Object.entries((ib.history ?? {}) as Record<string, DailyBar[]>).map(([k, bars]) => {
      if (k.endsWith("_30m")) return [k, bars];
      const kept = bars.filter((b) => b.time.slice(0, 10) <= today);
      if (kept.length < bars.length) partial.push(`${k} ${bars.at(-1)!.time}`);
      return [k, kept];
    }),
  );

  // ---------- IB account ----------
  const acct = (ib.positions ?? [])[0]?.account as string | undefined;
  const sum = (tag: string) => Number(ib.account_summary?.[`${acct}:${tag}`]);
  const nlv = sum("NetLiquidation");
  const el = sum("ExcessLiquidity");

  // ---------- SPX book (the VRP short put spreads) ----------
  const spxBars = hist.SPX ?? [];
  const spxQuote = (ib.quotes ?? []).find((q: Raw) => q.symbol === "SPX" && q.secType === "IND");
  const spxClose = spxBars.at(-1)?.close;
  const spot = spxClose ?? spxQuote?.last;
  const spxLegs = (ib.positions ?? []).filter((p: Raw) => p.symbol === "SPX" && p.secType === "OPT");
  const byExpiry = new Map<string, Raw[]>();
  for (const p of spxLegs) byExpiry.set(p.expiry, [...(byExpiry.get(p.expiry) ?? []), p]);
  const spreads: Raw[] = [];
  for (const [expiry, legs] of [...byExpiry].sort()) {
    // ponytail: pairing assumption — within one expiry, highest short pairs with
    // highest long. Correct for the stacked verticals here; a broker combo id would be exact.
    const shorts = legs.filter((l) => l.position < 0).sort((a, b) => b.strike - a.strike);
    const longs = legs.filter((l) => l.position > 0).sort((a, b) => b.strike - a.strike);
    shorts.forEach((s, i) => {
      const l = longs[i];
      if (!l) return;
      const qty = Math.abs(s.position);
      const qs = quotes.get(s.conId);
      const ql = quotes.get(l.conId);
      const credit = (s.avgCost - l.avgCost) * qty; // IB avgCost is per contract, multiplier included
      const markPts = (mid(qs) ?? NaN) - (mid(ql) ?? NaN);
      const legsModel: Leg[] = [
        { right: "P", strike: s.strike, expiry: isoExpiry(expiry), qty: -qty, iv: qs?.iv ?? NaN },
        { right: "P", strike: l.strike, expiry: isoExpiry(expiry), qty, iv: ql?.iv ?? NaN },
      ];
      spreads.push({
        id: `SPX ${isoExpiry(expiry)} ${s.strike}/${l.strike}P x${qty}`,
        expiry: isoExpiry(expiry), short: s.strike, long: l.strike, qty,
        width: (s.strike - l.strike) * 100 * qty,
        credit: r2(credit),
        breakeven: r2(s.strike - credit / (100 * qty)),
        markPoints: r2(markPts), markValue: r2(markPts * 100 * qty),
        unrealized: r2(credit - markPts * 100 * qty),
        maxLoss: r2((s.strike - l.strike) * 100 * qty - credit),
        shortIv: r2((qs?.iv ?? NaN) * 100), longIv: r2((ql?.iv ?? NaN) * 100),
        quoteTime: qs?.time ?? null,
        shortStrikeVsSpot: spot === undefined ? null : r2(spot - s.strike),
        legs: legsModel,
      });
    });
  }
  const allLegs: Leg[] = spreads.flatMap((s) => s.legs);
  const ivOk = allLegs.every((l) => Number.isFinite(l.iv));

  // Technical + volume-profile + summer-low candidates for SPX stops.
  const spxTech = spot === undefined ? null : technicals(spxBars, spot, 10);
  const summer = spxBars.filter((b) => b.time >= "2026-07-01" && b.time <= "2026-08-31");
  const summerLow = summer.length ? summer.reduce((m, b) => (b.low < m.low ? b : m)) : undefined;
  // ES 30m volume profile (23h session, has volume) mapped to SPX by the close-to-close ratio.
  const es: MinuteBar[] = (hist.ES_30m ?? []) as MinuteBar[];
  const lastDay = spxBars.at(-1)?.time;
  const esAtClose = es.find((b) => lastDay !== undefined && b.time.startsWith(`${lastDay} 20:30`));
  const ratio = spxClose !== undefined && esAtClose ? spxClose / esAtClose.close : undefined;
  const esProf = volumeProfile(es, 5);
  const mapEs = (x: number) => r2(ratio === undefined ? NaN : x * ratio);
  const esVp = esProf && ratio !== undefined && spot !== undefined
    ? {
        basis: "ES 30-min bars, 20 sessions incl. overnight, 5-pt buckets, mapped to SPX by SPX/ES close ratio",
        ratio: Math.round(ratio * 1e5) / 1e5,
        poc: mapEs(esProf.poc), vah: mapEs(esProf.vah), val: mapEs(esProf.val),
        hvnBelowSpot: esProf.hvn.map(mapEs).filter((x): x is number => x !== null && x < spot).slice(-5),
        lvnBelowSpot: esProf.lvn.map(mapEs).filter((x): x is number => x !== null && x < spot).slice(-5),
      }
    : null;

  const candidates: Array<{ id: string; level: number; source: string }> = [];
  const add = (id: string, level: number | null | undefined, source: string) => {
    if (level !== null && level !== undefined && Number.isFinite(level) && spot !== undefined && level < spot)
      candidates.push({ id, level: r2(level)!, source });
  };
  if (spxTech) {
    add("sma50", spxTech.sma50, "SPX 50-day simple moving average of IB daily closes");
    add("sma200", spxTech.sma200, "SPX 200-day simple moving average of IB daily closes");
    spxTech.swingLowsBelow.forEach((s, i) => add(`swing_low_${i + 1}`, s.low, `SPX swing low on ${s.date}: that day's low is the lowest of the 3 trading days on each side (last 130 IB daily bars)`));
    if (spxTech.atr14 !== null && spot !== undefined) {
      add("atr1", spot - spxTech.atr14, "SPX last close minus 1x ATR14 (14-day Wilder average true range)");
      add("atr2", spot - 2 * spxTech.atr14, "SPX last close minus 2x ATR14 (14-day Wilder average true range)");
    }
  }
  if (summerLow) add("summer_low", summerLow.low, `lowest SPX daily low between 2026-07-01 and 2026-08-31 (on ${summerLow.time})`);
  if (esVp) {
    add("vp_val", esVp.val, "value-area low (bottom of the price range holding 70% of volume) of ES futures over 20 sessions of 30-min bars, mapped to SPX");
    add("vp_poc", esVp.poc, "point of control (price with the most volume) of ES futures over 20 sessions of 30-min bars, mapped to SPX");
    esVp.lvnBelowSpot.forEach((x, i) => add(`vp_lvn_${i + 1}`, x, "low-volume node of ES futures over 20 sessions of 30-min bars, mapped to SPX (price moves fast through thin volume)"));
  }
  spreads.forEach((s) => add(`long_strike_${s.long}`, s.long, `long put strike of ${s.id}: below it the spread is at max loss`));
  candidates.sort((a, b) => b.level - a.level);

  // The cushion-zero level is itself a candidate: a stop below it exits with a negative cushion.
  const czEarly = ivOk && spot !== undefined
    ? Math.max(spotWhereLossReaches(allLegs, spot, el, asOf, Math.min(...spreads.map((s) => s.long)) - 200, 0) ?? -Infinity,
        spotWhereLossReaches(allLegs, spot, el, asOf, Math.min(...spreads.map((s) => s.long)) - 200, IV_SHOCK) ?? -Infinity)
    : undefined;
  if (czEarly !== undefined && Number.isFinite(czEarly)) add("cushion_zero", czEarly, "SPX level where the estimated IB ExcessLiquidity reaches 0 (Black-Scholes repricing of the spreads, worse of flat IV / IV+5)");
  candidates.sort((a, b) => b.level - a.level);
  const baseValue = ivOk && spot !== undefined ? legsValue(allLegs, spot, asOf) : NaN;
  const lossAt = (level: number, shift: number) => ivOk ? baseValue - legsValue(allLegs, level, asOf, shift) : NaN;
  const perSpreadLoss = (s: Raw, level: number, shift: number) =>
    legsValue(s.legs, spot!, asOf) - legsValue(s.legs, level, asOf, shift);
  const stopTable = candidates.map((c) => ({
    ...c,
    distancePct: spot === undefined ? null : r2(((c.level - spot) / spot) * 100),
    estAddedLossFlatIv: r2(lossAt(c.level, 0)),
    estAddedLossIvPlus5: r2(lossAt(c.level, IV_SHOCK)),
    estAddedLossWorse: r2(Math.max(lossAt(c.level, 0), lossAt(c.level, IV_SHOCK))),
    cushionAfterFlatIv: r2(el - lossAt(c.level, 0)),
    cushionAfterIvPlus5: r2(el - lossAt(c.level, IV_SHOCK)),
    perSpread: spreads.map((s) => ({
      id: s.id,
      estAddedLossFlatIv: r2(ivOk ? perSpreadLoss(s, c.level, 0) : NaN),
      estTotalPnlVsCreditFlatIv: r2(ivOk ? s.credit - (legsValue(s.legs, c.level, asOf) * -1) : NaN),
    })),
  }));
  const floor = Math.min(...spreads.map((s) => s.long)) - 200;
  const cushionZero = ivOk && spot !== undefined
    ? {
        flatIv: r2(spotWhereLossReaches(allLegs, spot, el, asOf, floor, 0)),
        ivPlus5: r2(spotWhereLossReaches(allLegs, spot, el, asOf, floor, IV_SHOCK)),
        worse: r2(Math.max(spotWhereLossReaches(allLegs, spot, el, asOf, floor, 0) ?? -Infinity,
          spotWhereLossReaches(allLegs, spot, el, asOf, floor, IV_SHOCK) ?? -Infinity)),
        // Run 2 (2026-11-08) had the model subtract these itself; they are code's job.
        distanceFromCloseWorsePts: r2(spot - Math.max(spotWhereLossReaches(allLegs, spot, el, asOf, floor, 0) ?? -Infinity,
          spotWhereLossReaches(allLegs, spot, el, asOf, floor, IV_SHOCK) ?? -Infinity)),
        distanceFromCloseWorseAtr: spxTech?.atr14 ? r2((spot - Math.max(spotWhereLossReaches(allLegs, spot, el, asOf, floor, 0) ?? -Infinity,
          spotWhereLossReaches(allLegs, spot, el, asOf, floor, IV_SHOCK) ?? -Infinity)) / spxTech.atr14) : null,
        note: "SPX level where the estimated MTM loss on the SPX spreads equals today's ExcessLiquidity. Assumes the spreads' maintenance margin stays near their width and every other position is unchanged — an estimate, not IB's margin engine.",
      }
    : null;

  // ---------- everything else: stocks + long/short options, IB and Futu ----------
  const others: Raw[] = [];
  const pushOther = (p: Raw) => others.push(p);
  for (const p of ib.positions ?? []) {
    if (p.symbol === "SPX" || p.secType === "BILL") continue;
    const q = uq.get(p.symbol);
    pushOther({ broker: "IB", code: p.symbol, kind: "STK", underlying: p.symbol, qty: p.position,
      currency: p.currency, cost: r2(p.avgCost), price: r2(mid(q)), priceTime: q?.time ?? null });
  }
  const futu = (raw.futu?.accounts ?? []).flatMap((a: Raw) => (Array.isArray(a.positions) ? a.positions : []));
  for (const p of futu) {
    const m = /^US\.([A-Z.]+?)(?:(\d{2})(\d{2})(\d{2})([CP])(\d+))?$/.exec(p.code);
    if (!m) { pushOther({ broker: "Futu", code: p.code, kind: "unparsed", qty: p.qty }); continue; }
    const [, und, yy, mm, dd, right, k] = m;
    pushOther({
      broker: "Futu", code: p.code, kind: right ? "OPT" : "STK", underlying: und, qty: p.qty,
      currency: p.currency, cost: r2(p.cost_price), price: r2(p.nominal_price), marketValue: r2(p.market_val),
      plPct: r2(p.pl_ratio),
      ...(right ? { right, strike: Number(k) / 1000, expiry: `20${yy}-${mm}-${dd}` } : {}),
    });
  }
  const underlyings = [...new Set(others.map((o) => o.underlying).filter(Boolean))].sort();
  const perUnderlying = underlyings.map((u) => {
    const bars = hist[u] ?? [];
    const q = uq.get(u);
    const spotU = bars.at(-1)?.close;
    const tech = spotU === undefined ? null : technicals(bars, spotU, Math.max(0.5, Math.round(spotU / 200)));
    const pos = others.filter((o) => o.underlying === u);
    // Candidate stop (below) and take-profit (above) levels, both sides, from the technicals.
    const below = tech ? [
      ...tech.swingLowsBelow.map((s) => ({ id: `swing_low_${s.date}`, level: s.low, source: `swing low on ${s.date}: lowest low of the 3 trading days on each side (last 130 IB daily bars)` })),
      ...(tech.atr14 !== null ? [{ id: "atr2_down", level: r2(spotU! - 2 * tech.atr14)!, source: "last close minus 2x ATR14 (14-day Wilder average true range)" }] : []),
      ...(tech.sma50 !== null && tech.sma50 < spotU! ? [{ id: "sma50", level: tech.sma50, source: "50-day simple moving average of IB daily closes" }] : []),
      ...(tech.sma200 !== null && tech.sma200 < spotU! ? [{ id: "sma200", level: tech.sma200, source: "200-day simple moving average of IB daily closes" }] : []),
    ] : [];
    const above = tech ? [
      ...tech.swingHighsAbove.map((s) => ({ id: `swing_high_${s.date}`, level: s.high, source: `swing high on ${s.date}: highest high of the 3 trading days on each side (last 130 IB daily bars)` })),
      ...(tech.atr14 !== null ? [{ id: "atr2_up", level: r2(spotU! + 2 * tech.atr14)!, source: "last close plus 2x ATR14 (14-day Wilder average true range)" }] : []),
      ...(tech.sma50 !== null && tech.sma50 > spotU! ? [{ id: "sma50", level: tech.sma50, source: "50-day simple moving average of IB daily closes" }] : []),
      ...(tech.sma200 !== null && tech.sma200 > spotU! ? [{ id: "sma200", level: tech.sma200, source: "200-day simple moving average of IB daily closes" }] : []),
      { id: "high52w", level: tech.high52w!, source: "highest daily high of the last year of IB daily bars" },
    ] : [];
    const pnlAt = (level: number) => r2(pos.reduce((sum, o) => {
      if (o.kind === "STK") return sum + (level - spotU!) * o.qty;
      if (o.kind !== "OPT" || o.price === null) return NaN;
      const t = years(o.expiry, asOf);
      const iv = impliedVol(o.right, o.price, q?.last ?? spotU!, o.strike, t);
      if (iv === undefined) return NaN;
      return sum + (bs(o.right, level, o.strike, t, iv) - o.price) * 100 * o.qty;
    }, 0));
    return {
      underlying: u,
      lastClose: r2(spotU), afterHoursLast: r2(q?.last), quoteTime: q?.time ?? null,
      technicals: tech,
      positions: pos,
      // Code, not the model, decides which side is the stop: a level where the
      // estimated P&L is negative is a stop candidate, positive a take-profit one.
      // (Run 3 on 2026-11-08: given neutral below/above lists the model read a long
      // XLV put as short and swapped its stop and take-profit.)
      ...sideCandidates([...below, ...above].map((c) => ({
        ...c, side: c.level < spotU! ? "below" : "above", estPnlAtLevel: pnlAt(c.level),
      }))),
      dust: pos.every((o) => o.kind === "STK" && Math.abs(o.qty * (spotU ?? 0)) < 200),
      // A >20% close-to-close jump in 60 sessions is more likely a split the bar
      // feed did not adjust than a real move; levels from such bars are not usable.
      // A 52-week high more than 2.5x the low: check the bar series against the exchange before using it.
      checkPriceSeries: tech !== null && tech.low52w !== null && tech.high52w !== null && tech.high52w > 2.5 * tech.low52w,
      possibleCorporateAction: bars.slice(-60).some((b, i, xs) => i > 0 && Math.abs(b.close / xs[i - 1]!.close - 1) > 0.2),
      pnlNote: "P&L vs today's mark if the underlying is at the level now (options: Black-Scholes, IV backed out of today's mark, held flat). Same currency as the position.",
    };
  });

  // ---------- order coverage: does every position have a stop / take-profit order? ----------
  const ibOrders = ib.open_orders ?? [];
  const futuOrders = (raw.futu?.accounts ?? []).flatMap((a: Raw) => (Array.isArray(a.open_orders) ? a.open_orders : []));
  const coverage = {
    ibOpenOrders: ibOrders.length,
    futuOpenOrders: futuOrders.length,
    source: "IB reqAllOpenOrders (includes TWS/mobile orders) + Futu order_list_query, read-only",
    uncovered: [
      ...spreads.filter(() => !ibOrders.some((o: Raw) => o.symbol === "SPX")).map((s) => `IB ${s.id}: no stop order`),
      ...others.filter((o) => !(o.broker === "IB" ? ibOrders : futuOrders).some((x: Raw) => (x.symbol ?? x.code) === o.code))
        .map((o) => `${o.broker} ${o.code}: no stop or take-profit order`),
    ],
  };

  return {
    asOf: asOf.toISOString(),
    fetchedAt: { ib: ib.fetched_at ?? null, futu: raw.futu?.fetched_at ?? null },
    errors,
    droppedPartialBars: partial,
    gex: { status: "unavailable", reason: "Unusual Whales token rejected (401 unrecognized_token, checked 2026-11-08); argon walls not used (call_wall == put_wall bug)" },
    ibAccount: {
      account: acct ?? null, netLiquidation: r2(nlv), excessLiquidity: r2(el),
      cushionPct: r2((el / nlv) * 100),
      spxTotalWidth: r2(spreads.reduce((s, x) => s + x.width, 0)),
      spxWidthToNlv: r2(spreads.reduce((s, x) => s + x.width, 0) / nlv),
      spxCredit: r2(spreads.reduce((s, x) => s + x.credit, 0)),
      spxMaxLoss: r2(spreads.reduce((s, x) => s + x.maxLoss, 0)),
    },
    futuAccount: (raw.futu?.accounts ?? []).filter((a: Raw) => Array.isArray(a.positions) && a.positions.length)
      .map((a: Raw) => {
        const x = Array.isArray(a.account) ? a.account[0] : {};
        return { currency: x.currency, totalAssets: r2(x.total_assets), maintenanceMargin: r2(x.maintenance_margin),
          initialMargin: r2(x.initial_margin), cash: r2(x.cash), riskStatus: x.risk_status };
      }),
    spx: {
      lastClose: spxBars.at(-1) ? { date: spxBars.at(-1)!.time, close: spxClose } : null,
      frozenLast: r2(spxQuote?.last), vixLast: r2((ib.quotes ?? []).find((q: Raw) => q.symbol === "VIX")?.last),
      technicals: spxTech,
      summerLow: summerLow ? { date: summerLow.time, low: summerLow.low } : null,
      volumeProfile: esVp,
      spreads: spreads.map(({ legs: _legs, ...s }) => s),
      stopCandidates: stopTable,
      cushionZero,
      modelNote: "Losses are Black-Scholes repricings at the level, same instant, IB model IV per leg, flat and +5 vol points; `worse` is the larger loss (higher cushion-zero level). Est. added loss is vs today's mark; P&L vs credit adds the credit received.",
    },
    others: perUnderlying,
    orderCoverage: coverage,
  };
}
